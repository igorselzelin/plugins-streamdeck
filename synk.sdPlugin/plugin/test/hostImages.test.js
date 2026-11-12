// hostImages.js: finding the user's custom key image in (a copy of) the Rise Mode profiles.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Jimp = require('jimp');
const { HostImages } = require('../hostImages');
const { prepareArtwork } = require('../render');

const PLAY = 'com.hotspot.streamdock.synk.play';
const A = '4dafaefc-c630-45cb-a99d-ef4a3f33a866';
const B = '10d40995-682d-4eb3-bc42-e0872028abfb';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function png(color, w = 400, h = 300) {
    return new Jimp(w, h, color).getBufferAsync(Jimp.MIME_PNG);
}

// Builds a profiles folder shaped like %APPDATA%\HotSpot\StreamDock\profiles
async function makeProfiles() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synk-prof-'));
    const p1 = path.join(root, '4WTXKNWC-Q0G4-VQ04-45E1-800TGF286393.sdProfile');
    const page = path.join(p1, 'profiles', '890P4W06-M53F-QJ3P-9G4O-BT16V7WLEW57.sdProfile');
    const p2 = path.join(root, 'FQ12X7R1-SJS0-0000-0000-000000000000.sdProfile');
    for (const d of [p1, page, p2]) fs.mkdirSync(path.join(d, 'Images'), { recursive: true });
    fs.writeFileSync(path.join(p1, 'Images', 'RED0000000000000000000000.png'), await png(0xff0000ff));
    fs.writeFileSync(path.join(page, 'Images', 'BLUE000000000000000000000.png'), await png(0x0000ffff));
    fs.writeFileSync(path.join(p2, 'Images', 'GREEN00000000000000000000.png'), await png(0x00ff00ff));
    const write = (dir, actions) => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ DeviceUUID: 'ControllerDeviceS2', Name: 'x', Actions: actions }));
    write(p1, {
        '2,0': { UUID: PLAY, Settings: { soundId: A, soundName: 'Fah', mode: 'overlap' }, State: 0, States: [{ FontSize: 8, Image: 'RED0000000000000000000000.png' }] },
        '0,0': { UUID: PLAY, Settings: { soundId: B }, State: 0, States: [{ Image: 'static/play.png' }] },          // default look
        '1,0': { UUID: PLAY, Settings: { soundId: B }, State: 0, States: [{ Image: '..\\..\\secret.png' }] },        // traversal
        '3,0': { UUID: PLAY, Settings: { soundId: B }, State: 0, States: [{ Image: 'C:\\Windows\\x.png' }] },       // absolute
        '4,0': { UUID: 'com.other.plugin.action', Settings: {}, States: [{ Image: 'RED0000000000000000000000.png' }] }
    });
    write(page, { '1,1': { UUID: PLAY, Settings: { soundId: B }, State: 0, States: [{ Image: 'BLUE000000000000000000000.png' }] } });
    // Same coordinates on another device/profile, different sound and image
    write(p2, { '2,0': { UUID: PLAY, Settings: { soundId: B }, State: 0, States: [{ Image: 'GREEN00000000000000000000.png' }] } });
    return { root, p1, page, p2 };
}

test('finds the uploaded image by action + coordinates, disambiguated by the key settings', async () => {
    const { root } = await makeProfiles();
    const h = new HostImages({ root });
    h.scan();
    const at = (column, row, settings) => h.find({ uuid: PLAY, coordinates: { column, row }, settings });
    assert.match(at(2, 0, { soundId: A, soundName: 'Fah', mode: 'overlap' }), /RED0+\.png$/);
    assert.match(at(2, 0, { soundId: B }), /GREEN0+\.png$/, 'same key position in another profile');
    assert.match(at(1, 1, { soundId: B }), /BLUE0+\.png$/, 'pages inside a profile are scanned');
    assert.strictEqual(at(0, 0, { soundId: B }), null, 'static/ default image is not custom');
    assert.strictEqual(at(5, 2, { soundId: A }), null, 'unknown key');
    assert.strictEqual(h.find({ uuid: PLAY, coordinates: undefined, settings: {} }), null);
    fs.rmSync(root, { recursive: true, force: true });
});

test('never leaves the profile Images folder; other plugins are ignored', async () => {
    const { root } = await makeProfiles();
    const h = new HostImages({ root });
    h.scan();
    assert.strictEqual(h.find({ uuid: PLAY, coordinates: { column: 1, row: 0 }, settings: { soundId: B } }), null);
    assert.strictEqual(h.find({ uuid: PLAY, coordinates: { column: 3, row: 0 }, settings: { soundId: B } }), null);
    assert.ok(h.entries.every(e => e.uuid.startsWith('com.hotspot.streamdock.synk.')));
    fs.rmSync(root, { recursive: true, force: true });
});

test('a half-written manifest keeps the previous index; missing folder is harmless', async () => {
    const { root, p1 } = await makeProfiles();
    const h = new HostImages({ root });
    h.scan();
    fs.writeFileSync(path.join(p1, 'manifest.json'), '{"Actions": {"2,0": ');
    h.scan();
    assert.ok(h.entries.length >= 2, 'other profiles still indexed');
    const none = new HostImages({ root: path.join(root, 'nope') });
    none.scan();
    assert.deepStrictEqual(none.entries, []);
    fs.rmSync(root, { recursive: true, force: true });
});

test('load(): key-sized JPEG of the image, cached until the file changes', async () => {
    const { root, p1 } = await makeProfiles();
    const h = new HostImages({ root });
    h.prepare = prepareArtwork;
    h.scan();
    const file = h.find({ uuid: PLAY, coordinates: { column: 2, row: 0 }, settings: { soundId: A } });
    const b64 = await h.load(file);
    const img = await Jimp.read(Buffer.from(b64, 'base64'));
    assert.deepStrictEqual([img.bitmap.width, img.bitmap.height], [126, 126]);
    const c = Jimp.intToRGBA(img.getPixelColor(63, 63));
    assert.ok(c.r > 200 && c.g < 40 && c.b < 40, 'red image');
    assert.strictEqual(await h.load(file), b64, 'cached');
    await sleep(20);
    fs.writeFileSync(file, await png(0xffff00ff, 200, 200)); // user replaced the image
    const again = await h.load(file);
    assert.notStrictEqual(again, b64);
    assert.strictEqual(await h.load(path.join(p1, 'Images', 'missing.png')), null);
    fs.rmSync(root, { recursive: true, force: true });
});

test('watch(): a new image saved by the host is picked up and announced', async () => {
    const { root, p1 } = await makeProfiles();
    const h = new HostImages({ root });
    h.scan();
    h.watch();
    try {
        const changed = new Promise(r => h.once('change', r));
        fs.writeFileSync(path.join(p1, 'Images', 'NEW00000000000000000000000.png'), await png(0x00ffffff));
        const m = JSON.parse(fs.readFileSync(path.join(p1, 'manifest.json'), 'utf8'));
        m.Actions['0,0'].States[0].Image = 'NEW00000000000000000000000.png';
        fs.writeFileSync(path.join(p1, 'manifest.json'), JSON.stringify(m));
        await Promise.race([changed, sleep(4000).then(() => { throw new Error('no change event'); })]);
        assert.match(h.find({ uuid: PLAY, coordinates: { column: 0, row: 0 }, settings: { soundId: B } }), /NEW0+\.png$/);
    } finally {
        h.unwatch();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
