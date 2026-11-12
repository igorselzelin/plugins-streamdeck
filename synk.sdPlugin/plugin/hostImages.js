// Custom key images set by the user in the Rise Mode Controller.
//
// The host stores an uploaded image in the profile (Actions["col,row"].States[n].Image =
// "<name>.png", file in <profile>/Images/) but never tells the plugin about it, and a
// plugin setImage() replaces it on the key. So we look it up ourselves (READ-ONLY: the
// profiles are never written) and use it as the base of every frame we draw, so
// animations and indicators go on top of the user's image instead of erasing it.
//
// A key is matched by action UUID + coordinates, ties broken by the key's settings
// (soundId...) and then by the most recently saved profile. Images that are the action's
// default ("static/...") are not custom. The profiles folder is watched, so a new image
// shows up on the key right away.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ACTION_PREFIX = 'com.hotspot.streamdock.synk.';
const IMAGE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}\.(png|jpe?g|gif|bmp)$/i;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const RESCAN_DEBOUNCE_MS = 400;

function defaultRoot() {
    if (process.env.SYNK_PROFILES_DIR) return process.env.SYNK_PROFILES_DIR; // tests
    return process.env.APPDATA ? path.join(process.env.APPDATA, 'HotSpot', 'StreamDock', 'profiles') : null;
}

function safeReadJson(file) {
    try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
        return { json: JSON.parse(fs.readFileSync(file, 'utf8')), mtime: st.mtimeMs };
    } catch {
        return null; // missing, or caught mid-write by the host: keep the previous index
    }
}

function listProfileDirs(root) {
    const out = [];
    let top;
    try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const d of top) {
        if (!d.isDirectory() || !d.name.endsWith('.sdProfile')) continue;
        const dir = path.join(root, d.name);
        out.push(dir);
        // extra pages of a profile live in <profile>/profiles/<page>.sdProfile
        try {
            for (const p of fs.readdirSync(path.join(dir, 'profiles'), { withFileTypes: true })) {
                if (p.isDirectory() && p.name.endsWith('.sdProfile')) out.push(path.join(dir, 'profiles', p.name));
            }
        } catch { /* no extra pages */ }
    }
    return out;
}

function customImagePath(profileDir, action) {
    const states = Array.isArray(action.States) ? action.States : [];
    const state = states[Number.isInteger(action.State) ? action.State : 0] || states[0];
    const name = state && state.Image;
    if (typeof name !== 'string' || name.startsWith('static/') || !IMAGE_NAME.test(name)) return null;
    const imagesDir = path.join(profileDir, 'Images');
    const file = path.join(imagesDir, name);
    if (path.dirname(file) !== imagesDir) return null; // never leave the Images folder
    return file;
}

class HostImages extends EventEmitter {
    constructor({ root = defaultRoot(), log } = {}) {
        super();
        this.root = root;
        this.log = log;
        this.entries = [];
        this.cache = new Map(); // file -> { stamp, promise }
        this.watcher = null;
        this.timer = null;
        this.prepare = null;    // (Buffer) => Promise<base64 JPEG 126x126>, injected (render.prepareArtwork)
    }

    scan() {
        if (!this.root) return;
        const entries = [];
        for (const dir of listProfileDirs(this.root)) {
            const m = safeReadJson(path.join(dir, 'manifest.json'));
            if (!m || !m.json || typeof m.json.Actions !== 'object' || !m.json.Actions) continue;
            for (const [coords, action] of Object.entries(m.json.Actions)) {
                if (!action || typeof action.UUID !== 'string' || !action.UUID.startsWith(ACTION_PREFIX)) continue;
                entries.push({
                    uuid: action.UUID,
                    coords,
                    settings: action.Settings && typeof action.Settings === 'object' ? action.Settings : {},
                    image: customImagePath(dir, action),
                    mtime: m.mtime
                });
            }
        }
        this.entries = entries;
    }

    /** Path of the user's image for this key, or null (use the plugin's own look). */
    find({ uuid, coordinates, settings = {} }) {
        if (!coordinates || !Number.isInteger(coordinates.column) || !Number.isInteger(coordinates.row)) return null;
        const coords = `${coordinates.column},${coordinates.row}`;
        let best = null, bestScore = -1;
        for (const e of this.entries) {
            if (e.uuid !== uuid || e.coords !== coords) continue;
            let score = 0;
            if (settings.soundId && e.settings.soundId === settings.soundId) score += 2;
            if (JSON.stringify(e.settings) === JSON.stringify(settings)) score += 1;
            if (score > bestScore || (score === bestScore && e.mtime > best.mtime)) { best = e; bestScore = score; }
        }
        return best ? best.image : null;
    }

    /** Key-sized JPEG (base64) of a custom image file, cached until the file changes. */
    load(file) {
        if (!file || !this.prepare) return Promise.resolve(null);
        let st;
        try { st = fs.statSync(file); } catch { return Promise.resolve(null); }
        if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return Promise.resolve(null);
        const stamp = `${st.size}:${st.mtimeMs}`;
        const hit = this.cache.get(file);
        if (hit && hit.stamp === stamp) return hit.promise;
        const promise = fs.promises.readFile(file)
            .then(buf => this.prepare(buf))
            .catch(err => { this.log?.warn(`custom image unreadable: ${path.basename(file)} (${err.message})`); return null; });
        this.cache.set(file, { stamp, promise });
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
        return promise;
    }

    /** Rescans on any change under the profiles folder; emits 'change' afterwards. */
    watch() {
        if (this.watcher || !this.root) return;
        try {
            this.watcher = fs.watch(this.root, { recursive: true }, () => this.scheduleRescan());
            this.watcher.on('error', err => { this.log?.warn(`profiles watch stopped: ${err.message}`); this.unwatch(); });
        } catch (err) {
            this.log?.warn(`cannot watch profiles: ${err.message}`);
        }
    }

    scheduleRescan() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.scan();
            this.emit('change');
        }, RESCAN_DEBOUNCE_MS);
    }

    unwatch() {
        clearTimeout(this.timer);
        try { this.watcher?.close(); } catch { /* already closed */ }
        this.watcher = null;
    }
}

module.exports = { HostImages, customImagePath, ACTION_PREFIX };
