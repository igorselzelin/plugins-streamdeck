// Fast per-frame renderer for the 126×126 key display.
//
// Every animation frame is composed straight on raw RGBA buffers (no Jimp per frame —
// cloning/compositing through Jimp plus a quality-100 JPEG encode is what used to cap
// the animations at ~5 fps). Jimp is only used once per cover, to decode and downscale.
const Jimp = require('jimp');
const jpeg = require('jpeg-js');

const SIZE = 126;
const PIXELS = SIZE * SIZE;
const BYTES = PIXELS * 4;
const CENTER = SIZE / 2;
// Lower than Jimp's default of 100: frames end up ~4× smaller, so they encode faster and
// reach the device faster, with no visible difference at this size.
const JPEG_QUALITY = 82;

// Distance of every pixel center to the key center (used by the ripple)
const DIST = new Float32Array(PIXELS);
for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        DIST[y * SIZE + x] = Math.hypot(x + 0.5 - CENTER, y + 0.5 - CENTER);
    }
}

function newRaster() {
    return Buffer.alloc(BYTES);
}

// Decodes any image (JPEG/PNG buffer or file path) into a SIZE×SIZE opaque RGBA raster
async function decodeToRaster(input) {
    const img = await Jimp.read(input);
    img.cover(SIZE, SIZE);
    const out = newRaster();
    const src = img.bitmap.data;
    for (let i = 0; i < BYTES; i += 4) {
        const a = src[i + 3] / 255; // flatten transparency (e.g. the PNG logo) onto black
        out[i] = src[i] * a;
        out[i + 1] = src[i + 1] * a;
        out[i + 2] = src[i + 2] * a;
        out[i + 3] = 255;
    }
    return out;
}

function encodeJpeg(raster) {
    return jpeg.encode({ data: raster, width: SIZE, height: SIZE }, JPEG_QUALITY).data.toString('base64');
}

// Draws `src` into `out` with the given look:
//   scale  — 1 = full key, <1 shrinks toward the center over a black background
//   grey   — 0 = full color, 1 = black and white
//   dim    — 0 = untouched, 1 = black
function drawCover(src, out, { scale = 1, grey = 0, dim = 0 }) {
    const inv = 1 / scale;
    const keep = 1 - dim;
    const max = SIZE - 1;
    for (let y = 0; y < SIZE; y++) {
        const sy = (y + 0.5 - CENTER) * inv + CENTER - 0.5;
        // Antialiased edge: fraction of this pixel covered by the shrunken cover
        const cy = Math.min(1, Math.max(0, Math.min(sy + 0.5, SIZE - 0.5 - sy) * scale + 0.5));
        const y0 = Math.max(0, Math.min(max, Math.floor(sy)));
        const y1 = Math.min(max, y0 + 1);
        const fy = Math.max(0, Math.min(1, sy - y0));
        for (let x = 0; x < SIZE; x++) {
            const o = (y * SIZE + x) * 4;
            const sx = (x + 0.5 - CENTER) * inv + CENTER - 0.5;
            const cx = Math.min(1, Math.max(0, Math.min(sx + 0.5, SIZE - 0.5 - sx) * scale + 0.5));
            const cov = cx * cy;
            if (cov <= 0) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = 255; continue; }

            const x0 = Math.max(0, Math.min(max, Math.floor(sx)));
            const x1 = Math.min(max, x0 + 1);
            const fx = Math.max(0, Math.min(1, sx - x0));
            const i00 = (y0 * SIZE + x0) * 4, i01 = (y0 * SIZE + x1) * 4;
            const i10 = (y1 * SIZE + x0) * 4, i11 = (y1 * SIZE + x1) * 4;
            const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;

            let r = src[i00] * w00 + src[i01] * w01 + src[i10] * w10 + src[i11] * w11;
            let g = src[i00 + 1] * w00 + src[i01 + 1] * w01 + src[i10 + 1] * w10 + src[i11 + 1] * w11;
            let b = src[i00 + 2] * w00 + src[i01 + 2] * w01 + src[i10 + 2] * w10 + src[i11 + 2] * w11;

            if (grey > 0) {
                const l = 0.299 * r + 0.587 * g + 0.114 * b;
                r += (l - r) * grey; g += (l - g) * grey; b += (l - b) * grey;
            }
            const k = keep * cov;
            out[o] = r * k; out[o + 1] = g * k; out[o + 2] = b * k; out[o + 3] = 255;
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

// Soft expanding ring of light, screen-blended over the frame (touch feedback)
function drawRipple(out, radius, width, alpha, [cr, cg, cb]) {
    if (alpha <= 0) return out;
    for (let p = 0; p < PIXELS; p++) {
        const d = Math.abs(DIST[p] - radius) / width;
        if (d >= 1) continue;
        const s = 1 - d;
        const k = s * s * (3 - 2 * s) * alpha; // smoothstep falloff
        const o = p * 4;
        // Lerp toward the ripple color — always stays within 0..255 (Buffers wrap, not clamp)
        out[o] += (cr - out[o]) * k;
        out[o + 1] += (cg - out[o + 1]) * k;
        out[o + 2] += (cb - out[o + 2]) * k;
    }
    return out;
}

// Signed coverage helpers for the play/pause glyph, in glyph units (-1..1)
// Triangle pointing right (nudged right of center so it looks optically centered).
// Each edge stored as an inward unit normal + offset, so distance inside = n·p + c.
const PLAY_EDGES = (() => {
    const pts = [[-0.36, -0.55], [0.62, 0], [-0.36, 0.55]];
    const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    return pts.map((p, i) => {
        const q = pts[(i + 1) % 3];
        let nx = -(q[1] - p[1]), ny = q[0] - p[0];
        const len = Math.hypot(nx, ny); nx /= len; ny /= len;
        let c = -(nx * p[0] + ny * p[1]);
        if (nx * cx + ny * cy + c < 0) { nx = -nx; ny = -ny; c = -c; } // point inward
        return [nx, ny, c];
    });
})();

function playCoverage(u, v, px) {
    let d = Infinity;
    for (const [nx, ny, c] of PLAY_EDGES) d = Math.min(d, nx * u + ny * v + c);
    return Math.max(0, Math.min(1, d * px + 0.5));
}

function pauseCoverage(u, v, px) {
    const dy = 0.48 - Math.abs(v);
    const left = Math.min(0.15 - Math.abs(u + 0.27), dy);
    const right = Math.min(0.15 - Math.abs(u - 0.27), dy);
    return Math.max(0, Math.min(1, Math.max(left, right) * px + 0.5));
}

// Draws a play (▶) or pause (❚❚) glyph on a translucent dark disc in the center.
// radius: glyph radius in px; alpha: overall opacity 0..1
function drawGlyph(out, kind, radius, alpha) {
    if (alpha <= 0 || radius <= 0) return out;
    const coverage = kind === 'play' ? playCoverage : pauseCoverage;
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
                let val = out[o + c] * (1 - discA);      // darken behind the glyph
                val += (255 - val) * glyphA;              // white glyph on top
                out[o + c] = val;
            }
        }
    }
    return out;
}

module.exports = { SIZE, newRaster, decodeToRaster, encodeJpeg, drawCover, blend, drawRipple, drawGlyph };
