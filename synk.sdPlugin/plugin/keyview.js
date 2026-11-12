// What one key shows, frame by frame.
//
// A key has a "still" (the resting image from render.js: icon, custom image, banners)
// and optionally a "live" effect (a sound playing: breathing glow + progress bar).
// On top of that it plays touch animations:
//   pressIn   finger down: the key sinks and darkens
//   release   finger up: springs back with a little overshoot, ripple + ▶/■ glyph
//   shake     the command failed: quick horizontal shake + red ripple
//   dissolve  the still changed: one image melts into the other
// Time-based at up to 30 fps (late frames skip ahead instead of stretching the animation).
// Each key has its own cancel token, so one key animating never blocks another.

const R = require('./raster');

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const LIVE_FPS = 15;          // breathing glow while playing (cheap, steady)
const PRESS_MS = 90;
const PRESS_SCALE = 0.86;
const PRESS_DIM = 0.35;
const RELEASE_MS = 560;
const RIPPLE_MS = 460;
const GLYPH_MS = 600;
const SHAKE_MS = 380;
const DISSOLVE_MS = 180;
const AUTO_RELEASE_MS = 1200; // keyUp lost: never stay pressed
const GLOW_PERIOD_MS = 1600;

const COLORS = {
    green: [46, 204, 113],
    white: [255, 255, 255],
    red: [231, 76, 60],
    amber: [214, 137, 16]
};

const clamp01 = v => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInCubic = t => t * t * t;
const easeInOutSine = t => -(Math.cos(Math.PI * t) - 1) / 2;
// Damped spring 0 -> 1 with a small overshoot (t in seconds)
const spring = t => 1 - Math.exp(-7 * t) * Math.cos(13 * t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class KeyView {
    /**
     * @param {(b64: string) => void} send   pushes one JPEG (base64) to the key
     * @param {object} [opts]
     * @param {boolean} [opts.instant]       no dissolves (knob: immediate feedback)
     */
    constructor(send, opts = {}) {
        this.send = send;
        this.instant = !!opts.instant;
        this.still = null;          // { b64, raster }
        this.live = null;           // { color, progress: () => number|null } | null
        this.shown = R.newRaster(); // last frame pushed (start of dissolves)
        this.hasShown = false;
        this.frame = R.newRaster();
        this.lastSent = null;
        this.token = { cancelled: false };
        this.pressed = false;       // between pressIn and release
        this.autoRelease = null;
        this.disposed = false;
    }

    dispose() {
        this.disposed = true;
        this.cancel();
        clearTimeout(this.autoRelease);
    }

    cancel() {
        this.token.cancelled = true;
        this.token = { cancelled: false };
        return this.token;
    }

    push(raster) {
        if (this.disposed) return;
        raster.copy(this.shown);
        this.hasShown = true;
        this.sendB64(R.encodeJpeg(raster));
    }

    sendB64(b64) {
        if (this.disposed || b64 === this.lastSent) return;
        this.lastSent = b64;
        this.send(b64);
    }

    // The resting image (exact bytes from render.js) or the live loop.
    rest(token) {
        if (token.cancelled || !this.still) return;
        if (this.live) { this.runLive(token); return; }
        this.still.raster.copy(this.shown);
        this.hasShown = true;
        this.sendB64(this.still.b64);
    }

    /** New resting image and live effect. Dissolves unless instant. */
    setStill(b64, live = null) {
        if (!b64 || this.disposed) return;
        const sameStill = !!this.still && this.still.b64 === b64;
        const sameLive = !!this.live === !!live && (!live || this.live.color === live.color);
        this.live = live; // always take the newest (its progress() reads the latest state)
        if (sameStill && sameLive) return;
        if (!sameStill) {
            let raster;
            try { raster = R.decodeJpeg(b64); } catch { return; }
            this.still = { b64, raster };
        }
        if (this.pressed) return; // the release animation lands on the new still
        const token = this.cancel();
        if (this.instant || !this.hasShown || sameStill) return this.rest(token);
        this.dissolve(token);
    }

    async animate(durationMs, draw, token) {
        const start = now();
        for (;;) {
            if (token.cancelled || this.disposed) return false;
            const elapsed = now() - start;
            const t = clamp01(elapsed / durationMs);
            this.push(draw(t, elapsed));
            if (t >= 1) return true;
            const next = (Math.floor(elapsed / FRAME_MS) + 1) * FRAME_MS;
            await sleep(Math.max(1, next - (now() - start)));
        }
    }

    // Still + live effect for the current moment.
    composeLive(target, ms) {
        const live = this.live;
        if (!live) return target;
        const pulse = 0.5 + 0.5 * Math.sin((ms / GLOW_PERIOD_MS) * Math.PI * 2);
        R.drawGlow(target, 12, 0.7 + 0.3 * pulse, live.color);
        const p = live.progress?.();
        if (typeof p === 'number' && Number.isFinite(p)) R.drawProgress(target, p, live.color);
        return target;
    }

    base(target) {
        this.still.raster.copy(target);
        return this.composeLive(target, now());
    }

    async runLive(token) {
        const start = now();
        while (!token.cancelled && !this.disposed && this.live) {
            this.still.raster.copy(this.frame);
            this.push(this.composeLive(this.frame, now() - start));
            await sleep(1000 / LIVE_FPS);
        }
    }

    async dissolve(token) {
        const from = Buffer.from(this.shown);
        const to = R.newRaster();
        const done = await this.animate(DISSOLVE_MS, t => {
            this.base(to);
            return R.blend(from, to, easeInOutSine(t), this.frame);
        }, token);
        if (done) this.rest(token);
    }

    // Finger down: the key sinks in and darkens.
    async pressIn() {
        if (!this.still || this.disposed) return;
        const token = this.cancel();
        this.pressed = true;
        clearTimeout(this.autoRelease);
        this.autoRelease = setTimeout(() => { if (this.pressed) this.release({}); }, AUTO_RELEASE_MS);
        const src = R.newRaster();
        await this.animate(PRESS_MS, t => {
            const k = easeOutCubic(t);
            this.base(src);
            return R.drawCover(src, this.frame, { scale: lerp(1, PRESS_SCALE, k), dim: PRESS_DIM * k });
        }, token);
        // stays pressed (last frame) until release()
    }

    /**
     * Finger up: spring back, ripple and glyph.
     * @param {{glyph?: 'play'|'stop', color?: number[]}} fx
     */
    async release({ glyph = null, color = COLORS.white } = {}) {
        if (!this.still || this.disposed) return;
        clearTimeout(this.autoRelease);
        const token = this.cancel();
        const wasPressed = this.pressed;
        this.pressed = false;
        const fromScale = wasPressed ? PRESS_SCALE : 0.94;
        const fromDim = wasPressed ? PRESS_DIM : 0.15;
        const total = Math.max(RELEASE_MS, RIPPLE_MS, glyph ? GLYPH_MS : 0);
        const src = R.newRaster();
        const done = await this.animate(total, (t, ms) => {
            this.base(src);
            R.drawCover(src, this.frame, {
                scale: lerp(fromScale, 1, Math.min(1.04, spring(ms / 1000))),
                dim: fromDim * (1 - easeOutCubic(clamp01(ms / 220)))
            });
            const rt = clamp01(ms / RIPPLE_MS);
            R.drawRipple(this.frame, 4 + 90 * easeOutCubic(rt), 9 + 10 * rt, 0.6 * Math.pow(1 - rt, 1.6), color);
            if (glyph) {
                const gt = clamp01(ms / GLYPH_MS);
                const alpha = gt < 0.12 ? gt / 0.12 : 1 - easeInCubic((gt - 0.12) / 0.88);
                R.drawGlyph(this.frame, glyph, 16 + 10 * easeOutCubic(gt), 0.95 * alpha);
            }
            return this.frame;
        }, token);
        if (done) this.rest(token);
    }

    // The command failed: shake + red ripple, then rest on the (error) still.
    async shake() {
        if (!this.still || this.disposed) return;
        clearTimeout(this.autoRelease);
        this.pressed = false;
        const token = this.cancel();
        const src = R.newRaster();
        const done = await this.animate(SHAKE_MS, (t, ms) => {
            this.base(src);
            const dx = Math.sin(ms / 1000 * Math.PI * 2 * 9) * 7 * (1 - t);
            R.drawCover(src, this.frame, { scale: 1, dx });
            R.drawRipple(this.frame, 4 + 80 * easeOutCubic(t), 10, 0.5 * (1 - t), COLORS.red);
            return this.frame;
        }, token);
        if (done) this.rest(token);
    }
}

module.exports = { KeyView, COLORS };
