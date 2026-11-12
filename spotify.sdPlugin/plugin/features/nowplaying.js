const path = require('path');
const { spawn } = require('child_process');
const { Plugins, Actions, log } = require('../utils/plugin');
const { SpotifyPoller } = require('../spotifyPoller');
const R = require('../raster');

// Credentials live in config.js (outside git — see config.example.js and .gitignore)
const { SPOTIFY_CLIENT_ID, SPOTIFY_EXE } = require('../config');

const SPOTIFY_LOGO = path.join(process.cwd(), '../static/spotify.png');
const CREDENTIALS_OK = !SPOTIFY_CLIENT_ID.startsWith('YOUR_');

// ── Animation tuning ────────────────────────────────────────────────────────────
// Animations are time-based: if a frame is late, the next one jumps ahead instead of
// the whole animation stretching out (the old fixed 40ms-per-step loop + slow encodes
// ran at ~5 fps and took twice as long as intended).
// If the device ever seems to lag behind (frames queuing up), lower FPS.
const FPS = 30;
const FRAME_MS = 1000 / FPS;

const CROSSFADE_MS = 340;     // track → track dissolve (no black in between)
const CROSSFADE_ZOOM = 0.06;  // incoming cover settles from 106% to 100% while dissolving
const STATE_MS = 320;         // play/pause changed from inside Spotify
const PRESS_MS = 90;          // finger down: the cover sinks
const PRESS_DEPTH = 0.88;     // pressed size relative to the resting size
const PRESS_DIM = 0.32;       // how much darker it gets while held
const RELEASE_MS = 600;       // finger up: springs back into the new state
const RIPPLE_MS = 480;
const GLYPH_MS = 640;

const LOOK_PLAYING = { scale: 1, grey: 0, dim: 0 };
const LOOK_PAUSED = { scale: 0.9, grey: 1, dim: 0 };
const GREEN = [30, 215, 96];
const WHITE = [255, 255, 255];

// ── State ───────────────────────────────────────────────────────────────────────
const plugin = new Plugins();
let poller = null;
let pollerRefCount = 0;
let currentTrack = null;      // { id, name, artist, isPlaying }
let source = null;            // raster being drawn: the current cover, or the logo
let look = { ...LOOK_PLAYING };
let logo = null;
const shown = R.newRaster();  // last frame sent to the keys (start of every dissolve)
let shownUri = null;
const frame = R.newRaster();
const activeContexts = new Set();
let animToken = { cancelled: false };
let pressAction = null;       // 'toggle' | 'launch' while the key is held

const logoReady = R.decodeToRaster(SPOTIFY_LOGO)
    .then(r => {
        logo = r;
        if (!shownUri) r.copy(shown);
        // Warm-up render: the very first frame through the JPEG encoder and the pixel loops
        // is ~200ms slower (JIT + encoder tables), which would eat the first dissolve.
        const scratch = R.newRaster();
        R.drawCover(r, scratch, { scale: 0.9, grey: 0.5, dim: 0.2 });
        R.blend(r, scratch, 0.5, scratch);
        R.drawRipple(scratch, 40, 12, 0.5, WHITE);
        R.drawGlyph(scratch, 'play', 20, 1);
        R.drawGlyph(scratch, 'pause', 20, 1);
        R.encodeJpeg(scratch);
        return r;
    })
    .catch(err => { log.error('Logo decode error:', err.message); return null; });

// ── Easing ──────────────────────────────────────────────────────────────────────
const clamp01 = t => Math.max(0, Math.min(1, t));
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInCubic = t => t * t * t;
const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeInOutSine = t => -(Math.cos(Math.PI * t) - 1) / 2;

// Underdamped spring, 0 → 1 with a small overshoot — the "bounce back" of a real surface
const SPRING_ZETA = 0.42;
const SPRING_OMEGA = 2 * Math.PI * 3.1;
const SPRING_DECAY = SPRING_ZETA * SPRING_OMEGA;
const SPRING_OMEGA_D = SPRING_OMEGA * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
function spring(seconds) {
    const e = Math.exp(-SPRING_DECAY * seconds);
    return 1 - e * (Math.cos(SPRING_OMEGA_D * seconds) + (SPRING_DECAY / SPRING_OMEGA_D) * Math.sin(SPRING_OMEGA_D * seconds));
}

const lerp = (a, b, k) => a + (b - a) * k;
const lerpLook = (a, b, k) => ({ scale: lerp(a.scale, b.scale, k), grey: lerp(a.grey, b.grey, k), dim: lerp(a.dim, b.dim, k) });
const targetLook = () => (currentTrack && !currentTrack.isPlaying ? LOOK_PAUSED : LOOK_PLAYING);

// ── Frame output ────────────────────────────────────────────────────────────────
function push(raster) {
    shownUri = `data:image/jpeg;base64,${R.encodeJpeg(raster)}`;
    if (raster !== shown) raster.copy(shown);
    for (const ctx of activeContexts) plugin.setImage(ctx, shownUri);
}

function drawLook(lk) {
    look = lk;
    return R.drawCover(source, frame, lk);
}

function cancelAnim() {
    animToken.cancelled = true;
    animToken = { cancelled: false };
    return animToken;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs drawFrame(t) for t = 0..1 over durationMs at up to FPS frames per second.
// Returns false if cancelled by a newer animation.
async function animate(durationMs, drawFrame, token) {
    const start = performance.now();
    for (;;) {
        if (token.cancelled) return false;
        const elapsed = performance.now() - start;
        const t = clamp01(elapsed / durationMs);
        push(drawFrame(t));
        if (t >= 1) return true;
        const nextFrameAt = (Math.floor(elapsed / FRAME_MS) + 1) * FRAME_MS;
        await sleep(Math.max(1, nextFrameAt - (performance.now() - start)));
    }
}

// ── Transitions ─────────────────────────────────────────────────────────────────

// Dissolves whatever is on screen right now into `next` — one image melts into the
// other, never through black.
async function dissolveTo(next, token) {
    const from = Buffer.from(shown);
    const to = { ...targetLook() };
    const incoming = R.newRaster();
    source = next;
    look = to;
    const done = await animate(CROSSFADE_MS, t => {
        const zoom = 1 + CROSSFADE_ZOOM * (1 - easeOutCubic(t));
        R.drawCover(next, incoming, { ...to, scale: to.scale * zoom });
        return R.blend(from, incoming, easeInOutSine(t), frame);
    }, token);
    if (done) push(drawLook(to));
}

// Smoothly moves the current cover to another look (play/pause changed from Spotify)
async function lookTo(to, ms, token) {
    if (!source) return;
    const from = { ...look };
    await animate(ms, t => drawLook(lerpLook(from, to, easeInOutCubic(t))), token);
}

// Finger down: the cover sinks in and darkens, like pressing on a physical sleeve
async function pressIn(token) {
    if (!source) return;
    const from = { ...look };
    const pressed = { scale: from.scale * PRESS_DEPTH, grey: from.grey, dim: PRESS_DIM };
    await animate(PRESS_MS, t => drawLook(lerpLook(from, pressed, easeOutCubic(t))), token);
}

// Finger up: springs (with a little overshoot) into the new state, while a ripple runs
// out from the center and a ▶ / ❚❚ glyph pops and fades.
async function release(token, glyph) {
    if (!source) return;
    const from = { ...look };
    const to = { ...targetLook() };
    const rippleColor = glyph === 'pause' ? WHITE : GREEN;
    const total = Math.max(RELEASE_MS, RIPPLE_MS, glyph ? GLYPH_MS : 0);

    const done = await animate(total, t => {
        const ms = t * total;
        drawLook({
            scale: lerp(from.scale, to.scale, spring(ms / 1000)),
            grey: lerp(from.grey, to.grey, easeInOutCubic(clamp01(ms / (RELEASE_MS * 0.55)))),
            dim: from.dim * (1 - easeOutCubic(clamp01(ms / 240)))
        });

        const rt = clamp01(ms / RIPPLE_MS);
        R.drawRipple(frame, 4 + 90 * easeOutCubic(rt), 9 + 10 * rt, 0.55 * Math.pow(1 - rt, 1.6), rippleColor);

        if (glyph) {
            const gt = clamp01(ms / GLYPH_MS);
            const alpha = gt < 0.12 ? gt / 0.12 : 1 - easeInCubic((gt - 0.12) / 0.88);
            R.drawGlyph(frame, glyph, 16 + 10 * easeOutCubic(gt), 0.95 * alpha);
        }
        return frame;
    }, token);
    if (done) push(drawLook(to));
}

// ── Spotify state ───────────────────────────────────────────────────────────────

function ensurePoller() {
    pollerRefCount++;
    if (!poller) {
        poller = new SpotifyPoller(onStateChange, () => {}, log);
        poller.start();
    }
    return poller;
}

function releasePoller() {
    pollerRefCount = Math.max(0, pollerRefCount - 1);
    if (pollerRefCount === 0 && poller) {
        poller.stop();
        poller = null;
    }
}

async function tryActivateSpotify() {
    for (let i = 0; i < 8; i++) {
        await sleep(2000);
        if (currentTrack !== null || !poller) return;
        try { await poller.resumePlayback(); poller.pollSoon(300); return; }
        catch (_) { }
    }
}

async function showLogo(token) {
    const l = logo ?? await logoReady;
    if (token.cancelled) return;
    if (l) await dissolveTo(l, token);
    else for (const ctx of activeContexts) plugin.setImage(ctx, SPOTIFY_LOGO);
}

async function onStateChange(track) {
    if (!track) {
        if (currentTrack === null && source === logo) return;
        currentTrack = null;
        await showLogo(cancelAnim());
        return;
    }

    const isNewTrack = !currentTrack || track.id !== currentTrack.id;
    if (!isNewTrack && track.isPlaying === currentTrack.isPlaying) return;

    currentTrack = { id: track.id, name: track.name, artist: track.artist, isPlaying: track.isPlaying };
    const token = cancelAnim();

    if (!logo) await logoReady; // first dissolve should start from the logo, not black
    if (token.cancelled) return;

    if (isNewTrack) {
        if (track.cover) await dissolveTo(track.cover, token);
        else await showLogo(token);
    } else if (!pressAction) {
        await lookTo(targetLook(), STATE_MS, token);
    }
}

// Optimistic play/pause: flips the display state right away and fires the API call
function togglePlayback() {
    const wasPlaying = currentTrack.isPlaying;
    currentTrack = { ...currentTrack, isPlaying: !wasPlaying };
    poller.expectPlaying(!wasPlaying);
    (wasPlaying ? poller.pausePlayback() : poller.resumePlayback())
        .catch(err => {
            log.error('Play/pause API error:', err.message);
            poller?.resync(); // re-read the real state; the display animates back if needed
        });
}

// ── Action ──────────────────────────────────────────────────────────────────────

plugin.registerAction('com.hotspot.streamdock.demo.action1', new Actions({
    default: {},

    _willAppear({ context }) {
        activeContexts.add(context);
        plugin.setTitle(context, '');

        if (!CREDENTIALS_OK) {
            plugin.setTitle(context, 'Configure\nSpotify');
            return;
        }

        plugin.setImage(context, shownUri ?? SPOTIFY_LOGO);
        if (!source) logoReady.then(l => { if (!source && l) source = l; });
        ensurePoller();
    },

    _willDisappear({ context }) {
        activeContexts.delete(context);
        releasePoller();
    },

    _propertyInspectorDidAppear(data) { },

    // The action happens on press (not release) so Spotify reacts ~100ms sooner;
    // the visual "click" completes on release.
    keyDown() {
        if (!poller) return;
        const token = cancelAnim();
        if (currentTrack) {
            pressAction = 'toggle';
            togglePlayback();
        } else {
            pressAction = 'launch';
        }
        pressIn(token);
    },

    keyUp() {
        if (!poller) return;
        let action = pressAction;
        pressAction = null;

        // Some hosts may only deliver keyUp — do the work here in that case
        if (!action) {
            action = currentTrack ? 'toggle' : 'launch';
            if (action === 'toggle') togglePlayback();
        }

        if (action === 'launch') {
            spawn(SPOTIFY_EXE, [], { detached: true, stdio: 'ignore' }).unref();
            tryActivateSpotify();
            release(cancelAnim(), null);
            return;
        }

        release(cancelAnim(), currentTrack?.isPlaying ? 'play' : 'pause');
    },

    dialRotate(data) { log.info('dialRotate', data); },
    dialDown(data)   { log.info('dialDown', data); }
}));
