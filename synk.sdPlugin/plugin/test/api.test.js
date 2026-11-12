// api.js: exact command/params mapping (contract section 13), snapshot-vs-event race rule,
// LIBRARY_CHANGED debounce, SHUTTING_DOWN, paging, artwork, mute and volume rules.

const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../synk/api');
const { SynkState } = require('../synk/state');
const { SynkError } = require('../synk/errors');

const ID = '7dad22be-335c-402e-8cad-1e0355c3f4b7';
const ID2 = '0b6f2c43-1d1e-4c33-9b77-3f9d2d2f8a10';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Supervisor stand-in: records calls and answers from a table.
function harness(answers = {}, opts = {}) {
    const calls = [];
    const supervisor = {
        connected: true,
        reconnectAfterMs: null,
        reconnectAfter(ms) { this.reconnectAfterMs = ms; },
        async call(cmd, params, timeoutMs) {
            calls.push({ cmd, params, timeoutMs });
            const a = answers[cmd];
            if (typeof a === 'function') return a(params);
            if (a instanceof Error) throw a;
            return a;
        }
    };
    const state = new SynkState();
    state.setConnection('connected');
    let libraryChanged = 0;
    const api = createApi({
        supervisor, state,
        visibleSoundIds: () => opts.visible ?? [],
        onLibraryChanged: () => libraryChanged++
    });
    return { api, state, calls, supervisor, libraryChanged: () => libraryChanged };
}

test('each operation sends exactly the documented command and params', async () => {
    const h = harness({ PLAY_SOUND: { voice_id: 1 }, STOP_SOUND: { stopped: 1 }, STOP_ALL: { stopped: 0 }, SET_VOLUME: {}, SET_MUTE: { effects_muted: true, effects_volume: 0.8 } });
    await h.api.playSound(ID, 'restart');
    await h.api.playSound(ID, 'something-else');
    await h.api.toggleSound(ID);
    await h.api.stopSound(ID);
    await h.api.stopAll();
    await h.api.setEffectsVolume(1.5);
    await h.api.setEffectsMuted(true);
    assert.deepStrictEqual(h.calls.map(c => [c.cmd, c.params]), [
        ['PLAY_SOUND', { sound_id: ID, mode: 'restart' }],
        ['PLAY_SOUND', { sound_id: ID, mode: 'overlap' }],
        ['PLAY_SOUND', { sound_id: ID, mode: 'toggle' }],   // toggle decided by the engine
        ['STOP_SOUND', { sound_id: ID }],
        ['STOP_ALL', undefined],
        ['SET_VOLUME', { target: { kind: 'effects' }, volume: 1.5 }],
        ['SET_MUTE', { target: 'effects', muted: true }]
    ]);
    assert.strictEqual(h.calls[0].timeoutMs, 5000, 'PLAY_SOUND gets 5 s');
    assert.strictEqual(h.calls[3].timeoutMs, undefined, 'others use the 3 s default');
});

test('a key never sends anything but a UUID as sound_id', async () => {
    const h = harness();
    for (const bad of [null, '', 'C:\\sons\\a.wav', '../x', 'https://x/y.mp3', ID.toUpperCase()]) {
        await assert.rejects(h.api.playSound(bad, 'overlap'), e => e.code === 'INVALID_SOUND');
        await assert.rejects(h.api.stopSound(bad), e => e.code === 'INVALID_SOUND');
    }
    assert.strictEqual(h.calls.length, 0);
});

test('volume is clamped to 0..2 and rounded before sending', async () => {
    const h = harness({ SET_VOLUME: {} });
    await h.api.setEffectsVolume(2.7);
    await h.api.setEffectsVolume(-1);
    await h.api.setEffectsVolume(0.8000001);
    assert.deepStrictEqual(h.calls.map(c => c.params.volume), [2, 0, 0.8]);
    await assert.rejects(h.api.setEffectsVolume(NaN), e => e.code === 'INVALID_PARAMS');
    assert.strictEqual(h.api.limits.volumeMax, 2);
});

test('NOT_FOUND on a sound command marks the sound as removed', async () => {
    const h = harness({ PLAY_SOUND: new SynkError('NOT_FOUND', 'gone') });
    await assert.rejects(h.api.playSound(ID, 'overlap'), e => e.code === 'NOT_FOUND');
    assert.ok(h.state.isMissing(ID));
});

test('syncAll: GET_AUDIO + GET_PLAYBACK + GET_STATUS + GET_SOUND per visible key, results applied', async () => {
    const h = harness({
        GET_AUDIO: { state: 'running', effects_volume: 0.800000011920929, effects_muted: false, error: null, unknown: 1 },
        GET_PLAYBACK: { voices: [{ voice_id: 1, sound_id: ID, kind: 'sound' }, { voice_id: 2, sound_id: ID2, kind: 'preview' }] },
        GET_STATUS: { engine_version: '0.1.0' },
        GET_SOUND: p => (p.sound_id === ID ? { id: ID, name: 'Buzina', has_artwork: true, updated_at_ms: 5 } : (() => { throw new SynkError('NOT_FOUND'); })())
    }, { visible: [ID, ID2, ID, 'not-a-uuid'] });
    await h.api.syncAll();
    assert.deepStrictEqual(h.calls.map(c => c.cmd).sort(), ['GET_AUDIO', 'GET_PLAYBACK', 'GET_SOUND', 'GET_SOUND', 'GET_STATUS']);
    assert.strictEqual(h.state.effects.volume, 0.8, 'f32 volume rounded on receipt');
    assert.strictEqual(h.state.effects.muted, false);
    assert.ok(h.state.isPlaying(ID));
    assert.ok(!h.state.isPlaying(ID2), 'preview voices are ignored');
    assert.strictEqual(h.state.soundName(ID), 'Buzina');
    assert.ok(h.state.isMissing(ID2));
    assert.strictEqual(h.state.engine.version, '0.1.0');
    assert.strictEqual(h.libraryChanged(), 1, 'an open picker is refreshed after a resync');
});

test('race rule: a PLAYBACK / AUDIO_STATUS event during GET_* wins over the older snapshot', async () => {
    let releasePlayback, releaseAudio;
    const h = harness({
        GET_PLAYBACK: () => new Promise(r => { releasePlayback = () => r({ voices: [{ sound_id: ID, kind: 'sound' }] }); }),
        GET_AUDIO: () => new Promise(r => { releaseAudio = () => r({ effects_volume: 0.5, effects_muted: true }); }),
        GET_STATUS: {}
    });
    const sync = h.api.syncAll();
    await sleep(5);
    h.api.handleEvent('PLAYBACK', { voices: [] });
    h.api.handleEvent('AUDIO_STATUS', { effects_volume: 1.2, effects_muted: false });
    releasePlayback(); releaseAudio();
    await sync;
    assert.ok(!h.state.isPlaying(ID), 'stale GET_PLAYBACK discarded');
    assert.strictEqual(h.state.effects.volume, 1.2, 'stale GET_AUDIO discarded');
    assert.strictEqual(h.state.effects.muted, false);
});

test('race rule also applies to SET_MUTE\'s AudioInfo result', async () => {
    let release;
    const h = harness({ SET_MUTE: () => new Promise(r => { release = () => r({ effects_muted: true, effects_volume: 0.8 }); }) });
    const p = h.api.setEffectsMuted(true);
    await sleep(5);
    h.api.handleEvent('AUDIO_STATUS', { effects_muted: false, effects_volume: 0.8 }); // e.g. the UI unmuted right after
    release();
    await p;
    assert.strictEqual(h.state.effects.muted, false);
});

test('SET_MUTE preserves the volume and the result updates state; UNKNOWN_COMMAND marks mute unavailable', async () => {
    const h = harness({ SET_MUTE: p => ({ effects_muted: p.muted, effects_volume: 0.800000011920929 }) });
    h.api.handleEvent('AUDIO_STATUS', { effects_volume: 0.8, effects_muted: false });
    await h.api.setEffectsMuted(true);
    assert.deepStrictEqual(h.state.effects, { volume: 0.8, muted: true });
    assert.ok(!h.calls.some(c => c.cmd === 'SET_VOLUME'), 'mute never writes the volume');

    const old = harness({ SET_MUTE: new SynkError('UNKNOWN_COMMAND') });
    await assert.rejects(old.api.setEffectsMuted(true), e => e.code === 'UNKNOWN_COMMAND');
    assert.strictEqual(old.state.muteSupported, false);
});

test('events: PLAYBACK replaces the set (sound voices only, counted), unknown events ignored', () => {
    const h = harness();
    h.api.handleEvent('PLAYBACK', { voices: [{ sound_id: ID, kind: 'sound' }, { sound_id: ID, kind: 'sound' }, { sound_id: ID2, kind: 'preview' }] });
    assert.strictEqual(h.state.voiceCount, 2);
    h.api.handleEvent('PLAYBACK', { voices: [] });
    assert.strictEqual(h.state.voiceCount, 0);
    for (const name of ['AUDIO_LEVELS', 'IMPORT_UPDATED', 'STATUS', 'SOMETHING_NEW']) h.api.handleEvent(name, { x: 1 });
    h.api.handleEvent('PLAYBACK', { nope: true });       // malformed: ignored
    h.api.handleEvent('AUDIO_STATUS', 'garbage');
    assert.strictEqual(h.calls.length, 0);
});

test('LIBRARY_CHANGED is debounced (>= 500 ms) into one GET_SOUND per visible sound + picker refresh', async () => {
    const h = harness({ GET_SOUND: p => ({ id: p.sound_id, name: 'Renomeado', has_artwork: false }) }, { visible: [ID] });
    for (let i = 0; i < 5; i++) h.api.handleEvent('LIBRARY_CHANGED');
    await sleep(300);
    assert.strictEqual(h.calls.length, 0, 'nothing before the debounce');
    await sleep(450);
    assert.deepStrictEqual(h.calls.map(c => c.cmd), ['GET_SOUND']);
    assert.strictEqual(h.state.soundName(ID), 'Renomeado');
    assert.strictEqual(h.libraryChanged(), 1);
});

test('SHUTTING_DOWN asks the supervisor to reconnect after 1 s', () => {
    const h = harness();
    h.api.handleEvent('SHUTTING_DOWN');
    assert.strictEqual(h.supervisor.reconnectAfterMs, 1000);
});

test('listSounds pages with offset/limit until total, keeps only id+name, drops invalid entries', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Som ${i}`, original_name: 'x.wav' }));
    all.push({ id: 'C:\\evil.wav', name: 'bad' });
    const h = harness({ GET_LIBRARY: p => ({ sounds: all.slice(p.offset, p.offset + p.limit), total: all.length }) });
    const list = await h.api.listSounds();
    assert.deepStrictEqual(h.calls.map(c => c.params), [{ limit: 1000, offset: 0 }, { limit: 1000, offset: 1000 }, { limit: 1000, offset: 2000 }]);
    assert.strictEqual(list.length, 2500);
    assert.deepStrictEqual(Object.keys(list[0]), ['id', 'name']);
});

test('artwork: fetched only when has_artwork; NOT_FOUND or bad mime -> null; data URL otherwise', async () => {
    const h = harness({ GET_ARTWORK: p => (p.sound_id === ID ? { mime: 'image/png', data_base64: 'iVBOR' } : { mime: 'text/html', data_base64: 'x' }) });
    assert.strictEqual(await h.api.getArtwork(ID), null, 'unknown sound: no call');
    assert.strictEqual(h.calls.length, 0);
    h.state.upsertSound({ id: ID, name: 'a', hasArtwork: true });
    h.state.upsertSound({ id: ID2, name: 'b', hasArtwork: true });
    assert.strictEqual(await h.api.getArtwork(ID), 'data:image/png;base64,iVBOR');
    assert.strictEqual(await h.api.getArtwork(ID2), null);
    const nf = harness({ GET_ARTWORK: new SynkError('NOT_FOUND') });
    nf.state.upsertSound({ id: ID, name: 'a', hasArtwork: true });
    assert.strictEqual(await nf.api.getArtwork(ID), null);
});
