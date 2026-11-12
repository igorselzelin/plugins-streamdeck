// keyview.js: touch animations and live effects on a key, checked on the pixels sent.

const test = require('node:test');
const assert = require('node:assert');
const Jimp = require('jimp');
const R = require('../raster');
const { KeyView, COLORS } = require('../keyview');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function still(color) {
    const b64 = await new Jimp(126, 126, color).getBase64Async(Jimp.MIME_JPEG);
    return b64.replace('data:image/jpeg;base64,', '');
}

function recorder() {
    const sent = [];
    return { sent, send: b64 => sent.push({ b64, t: Date.now() }) };
}

const px = (b64, x, y) => {
    const r = R.decodeJpeg(b64);
    const o = (y * 126 + x) * 4;
    return [r[o], r[o + 1], r[o + 2]];
};
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

test('first still is sent as is (exact bytes), duplicates are not re-sent', async () => {
    const rec = recorder();
    const v = new KeyView(rec.send);
    const grey = await still(0x808080ff);
    v.setStill(grey);
    v.setStill(grey);
    assert.deepStrictEqual(rec.sent.map(s => s.b64), [grey]);
    v.dispose();
});

test('press: the key sinks and darkens, then springs back to the exact still', async () => {
    const rec = recorder();
    const v = new KeyView(rec.send);
    const white = await still(0xffffffff);
    v.setStill(white);
    await v.pressIn();
    const pressed = rec.sent[rec.sent.length - 1].b64;
    assert.ok(lum(px(pressed, 63, 63)) < 200, 'center darker while held');
    assert.ok(lum(px(pressed, 2, 2)) < 30, 'edges black: the image shrank');
    const n = rec.sent.length;
    await v.release({ glyph: 'play', color: COLORS.green });
    assert.ok(rec.sent.length - n >= 8, `release is animated (${rec.sent.length - n} frames)`);
    assert.strictEqual(rec.sent[rec.sent.length - 1].b64, white, 'ends on the untouched still');
    v.dispose();
});

test('animations run at up to ~30 fps', async () => {
    const rec = recorder();
    const v = new KeyView(rec.send);
    v.setStill(await still(0x3366ccff));
    const t0 = Date.now();
    await v.release({ glyph: 'stop' });
    const fps = rec.sent.length / ((Date.now() - t0) / 1000);
    assert.ok(fps > 12 && fps <= 40, `fps ${fps.toFixed(1)}`);
    v.dispose();
});

test('playing: breathing glow on the edges and a progress bar, until it stops', async () => {
    const rec = recorder();
    const v = new KeyView(rec.send);
    const black = await still(0x000000ff);
    v.setStill(black);
    let progress = 0.5;
    v.setStill(black, { color: COLORS.green, progress: () => progress });
    await sleep(400);
    const frames = rec.sent.slice(1);
    assert.ok(frames.length >= 4, 'live frames keep coming');
    const f = frames[frames.length - 1].b64;
    assert.ok(px(f, 1, 40)[1] > 60, 'green glow at the edge');
    assert.ok(lum(px(f, 63, 40)) < 20, 'center untouched');
    assert.ok(px(f, 30, 124)[1] > 120 && px(f, 100, 124)[1] < 60, 'progress bar half filled');
    v.setStill(black, null); // stopped
    await sleep(100);
    assert.strictEqual(rec.sent[rec.sent.length - 1].b64, black);
    const count = rec.sent.length;
    await sleep(200);
    assert.strictEqual(rec.sent.length, count, 'no frames once nothing is playing');
    v.dispose();
});

test('shake on error ends on the (error) still; a new still dissolves in', async () => {
    const rec = recorder();
    const v = new KeyView(rec.send);
    const a = await still(0x2244aaff), b = await still(0xaa2222ff);
    v.setStill(a);
    v.setStill(b);
    await sleep(260);
    const mid = rec.sent.slice(1, -1);
    assert.ok(mid.length >= 2, 'dissolve frames between the two stills');
    assert.strictEqual(rec.sent[rec.sent.length - 1].b64, b);
    await v.shake();
    assert.strictEqual(rec.sent[rec.sent.length - 1].b64, b);
    v.dispose();
});

test('a new still while held lands after the release; keyUp lost -> auto release', async () => {
    const rec = recorder();
    const v = new KeyView(rec.send);
    const a = await still(0x404040ff), b = await still(0xc0c0c0ff);
    v.setStill(a);
    await v.pressIn();
    v.setStill(b);                 // e.g. PLAYBACK arrived while the finger is down
    await sleep(1300 + 700);       // AUTO_RELEASE_MS + release animation
    assert.strictEqual(v.pressed, false);
    assert.strictEqual(rec.sent[rec.sent.length - 1].b64, b);
    v.dispose();
});

test('instant views (knob) never dissolve; disposed views send nothing', async () => {
    const rec = recorder();
    const v = new KeyView(rec.send, { instant: true });
    const a = await still(0x111111ff), b = await still(0xeeeeeeff);
    v.setStill(a);
    v.setStill(b);
    assert.deepStrictEqual(rec.sent.map(s => s.b64), [a, b]);
    v.dispose();
    v.setStill(a);
    await v.release({});
    assert.strictEqual(rec.sent.length, 2);
});

test('two keys animate independently', async () => {
    const r1 = recorder(), r2 = recorder();
    const k1 = new KeyView(r1.send), k2 = new KeyView(r2.send);
    k1.setStill(await still(0xffffffff));
    k2.setStill(await still(0xffffffff));
    await Promise.all([k1.release({ glyph: 'play' }), (async () => { await sleep(100); await k2.shake(); })()]);
    assert.ok(r1.sent.length > 8 && r2.sent.length > 5);
    k1.dispose(); k2.dispose();
});
