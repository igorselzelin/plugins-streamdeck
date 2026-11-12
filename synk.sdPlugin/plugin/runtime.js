// Shared singletons for every SYNK action in this process: the host socket,
// the single SYNK connection, the state cache and the registry of keys on screen.

const { Plugins, log } = require('./utils/plugin');
const { Supervisor } = require('./synk/supervisor');
const { openSession } = require('./synk/transport');
const { SynkState } = require('./synk/state');
const { createApi } = require('./synk/api');
const { SynkError, LOCAL_CODES, toSynkError } = require('./synk/errors');
const { prepareArtwork } = require('./render');
const { KeyView, COLORS } = require('./keyview');
const { HostImages } = require('./hostImages');

const plugin = new Plugins();
const state = new SynkState();
const supervisor = new Supervisor({ openSession, log });

const IDLE_DISCONNECT_MS = 30000; // keep the connection across page switches
const PRESS_TIMEOUT_MS = 6000;    // hard cap on one key's work (PLAY_SOUND itself has 5 s)
const ERROR_FLASH_MS = 1800;

/**
 * context -> {
 *   uuid, coordinates, settings(),     identify the key (custom image lookup)
 *   render(custom), live(), soundId(), what to draw
 *   view: KeyView, custom, seq, error, errorTimer, busy, fx
 * }
 */
const keys = new Map();
let idleTimer = null;
let openInspector = null; // { context, refresh() } for the sound picker currently open, if any

const api = createApi({
    supervisor, state, log,
    visibleSoundIds: () => [...keys.values()].map(k => k.soundId()).filter(Boolean),
    onLibraryChanged: () => openInspector?.refresh()
});

supervisor.on('state', (s, err) => {
    log.info(`SYNK state: ${s}${err ? ` (${err.code})` : ''}`);
    state.setConnection(s, err);
    if (s === 'connected') api.syncAll().catch(e => log.warn('SYNK sync failed:', toSynkError(e).code));
    else openInspector?.refresh(); // tell an open picker that SYNK went away
});

supervisor.on('event', (name, data) => {
    try { api.handleEvent(name, data); }
    catch (e) { log.error(`SYNK event ${name} handling failed:`, e.message); }
});

// ---- user's custom key images (Rise Mode profiles, read-only) -------------

const hostImages = new HostImages({ log });
hostImages.prepare = prepareArtwork;
hostImages.scan();
hostImages.watch();
hostImages.on('change', () => {
    for (const context of keys.keys()) resolveCustom(context);
});

async function resolveCustom(context) {
    const key = keys.get(context);
    if (!key || !key.uuid) return;
    const file = hostImages.find({ uuid: key.uuid, coordinates: key.coordinates, settings: key.settings() });
    const custom = file ? await hostImages.load(file) : null;
    if (keys.get(context) !== key || custom === key.custom) return;
    key.custom = custom;
    refreshKey(context);
}

// ---- keys on screen -------------------------------------------------------

/**
 * @param {string} context
 * @param {object} spec
 * @param {(custom: string|null) => Promise<string>|null} spec.render  still image (base64 JPEG)
 * @param {() => object|null} [spec.live]       live effect while e.g. playing
 * @param {() => string|null} [spec.soundId]
 * @param {() => object} [spec.settings]
 * @param {string} [spec.uuid]
 * @param {{column:number,row:number}} [spec.coordinates]
 * @param {boolean} [spec.instant]              no dissolves (knob)
 */
function addKey(context, spec) {
    const existing = keys.get(context);
    if (existing) { clearTimeout(existing.errorTimer); existing.view.dispose(); }
    const view = new KeyView(b64 => plugin.setImage(context, `data:image/jpeg;base64,${b64}`), { instant: spec.instant });
    keys.set(context, {
        uuid: spec.uuid, coordinates: spec.coordinates,
        settings: spec.settings || (() => ({})),
        render: spec.render, live: spec.live || (() => null), soundId: spec.soundId || (() => null),
        view, custom: null, seq: 0, error: null, errorTimer: null, busy: false, fx: null
    });
    clearTimeout(idleTimer);
    idleTimer = null;
    supervisor.start();
    resolveCustom(context);
    refreshKey(context);
    soundChanged(context);
}

function removeKey(context) {
    const key = keys.get(context);
    if (key) { clearTimeout(key.errorTimer); key.view.dispose(); }
    keys.delete(context);
    if (openInspector?.context === context) openInspector = null;
    if (keys.size === 0 && !idleTimer) {
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (keys.size === 0) supervisor.stop();
        }, IDLE_DISCONNECT_MS);
    }
}

// A key's settings changed: fetch its sound summary if online, and re-match its custom image.
function soundChanged(context) {
    const id = keys.get(context)?.soundId();
    if (id && supervisor.connected) api.refreshSounds([id]).catch(() => {});
    resolveCustom(context);
}

function keyError(context) {
    return keys.get(context)?.error ?? null;
}

// Renders one key's still; a newer render for the same key supersedes an older one.
async function refreshKey(context) {
    const key = keys.get(context);
    if (!key) return;
    const seq = ++key.seq;
    try {
        const b64 = await key.render(key.custom);
        if (!b64 || keys.get(context) !== key || seq !== key.seq) return;
        key.view.setStill(b64, key.live());
    } catch (e) {
        log.error('render failed:', e.message);
    }
}

let refreshQueued = false;
function refreshAll() {
    if (refreshQueued) return;
    refreshQueued = true;
    setImmediate(() => {
        refreshQueued = false;
        for (const context of keys.keys()) refreshKey(context);
    });
}

state.on('change', refreshAll);

// ---- property inspector ---------------------------------------------------

function setOpenInspector(context, refresh) {
    openInspector = { context, refresh };
}

function clearOpenInspector(context) {
    if (openInspector?.context === context) openInspector = null;
}

// ---- presses ----------------------------------------------------------------

// Key feedback, contract section 11.
const ERROR_TEXT = {
    OFFLINE: 'SYNK offline',
    NOT_RUNNING: 'SYNK fechado',
    DISCONNECTED: 'SYNK offline',
    TIMEOUT: 'Sem resposta',
    INVALID_SOUND: 'Escolha um som',
    NOT_FOUND: 'Som removido',
    UNAVAILABLE: 'Sem áudio',
    INTEGRITY_FAILED: 'Arquivo alterado',
    INVALID_PARAMS: 'Config inválida',
    UNKNOWN_COMMAND: 'Indisponível',
    NOT_IMPLEMENTED: 'Indisponível',
    BUSY: 'Ocupado'
};

function errorText(err) {
    return ERROR_TEXT[toSynkError(err).code] ?? 'Erro';
}

// Error label on the key for a moment, with a shake.
async function flashError(context, err) {
    const key = keys.get(context);
    if (!key) return;
    const e = toSynkError(err);
    log.warn(`key ${context.slice(0, 8)}: ${e.code}`);
    clearTimeout(key.errorTimer);
    key.error = errorText(e);
    await refreshKey(context);
    if (keys.get(context) === key) key.view.shake();
    key.errorTimer = setTimeout(() => {
        key.error = null;
        refreshKey(context);
    }, ERROR_FLASH_MS);
}

// Runs one key's work. While it is in flight further presses of the SAME key are
// ignored; other keys are unaffected. A hard timeout always releases the key.
// Never retried: a PLAY_SOUND or toggle may already have happened (contract section 5).
async function runExclusive(context, fn) {
    const key = keys.get(context);
    if (!key) return;
    if (key.busy) { log.info(`key ${context.slice(0, 8)} busy, press ignored`); return; }
    key.busy = true;
    let timer;
    try {
        await Promise.race([
            fn(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new SynkError(LOCAL_CODES.TIMEOUT, 'press timed out')), PRESS_TIMEOUT_MS); })
        ]);
    } catch (err) {
        flashError(context, err);
    } finally {
        clearTimeout(timer);
        key.busy = false;
    }
}

/**
 * Key handlers. The command fires on keyDown (lowest latency for a soundboard) while the
 * key sinks; keyUp springs it back with a ripple/glyph from `feedback(data)`, chosen at
 * press time. If the host only delivers keyUp for some key, it does both — never twice.
 * @param {(data) => Promise} fn
 * @param {(data) => {glyph?: 'play'|'stop', color?: number[]}} [feedback]
 * @param {{down: string, up: string}} [events]  host event names (knob: dialDown/dialUp;
 *        if dialUp never comes, the key view releases itself after a moment)
 */
function onPress(fn, feedback = () => ({}), events = { down: 'keyDown', up: 'keyUp' }) {
    const downSeen = new Set();
    const handlers = {
        keyDown(data) {
            const key = keys.get(data.context);
            if (!key) return;
            downSeen.add(data.context);
            key.fx = feedback(data);
            key.view.pressIn();
            return runExclusive(data.context, () => fn(data));
        },
        keyUp(data) {
            const key = keys.get(data.context);
            if (!key) return;
            if (downSeen.delete(data.context)) {
                key.view.release(key.fx || {});
                return;
            }
            key.fx = feedback(data);
            key.view.release(key.fx);
            return runExclusive(data.context, () => fn(data));
        }
    };
    return { [events.down]: handlers.keyDown, [events.up]: handlers.keyUp };
}

// ---- artwork ------------------------------------------------------------------

// Key-sized artwork, cached by sound id + updated_at_ms (the engine does not resize).
const artwork = new Map(); // `${id}|${updatedAt}` -> base64 JPEG 126x126 | null
const artworkInflight = new Set();
const ARTWORK_MAX = 64;

function artworkFor(soundId) {
    const info = soundId ? state.sounds.get(soundId) : null;
    if (!info || !info.hasArtwork) return null;
    const cacheKey = `${soundId}|${info.updatedAt}`;
    if (artwork.has(cacheKey)) return artwork.get(cacheKey);
    if (supervisor.connected && !artworkInflight.has(cacheKey)) {
        artworkInflight.add(cacheKey);
        api.getArtwork(soundId)
            .then(dataUrl => (dataUrl ? prepareArtwork(dataUrl) : null))
            .then(small => {
                artwork.set(cacheKey, small);
                if (artwork.size > ARTWORK_MAX) artwork.delete(artwork.keys().next().value);
                refreshAll();
            })
            .catch(e => {
                const code = toSynkError(e).code;
                log.warn('artwork failed:', code);
                // Transient: retried on a later render. Anything else (corrupt image...): fall back to a color.
                if (!['OFFLINE', 'DISCONNECTED', 'TIMEOUT', 'BUSY'].includes(code)) artwork.set(cacheKey, null);
            })
            .finally(() => artworkInflight.delete(cacheKey));
    }
    return null;
}

module.exports = {
    plugin, log, state, supervisor, api, COLORS,
    addKey, removeKey, refreshKey, refreshAll, keyError, flashError, runExclusive, onPress, soundChanged,
    setOpenInspector, clearOpenInspector, artworkFor, errorText
};
