// Button images for the Rise Mode Vision 01 Sound (126x126 px keys).
//
// Text is baked into the image with the bitmap font embedded in fontData.js
// (same approach as claude-usage.sdPlugin: the host doesn't reliably honor the
// manifest FontSize, and ncc breaks font files loaded from disk). The font is
// 32 px Open Sans covering Latin-1, so Portuguese accents work; anything
// outside Latin-1 is shown as '?'. Text is drawn at 2x and scaled down.

const Jimp = require('jimp');
const parseBmfontXml = require('parse-bmfont-xml');
const fontData = require('./fontData');

const SIZE = 126;
const BORDER = 6;

const COLORS = {
    bg: 0x1c1c1eff,
    white: 0xffffffff,
    playing: 0x2ecc71ff,
    offline: 0xc0392bff,
    pending: 0xd68910ff,
    error: 0xe74c3cff,
    muted: 0xe74c3cff,
    dim: 0x8e8e93ff,
    labelBand: 0x000000b4
};

// Muted palette for sounds without artwork, picked by a hash of the sound ID.
const PALETTE = [0x34495eff, 0x6c3483ff, 0x1a5276ff, 0x117864ff, 0x7e5109ff, 0x922b21ff, 0x2e4053ff, 0x4a235aff];

let fontPromise = null;
function loadFont() {
    if (!fontPromise) {
        fontPromise = (async () => {
            const raw = parseBmfontXml(fontData.xml);
            const chars = {};
            for (const c of raw.chars) chars[String.fromCharCode(c.id)] = c;
            const kernings = {};
            for (const k of raw.kernings) {
                const first = String.fromCharCode(k.first);
                kernings[first] = kernings[first] || {};
                kernings[first][String.fromCharCode(k.second)] = k.amount;
            }
            const pageImage = await Jimp.read(Buffer.from(fontData.pngBase64, 'base64'));
            return { chars, kernings, pages: [pageImage], common: raw.common, info: raw.info };
        })();
    }
    return fontPromise;
}

function sanitize(font, text) {
    return Array.from(String(text ?? '')).map(ch => (font.chars[ch] ? ch : '?')).join('');
}

// Greedy word wrap to at most `maxLines`, ellipsizing the last line. Widths are in font (2x) pixels.
function wrap(font, text, maxWidth, maxLines) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    const fits = s => Jimp.measureText(font, s) <= maxWidth;
    const pushHard = (word) => {
        // A single word longer than a line gets cut character by character.
        let chunk = '';
        for (const ch of word) {
            if (fits(chunk + ch)) chunk += ch;
            else { lines.push(chunk); chunk = ch; }
        }
        return chunk;
    };
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (fits(candidate)) { current = candidate; continue; }
        if (current) lines.push(current);
        current = fits(word) ? word : pushHard(word);
    }
    if (current) lines.push(current);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && !fits(`${last}...`)) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}...`;
    return kept;
}

// Draws centered text inside the box (x, y, w, h). `scale` 0.5 = 16 px text.
async function drawText(img, text, { x = 0, y = 0, w = SIZE, h = SIZE, scale = 0.5, maxLines = 2 } = {}) {
    if (!text) return;
    const font = await loadFont();
    const clean = sanitize(font, text);
    const lines = wrap(font, clean, Math.floor(w / scale), maxLines);
    const lineH = font.common.lineHeight;
    const layer = new Jimp(Math.ceil(w / scale), lineH * lines.length, 0x00000000);
    lines.forEach((line, i) => {
        const lw = Jimp.measureText(font, line);
        layer.print(font, Math.floor((layer.bitmap.width - lw) / 2), i * lineH, line);
    });
    layer.scale(scale);
    img.composite(layer, x + Math.floor((w - layer.bitmap.width) / 2), y + Math.floor((h - layer.bitmap.height) / 2));
}

function rgba(color) {
    return [(color >>> 24) & 0xff, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff];
}

// Alpha-blended fill of any shape described by `inside(x, y)` within a bounding box.
function fillShape(img, x0, y0, w, h, color, inside) {
    const [r, g, b, a] = rgba(color);
    const alpha = a / 255;
    img.scan(Math.max(0, x0), Math.max(0, y0), Math.min(w, SIZE - x0), Math.min(h, SIZE - y0), function (x, y, idx) {
        if (inside && !inside(x, y)) return;
        const d = this.bitmap.data;
        d[idx] = Math.round(r * alpha + d[idx] * (1 - alpha));
        d[idx + 1] = Math.round(g * alpha + d[idx + 1] * (1 - alpha));
        d[idx + 2] = Math.round(b * alpha + d[idx + 2] * (1 - alpha));
        d[idx + 3] = 0xff;
    });
}

const fillRect = (img, x, y, w, h, color) => fillShape(img, x, y, w, h, color);

function fillCircle(img, cx, cy, r, color) {
    fillShape(img, cx - r, cy - r, 2 * r + 1, 2 * r + 1, color, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
}

// Triangle pointing right (play glyph) inside the box.
function fillPlay(img, x, y, size, color) {
    fillShape(img, x, y, size, size, color, (px, py) => {
        const t = (px - x) / size;
        const half = (size / 2) * (1 - t);
        return Math.abs(py - (y + size / 2)) <= half;
    });
}

function border(img, color, width = BORDER) {
    fillRect(img, 0, 0, SIZE, width, color);
    fillRect(img, 0, SIZE - width, SIZE, width, color);
    fillRect(img, 0, 0, width, SIZE, color);
    fillRect(img, SIZE - width, 0, width, SIZE, color);
}

function speaker(img, cx, cy, color) {
    fillRect(img, cx - 22, cy - 9, 14, 18, color);
    fillShape(img, cx - 8, cy - 22, 22, 44, color, (px, py) => {
        const t = (px - (cx - 8)) / 22; // 0 at the box's left edge, widening to the right
        return Math.abs(py - cy) <= 9 + 13 * t;
    });
}

function cross(img, cx, cy, r, color, thickness = 4) {
    fillShape(img, cx - r, cy - r, 2 * r + 1, 2 * r + 1, color, (x, y) =>
        Math.abs((x - cx) - (y - cy)) <= thickness || Math.abs((x - cx) + (y - cy)) <= thickness);
}

function hashIndex(str, n) {
    let h = 0;
    for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % n;
}

async function toBase64(img) {
    return (await img.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
}

// Downscales an image (engine artwork as data URL/base64, or a custom image file Buffer)
// once to a key-sized JPEG. Transparency is flattened onto black.
async function prepareArtwork(input) {
    const buf = Buffer.isBuffer(input)
        ? input
        : Buffer.from(String(input).replace(/^data:image\/(?:jpeg|png);base64,/, ''), 'base64');
    const img = (await Jimp.read(buf)).cover(SIZE, SIZE);
    const flat = new Jimp(SIZE, SIZE, 0x000000ff).composite(img, 0, 0);
    return toBase64(flat);
}

async function readBase(b64) {
    try {
        const img = await Jimp.read(Buffer.from(b64, 'base64'));
        if (img.bitmap.width !== SIZE || img.bitmap.height !== SIZE) img.cover(SIZE, SIZE);
        return img;
    } catch {
        return null; // unreadable: caller falls back to its own look
    }
}

// Grays out the key and puts a colored banner with `text` across the top.
async function overlayBanner(img, color, text) {
    img.greyscale().brightness(-0.45);
    fillRect(img, 0, 0, SIZE, 30, color);
    await drawText(img, text, { x: 0, y: 0, w: SIZE, h: 30, scale: 0.45, maxLines: 1 });
}

// Connection overlay shared by every key (nothing when connected).
async function applyConnection(img, connection, errorCode) {
    if (connection === 'connected') return;
    if (connection === 'connecting') return overlayBanner(img, COLORS.pending, 'CONECTANDO');
    if (errorCode === 'VERSION_MISMATCH') return overlayBanner(img, COLORS.pending, 'ATUALIZE');
    return overlayBanner(img, COLORS.offline, 'OFFLINE');
}

async function applyError(img, errorText) {
    if (!errorText) return;
    border(img, COLORS.error);
    fillRect(img, BORDER, BORDER, SIZE - 2 * BORDER, 28, COLORS.error);
    await drawText(img, errorText, { x: BORDER, y: BORDER, w: SIZE - 2 * BORDER, h: 28, scale: 0.42, maxLines: 1 });
}

// Round counter in the top-right corner.
async function badge(img, text, color) {
    fillCircle(img, 104, 22, 17, 0x000000c0);
    fillCircle(img, 104, 22, 15, color);
    await drawText(img, text, { x: 104 - 15, y: 22 - 15, w: 30, h: 30, scale: 0.5, maxLines: 1 });
}

const pct = v => `${Math.round(v * 100)}%`;

/**
 * Sound key (Play, Toggle, Stop actions). No text label: titles are the host's
 * (Rise Mode's title field). "Playing" is drawn live by keyview.js (glow + progress).
 * @param {object} o
 * @param {'play'|'toggle'|'stop'} o.variant
 * @param {string|null} o.soundId
 * @param {string|null} o.custom     the user's own key image (key-sized base64) — wins over everything
 * @param {string|null} o.artwork    key-sized SYNK artwork (base64) or null
 * @param {boolean} o.playing
 * @param {boolean} o.missing        the engine says the sound was deleted
 * @param {string} o.connection      supervisor state
 * @param {string|null} o.errorCode  supervisor error code while not connected
 * @param {string|null} o.error      short error text to flash, or null
 */
async function renderSound(o) {
    let img = o.custom ? await readBase(o.custom) : null;
    const custom = !!img;
    if (!img && !o.soundId) {
        img = new Jimp(SIZE, SIZE, COLORS.bg);
        await drawText(img, 'Escolher som', { scale: 0.55 });
        await applyConnection(img, o.connection, o.errorCode);
        return toBase64(img);
    }
    if (!img && o.artwork) img = await readBase(o.artwork);
    const art = !custom && !!img;
    if (!img) img = new Jimp(SIZE, SIZE, PALETTE[hashIndex(o.soundId || 'x', PALETTE.length)]);

    if (!custom) {
        if (o.variant === 'stop') {
            img.brightness(-0.35);
            fillRect(img, 41, 41, 44, 44, o.playing ? COLORS.white : COLORS.dim);
        } else if (o.variant === 'toggle') {
            if (o.playing) fillRect(img, 43, 43, 40, 40, COLORS.white);
            else fillPlay(img, 44, 41, 44, COLORS.white);
        } else if (!art) {
            fillPlay(img, 44, 41, 44, 0xffffffb0);
        }
    }

    if (o.connection !== 'connected') await applyConnection(img, o.connection, o.errorCode);
    else if (o.missing) await overlayBanner(img, COLORS.error, 'Som removido');
    await applyError(img, o.error);
    return toBase64(img);
}

async function renderStopAll({ custom, playingCount, connection, errorCode, error }) {
    const active = connection === 'connected' && playingCount > 0;
    let img = custom ? await readBase(custom) : null;
    if (!img) {
        img = new Jimp(SIZE, SIZE, active ? 0x7b241cff : COLORS.bg);
        fillRect(img, 39, 39, 48, 48, COLORS.white);
    }
    if (active) await badge(img, String(Math.min(playingCount, 99)), COLORS.error);
    await applyConnection(img, connection, errorCode);
    await applyError(img, error);
    return toBase64(img);
}

// Mute key: speaker, or the user's image; muted = red X (and darker custom image).
async function renderMute({ custom, muted, supported, connection, errorCode, error }) {
    let img = custom ? await readBase(custom) : null;
    if (img) {
        if (muted) {
            img.brightness(-0.45);
            cross(img, 63, 63, 26, COLORS.muted, 6);
        }
    } else {
        img = new Jimp(SIZE, SIZE, muted ? 0x641e16ff : COLORS.bg);
        speaker(img, 55, 63, COLORS.white);
        if (muted) cross(img, 92, 63, 13, COLORS.muted);
        else {
            fillShape(img, 72, 43, 34, 40, COLORS.white, (x, y) => {
                const r = Math.sqrt((x - 66) ** 2 + (y - 63) ** 2);
                return (r >= 12 && r <= 16) || (r >= 22 && r <= 26);
            });
        }
    }
    if (connection !== 'connected') await applyConnection(img, connection, errorCode);
    else if (supported === false) await overlayBanner(img, COLORS.pending, 'Indisponível');
    await applyError(img, error);
    return toBase64(img);
}

// Knob image: effects volume 0-200 % (the white mark is 100 %).
async function renderVolume({ volume, muted, connection, errorCode, error }) {
    const img = new Jimp(SIZE, SIZE, COLORS.bg);
    const x0 = 13, w = 100, y0 = 62, h = 16;
    fillRect(img, x0, y0, w, h, 0x3a3a3eff);
    if (volume !== null && volume !== undefined) {
        const fill = Math.round(Math.min(2, Math.max(0, volume)) / 2 * w);
        fillRect(img, x0, y0, fill, h, muted ? COLORS.dim : volume > 1 ? COLORS.pending : COLORS.playing);
    }
    fillRect(img, x0 + w / 2 - 1, y0 - 4, 2, h + 8, COLORS.white);
    const text = volume === null || volume === undefined ? '--' : pct(volume);
    await drawText(img, text, { x: 0, y: 14, w: SIZE, h: 40, scale: 0.75, maxLines: 1 });
    if (muted) await drawText(img, 'Mudo', { x: 0, y: 86, w: SIZE, h: 30, scale: 0.45, maxLines: 1 });
    await applyConnection(img, connection, errorCode);
    await applyError(img, error);
    return toBase64(img);
}

function statusText({ connection, errorCode, playingCount, audioState, engineVersion }) {
    if (connection === 'connecting') return ['Conectando', COLORS.pending];
    if (connection !== 'connected') {
        if (errorCode === 'VERSION_MISMATCH') return ['Atualize SYNK/plugin', COLORS.pending];
        if (errorCode === 'NOT_RUNNING') return ['SYNK fechado', COLORS.offline];
        return ['Offline', COLORS.offline];
    }
    if (audioState && audioState !== 'running' && audioState !== 'not_initialized') return ['Sem áudio', COLORS.pending];
    if (playingCount > 0) return [`${playingCount} tocando`, COLORS.playing];
    return [engineVersion ? `Conectado v${engineVersion}` : 'Conectado', COLORS.playing];
}

// Status key: the indicator itself is the content, so its short state text stays.
// With a custom image, the state is a colored dot in the corner.
async function renderStatus(o) {
    const [text, color] = statusText(o);
    let img = o.custom ? await readBase(o.custom) : null;
    if (img) {
        fillCircle(img, 106, 20, 13, 0x000000c0);
        fillCircle(img, 106, 20, 10, color);
        return toBase64(img);
    }
    img = new Jimp(SIZE, SIZE, COLORS.bg);
    fillCircle(img, 63, 40, 22, color);
    await drawText(img, 'SYNK', { x: 0, y: 26, w: SIZE, h: 28, scale: 0.45, maxLines: 1 });
    await drawText(img, text, { x: 2, y: SIZE - 48, w: SIZE - 4, h: 46, scale: 0.42, maxLines: 2 });
    return toBase64(img);
}

// Small LRU so re-rendering an unchanged key is free.
const cache = new Map();
const CACHE_MAX = 200;
async function cached(key, fn) {
    if (cache.has(key)) {
        const v = cache.get(key);
        cache.delete(key);
        cache.set(key, v);
        return v;
    }
    const v = await fn();
    cache.set(key, v);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return v;
}

const imgKey = a => (a ? `${a.length}:${a.slice(-24)}` : '');

module.exports = {
    SIZE,
    prepareArtwork,
    renderSound: o => cached(`sound|${o.variant}|${o.soundId}|${imgKey(o.custom)}|${imgKey(o.artwork)}|${o.playing}|${o.missing}|${o.connection}|${o.errorCode}|${o.error}`, () => renderSound(o)),
    renderStopAll: o => cached(`stopall|${imgKey(o.custom)}|${o.playingCount}|${o.connection}|${o.errorCode}|${o.error}`, () => renderStopAll(o)),
    renderMute: o => cached(`mute|${imgKey(o.custom)}|${o.muted}|${o.supported}|${o.connection}|${o.errorCode}|${o.error}`, () => renderMute(o)),
    renderVolume: o => cached(`volume|${o.volume}|${o.muted}|${o.connection}|${o.errorCode}|${o.error}`, () => renderVolume(o)),
    renderStatus: o => cached(`status|${imgKey(o.custom)}|${o.connection}|${o.errorCode}|${o.playingCount}|${o.audioState}|${o.engineVersion}`, () => renderStatus(o))
};
