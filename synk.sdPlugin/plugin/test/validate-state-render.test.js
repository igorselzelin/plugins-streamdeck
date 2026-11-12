const test = require('node:test');
const assert = require('node:assert');
const { isValidSoundId, cleanName, cleanPlayMode, cleanVolumeStep, cleanVolume } = require('../synk/validate');
const { SynkState } = require('../synk/state');
const { SynkError } = require('../synk/errors');
const render = require('../render');

const ID = '7dad22be-335c-402e-8cad-1e0355c3f4b7';

test('sound IDs: lowercase UUIDs only, never paths, URLs or commands', () => {
    assert.ok(isValidSoundId(ID));
    for (const bad of [
        '', ' ', null, undefined, 42, {}, ID.toUpperCase(), `${ID} `, 'abc_123', 'C:\\sons\\a.mp3', '/etc/passwd',
        '..\\x', 'https://x.y/z.mp3', 'a;calc', `${ID};calc`, 'x'.repeat(36)
    ]) {
        assert.strictEqual(isValidSoundId(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
});

test('names, modes, steps and volumes are sanitized', () => {
    assert.strictEqual(cleanName('  Buzina\u0007 '), 'Buzina');
    assert.strictEqual(cleanName(5), '');
    assert.strictEqual(cleanName('x'.repeat(300)).length, 100);
    assert.strictEqual(cleanPlayMode('restart'), 'restart');
    assert.strictEqual(cleanPlayMode('toggle'), 'overlap', 'toggle is its own action');
    assert.strictEqual(cleanPlayMode('rm -rf'), 'overlap');
    assert.strictEqual(cleanVolumeStep('10'), 10);
    assert.strictEqual(cleanVolumeStep(7), 5);
    assert.strictEqual(cleanVolume(0.800000011920929), 0.8);
    assert.strictEqual(cleanVolume(2.5), 2);
    assert.strictEqual(cleanVolume('1'), null);
});

test('unknown error codes map to INTERNAL', () => {
    assert.strictEqual(new SynkError('NOT_FOUND').code, 'NOT_FOUND');
    assert.strictEqual(new SynkError('SOMETHING_NEW').code, 'INTERNAL');
});

test('state clears playing/audio when the connection is lost, keeps names as offline labels', () => {
    const s = new SynkState();
    let changes = 0;
    s.on('change', () => changes++);
    s.setConnection('connected');
    s.setPlaying([ID, ID]);
    s.upsertSound({ id: ID, name: 'Aplausos' });
    s.setAudio({ volume: 0.8, muted: false, state: 'running' });
    assert.ok(s.isPlaying(ID));
    assert.strictEqual(s.voiceCount, 2);
    const before = changes;
    s.setPlaying([ID, ID]); // same snapshot: no change event
    assert.strictEqual(changes, before);
    s.setConnection('offline');
    assert.strictEqual(s.isPlaying(ID), false);
    assert.deepStrictEqual(s.effects, { volume: null, muted: null });
    assert.strictEqual(s.soundName(ID), 'Aplausos');
});

test('a sound found again after NOT_FOUND is no longer "removed"', () => {
    const s = new SynkState();
    s.markMissing(ID);
    assert.ok(s.isMissing(ID));
    s.upsertSound({ id: ID, name: 'Voltou' });
    assert.ok(!s.isMissing(ID));
});

test('every key state renders a 126x126 JPEG', async () => {
    const Jimp = require('jimp');
    const png = await new Jimp(300, 200, 0xff0000ff).getBase64Async(Jimp.MIME_PNG);
    const art = await render.prepareArtwork(png);
    const base = { connection: 'connected', errorCode: null, error: null, artwork: null, missing: false };
    const outputs = await Promise.all([
        render.renderSound({ ...base, variant: 'play', soundId: null, name: '', playing: false }),
        render.renderSound({ ...base, variant: 'toggle', soundId: ID, name: 'Ação é música ☃ 漢字', playing: true }),
        render.renderSound({ ...base, variant: 'stop', soundId: ID, name: 'y'.repeat(80), playing: false, connection: 'offline', errorCode: 'NOT_RUNNING' }),
        render.renderSound({ ...base, variant: 'play', soundId: ID, name: 'z', playing: false, artwork: art }),
        render.renderSound({ ...base, variant: 'play', soundId: ID, name: 'z', playing: false, artwork: 'bm90IGFuIGltYWdl' }),
        render.renderSound({ ...base, variant: 'play', soundId: ID, name: 'z', playing: false, missing: true }),
        render.renderSound({ ...base, variant: 'play', soundId: ID, name: 'z', playing: false, connection: 'offline', errorCode: 'VERSION_MISMATCH' }),
        render.renderStopAll({ ...base, playingCount: 4 }),
        render.renderMute({ ...base, muted: true, volume: 0.8, supported: true }),
        render.renderMute({ ...base, muted: null, volume: null, supported: false }),
        render.renderVolume({ ...base, volume: 1.55, muted: false }),
        render.renderVolume({ ...base, volume: null, muted: null, connection: 'offline' }),
        render.renderStatus({ connection: 'connected', playingCount: 0, engineVersion: '0.1.0', audioState: 'running' }),
        render.renderStatus({ connection: 'connected', playingCount: 0, audioState: 'recovering' }),
        render.renderStatus({ connection: 'offline', errorCode: 'VERSION_MISMATCH', playingCount: 0 })
    ]);
    for (const b64 of [art, ...outputs]) {
        const img = await Jimp.read(Buffer.from(b64, 'base64'));
        assert.strictEqual(img.bitmap.width, 126);
        assert.strictEqual(img.bitmap.height, 126);
    }
});
