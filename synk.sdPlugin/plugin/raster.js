// Fast per-frame renderer for the 126x126 key display.
//
// Same approach as spotify.sdPlugin/plugin/raster.js (proven at 30 fps on this device):
// every animation frame is composed straight on raw RGBA buffers and encoded with jpeg-js
// at q82 (~7 KB per frame). Jimp is only used to build the still images (render.js).
// Additions for SYNK: stop glyph, breathing glow border, progress bar and shake.

const jpeg = require('jpeg-js');

const SIZE = 126;
const PIXELS = SIZE * SIZE;
const BYTES = PIXELS * 4;
const CENTER = SIZE / 2;
const JPEG_QUALITY = 82;

// Distance of every pixel center to the key center (ripple, glyph disc)
const DIST = new Float32Array(PIXELS);
// Distance of every pixel center to the nearest key edge (glow border)
const EDGE = new Float32Array(PIXELS);
for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        DIST[y * SIZE + x] = Math.hypot(x + 0.5 - CENTER, y + 0.5 - CENTER);
        EDGE[y * SIZE + x] = Math.min(x + 0.5, y + 0.5, SIZE - 0.5 - x, SIZE - 0.5 - y);
    }
}

function newRaster() {
    return Buffer.alloc(BYTES);
}

function decodeJpeg(base64) {
    const img = jpeg.decode(Buffer.from(base64, 'base64'), { useTArray: false, formatAsRGBA: true });
    if (img.width !== SIZE || img.height !== SIZE) throw new Error(`still is ${img.width}x${img.height}`);
    return Buffer.from(img.data);
}

function encodeJpeg(raster) {
    return jpeg.encode({ data: raster, width: SIZE, height: SIZE }, JPEG_QUALITY).data.toString('base64');
}

// Draws `src` into `out`, scaled toward the center (black around it), optionally dimmed,
// shifted horizontally by `dx` px (shake).
//   scale — 1 = full key;  dim — 0 = untouched, 1 = black
function drawCover(src, out, { scale = 1, dim = 0, dx = 0 } = {}) {
    const inv = 1 / scale;
    const keep = 1 - dim;
    const max = SIZE - 1;
    for (let y = 0; y < SIZE; y++) {
        const sy = (y + 0.5 - CENTER) * inv + CENTER - 0.5;
        const cy = Math.min(1, Math.max(0, Math.min(sy + 0.5, SIZE - 0.5 - sy) * scale + 0.5));
        const y0 = Math.max(0, Math.min(max, Math.floor(sy)));
        const y1 = Math.min(max, y0 + 1);
        const fy = Math.max(0, Math.min(1, sy - y0));
        for (let x = 0; x < SIZE; x++) {
            const o = (y * SIZE + x) * 4;
            const sx = (x - dx + 0.5 - CENTER) * inv + CENTER - 0.5;
            const cx = Math.min(1, Math.max(0, Math.min(sx + 0.5, SIZE - 0.5 - sx) * scale + 0.5));
            const cov = cx * cy;
            if (cov <= 0) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = 255; continue; }
            const x0 = Math.max(0, Math.min(max, Math.floor(sx)));
            const x1 = Math.min(max, x0 + 1);
            const fx = Math.max(0, Math.min(1, sx - x0));
            const i00 = (y0 * SIZE + x0) * 4, i01 = (y0 * SIZE + x1) * 4;
            const i10 = (y1 * SIZE + x0) * 4, i11 = (y1 * SIZE + x1) * 4;
            const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
            const k = keep * cov;
            out[o] = (src[i00] * w00 + src[i01] * w01 + src[i10] * w10 + src[i11] * w11) * k;
            out[o + 1] = (src[i00 + 1] * w00 + src[i01 + 1] * w01 + src[i10 + 1] * w10 + src[i11 + 1] * w11) * k;
            out[o + 2] = (src[i00 + 2] * w00 + src[i01 + 2] * w01 + src[i10 + 2] * w10 + src[i11 + 2] * w11) * k;
            out[o + 3] = 255;
        }
    }
    return out;
}

// out = a·(1-t) + b·t
function blend(a, b, t, out) {
    const u = 1 - t;
    for (let i = 0; i < BYTES; i += 4) {
        out[i] = a[i] * u + b[i] * t;
        out[i + 1] = a[i + 1] * u + b[i + 1] * t;
        out[i + 2] = a[i + 2] * u + b[i + 2] * t;
        out[i + 3] = 255;
    }
    return out;
}

// Soft expanding ring of light (touch feedback)
function drawRipple(out, radius, width, alpha, [cr, cg, cb]) {
    if (alpha <= 0) return out;
    for (let p = 0; p < PIXELS; p++) {
        const d = Math.abs(DIST[p] - radius) / width;
        if (d >= 1) continue;
        const s = 1 - d;
        const k = s * s * (3 - 2 * s) * alpha;
        const o = p * 4;
        out[o] += (cr - out[o]) * k;          // lerp: stays within 0..255 (Buffers wrap)
        out[o + 1] += (cg - out[o + 1]) * k;
        out[o + 2] += (cb - out[o + 2]) * k;
    }
    return out;
}

// Glowing frame hugging the key edges; `alpha` 0..1 (pulsed by the caller while playing)
function drawGlow(out, width, alpha, [cr, cg, cb]) {
    if (alpha <= 0) return out;
    for (let p = 0; p < PIXELS; p++) {
        const e = EDGE[p];
        if (e >= width) continue;
        const s = 1 - e / width;
        const k = s * s * alpha;
        const o = p * 4;
        out[o] += (cr - out[o]) * k;
        out[o + 1] += (cg - out[o + 1]) * k;
        out[o + 2] += (cb - out[o + 2]) * k;
    }
    return out;
}

// Thin progress bar along the bottom edge (fraction 0..1)
function drawProgress(out, fraction, [cr, cg, cb]) {
    const h = 5, y0 = SIZE - h;
    const fill = Math.max(0, Math.min(1, fraction)) * SIZE;
    for (let y = y0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const o = (y * SIZE + x) * 4;
            const cov = Math.max(0, Math.min(1, fill - x));
            // dark track under the whole bar, colored fill on top (antialiased tip)
            let r = out[o] * 0.35, g = out[o + 1] * 0.35, b = out[o + 2] * 0.35;
            r += (cr - r) * cov; g += (cg - g) * cov; b += (cb - b) * cov;
            out[o] = r; out[o + 1] = g; out[o + 2] = b;
        }
    }
    return out;
}

// Glyph shapes in glyph units (-1..1), as signed coverage
const PLAY_EDGES = (() => {
    const pts = [[-0.36, -0.55], [0.62, 0], [-0.36, 0.55]];
    const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    return pts.map((p, i) => {
        const q = pts[(i + 1) % 3];
        let nx = -(q[1] - p[1]), ny = q[0] - p[0];
        const len = Math.hypot(nx, ny); nx /= len; ny /= len;
        let c = -(nx * p[0] + ny * p[1]);
        if (nx * cx + ny * cy + c < 0) { nx = -nx; ny = -ny; c = -c; }
        return [nx, ny, c];
    });
})();

function playCoverage(u, v, px) {
    let d = Infinity;
    for (const [nx, ny, c] of PLAY_EDGES) d = Math.min(d, nx * u + ny * v + c);
    return Math.max(0, Math.min(1, d * px + 0.5));
}

function stopCoverage(u, v, px) {
    const d = 0.42 - Math.max(Math.abs(u), Math.abs(v));
    return Math.max(0, Math.min(1, d * px + 0.5));
}

// ▶ or ■ glyph on a translucent dark disc in the center. radius in px, alpha 0..1
function drawGlyph(out, kind, radius, alpha) {
    if (alpha <= 0 || radius <= 0) return out;
    const coverage = kind === 'stop' ? stopCoverage : playCoverage;
    const disc = radius * 1.25;
    const lo = Math.max(0, Math.floor(CENTER - disc - 1));
    const hi = Math.min(SIZE, Math.ceil(CENTER + disc + 1));
    for (let y = lo; y < hi; y++) {
        for (let x = lo; x < hi; x++) {
            const p = y * SIZE + x;
            const o = p * 4;
            const discA = Math.max(0, Math.min(1, disc - DIST[p] + 0.5)) * 0.42 * alpha;
            const u = (x + 0.5 - CENTER) / radius, v = (y + 0.5 - CENTER) / radius;
            const glyphA = coverage(u, v, radius) * alpha;
            for (let c = 0; c < 3; c++) {
                let val = out[o + c] * (1 - discA);
                val += (255 - val) * glyphA;
                out[o + c] = val;
            }
        }
    }
    return out;
}

module.exports = {
    SIZE, newRaster, decodeJpeg, encodeJpeg, drawCover, blend, drawRipple, drawGlow, drawProgress, drawGlyph
};
