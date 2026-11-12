// End to end: simulated StreamDock host -> real plugin process -> engine double over a real
// named pipe. Covers the seven actions, the sound picker, live visual state, errors, and
// SYNK closing / opening / crashing / restarting with a new token.

const test = require('node:test');
const assert = require('node:assert');
const Jimp = require('jimp');
const { FakeEngine } = require('./helpers/fakeEngine');
const { startPlugin, A, runtime } = require('./helpers/hostHarness');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function redPng() {
    const b64 = await new Jimp(64, 64, 0xff0000ff).getBase64Async(Jimp.MIME_PNG);
    return b64.replace('data:image/png;base64,', '');
}

test(`all seven actions, picker and live state [${runtime}]`, { timeout: 60000 }, async () => {
    const engine = new FakeEngine();
    const a = engine.addSound('Aplausos', { has_artwork: true, artwork_b64: await redPng() });
    const b = engine.addSound('Buzina');
    await engine.start();
    const host = await startPlugin({ dataDir: engine.dataDir });
    try {
        host.appear(A.play, 'cPlay', { soundId: a.id, soundName: 'Aplausos', mode: 'restart' });
        host.appear(A.toggle, 'cToggle', { soundId: b.id, soundName: 'Buzina' });
        host.appear(A.stop, 'cStop', { soundId: a.id, soundName: 'Aplausos' });
        host.appear(A.stopall, 'cAll');
        host.appear(A.mute, 'cMute');
        host.appear(A.volume, 'cVol', { step: 5 });
        host.appear(A.status, 'cStatus');

        // SYNCING: snapshot + one GET_SOUND per configured sound + artwork for the one that has it
        await engine.waitFor(() => engine.requestsOf('GET_AUDIO').length && engine.requestsOf('GET_PLAYBACK').length && engine.requestsOf('GET_STATUS').length, 8000);
        await engine.waitFor(() => engine.requestsOf('GET_SOUND').map(r => r.params.sound_id).includes(b.id));
        await engine.waitFor(() => engine.requestsOf('GET_ARTWORK').length === 1);
        assert.deepStrictEqual(engine.requestsOf('GET_ARTWORK')[0].params, { sound_id: a.id });
        for (const c of ['cPlay', 'cToggle', 'cStop', 'cAll', 'cMute', 'cVol', 'cStatus']) {
            await host.waitFor(() => host.images(c).length, 5000, `image for ${c}`);
        }
        const hello = engine.frames.find(f => f.type === 'hello');
        assert.ok(hello && !('token' in hello) && hello.client === 'plugin');

        // 1. Play (keyDown fires; the keyUp of the same press does not fire again)
        const playIdle = await host.settled('cPlay');
        const allIdle = await host.settled('cAll');
        host.press(A.play, 'cPlay');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').length === 1);
        await sleep(200);
        assert.strictEqual(engine.requestsOf('PLAY_SOUND').length, 1, 'one press = one PLAY_SOUND');
        assert.deepStrictEqual(engine.requestsOf('PLAY_SOUND')[0].params, { sound_id: a.id, mode: 'restart' });
        // 2. Live visual state from PLAYBACK: green border on the key, counter on Stop All
        await host.nextImage('cPlay', playIdle);
        await host.nextImage('cAll', allIdle);

        // 3. Play/Stop: toggle decided by the engine
        host.press(A.toggle, 'cToggle');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').length === 2);
        assert.deepStrictEqual(engine.requestsOf('PLAY_SOUND')[1].params, { sound_id: b.id, mode: 'toggle' });
        await engine.waitFor(() => engine.playing.some(v => v.sound_id === b.id));
        await sleep(100);
        host.press(A.toggle, 'cToggle');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').length === 3);
        await engine.waitFor(() => !engine.playing.some(v => v.sound_id === b.id));

        // 4. Stop one sound
        host.press(A.stop, 'cStop');
        await engine.waitFor(() => engine.requestsOf('STOP_SOUND').length === 1);
        assert.deepStrictEqual(engine.requestsOf('STOP_SOUND')[0].params, { sound_id: a.id });
        assert.strictEqual(await host.settled('cPlay'), playIdle, 'play key back to its idle still (exact bytes)');

        // 5. Stop all
        host.press(A.play, 'cPlay');
        await engine.waitFor(() => engine.playing.length === 1);
        await sleep(100);
        host.press(A.stopall, 'cAll');
        await engine.waitFor(() => engine.requestsOf('STOP_ALL').length === 1);
        assert.strictEqual(engine.requestsOf('STOP_ALL')[0].params, undefined);
        await engine.waitFor(() => engine.playing.length === 0);

        // 6. Mute effects: separate flag, volume untouched
        const muteBefore = host.lastImage('cMute');
        host.press(A.mute, 'cMute');
        await engine.waitFor(() => engine.requestsOf('SET_MUTE').length === 1);
        assert.deepStrictEqual(engine.requestsOf('SET_MUTE')[0].params, { target: 'effects', muted: true });
        await host.nextImage('cMute', muteBefore);
        await sleep(100);
        host.press(A.mute, 'cMute');
        await engine.waitFor(() => engine.requestsOf('SET_MUTE').length === 2);
        assert.strictEqual(engine.requestsOf('SET_MUTE')[1].params.muted, false);
        assert.strictEqual(engine.requestsOf('SET_VOLUME').length, 0, 'mute never writes the volume');
        assert.strictEqual(Math.round(engine.audio.effects_volume * 100), 80);

        // 7. Knob: fast spin past 200 %, coalesced, final value clamped to 2.0
        for (let i = 0; i < 40; i++) host.send({ event: 'dialRotate', action: A.volume, context: 'cVol', device: 'dev', payload: { ticks: 1, pressed: false, settings: {} } });
        await engine.waitFor(() => Math.abs(engine.audio.effects_volume - 2) < 1e-6, 5000);
        await sleep(300);
        const sets = engine.requestsOf('SET_VOLUME');
        assert.ok(sets.length < 40, `coalesced: ${sets.length} SET_VOLUME for 40 ticks`);
        assert.ok(sets.every(s => s.params.volume <= 2 && s.params.target.kind === 'effects'));
        assert.strictEqual(sets[sets.length - 1].params.volume, 2);
        for (let i = 0; i < 5; i++) host.send({ event: 'dialRotate', action: A.volume, context: 'cVol', device: 'dev', payload: { ticks: -1, pressed: false, settings: {} } });
        await engine.waitFor(() => Math.abs(engine.audio.effects_volume - 1.75) < 1e-6, 5000);
        // knob press = mute toggle
        host.send({ event: 'dialDown', action: A.volume, context: 'cVol', device: 'dev', payload: { settings: {} } });
        await engine.waitFor(() => engine.requestsOf('SET_MUTE').length === 3);
        assert.strictEqual(engine.requestsOf('SET_MUTE')[2].params.muted, true);
        await engine.waitFor(() => engine.audio.effects_muted === true);
        assert.strictEqual(Math.round(engine.audio.effects_volume * 100), 175, 'mute preserved the volume');

        // 8. Status key: press refreshes GET_STATUS
        const statusCalls = engine.requestsOf('GET_STATUS').length;
        host.press(A.status, 'cStatus');
        await engine.waitFor(() => engine.requestsOf('GET_STATUS').length === statusCalls + 1);

        // 9. Sound picker: list from GET_LIBRARY, choose stores only the id (+ name label)
        host.send({ event: 'propertyInspectorDidAppear', action: A.play, context: 'cPlay', device: 'dev' });
        host.send({ event: 'sendToPlugin', action: A.play, context: 'cPlay', payload: { type: 'getSounds' } });
        const reply = await host.waitFor(() => host.ofEvent('sendToPropertyInspector', 'cPlay')[0]);
        assert.strictEqual(reply.payload.connection, 'connected');
        assert.deepStrictEqual(reply.payload.sounds, [{ id: a.id, name: 'Aplausos' }, { id: b.id, name: 'Buzina' }]);
        host.send({ event: 'sendToPlugin', action: A.play, context: 'cPlay', payload: { type: 'setSound', soundId: b.id, soundName: 'Buzina' } });
        const saved = await host.waitFor(() => host.ofEvent('setSettings', 'cPlay')[0]);
        assert.deepStrictEqual(saved.payload, { soundId: b.id, soundName: 'Buzina', mode: 'restart' });
        host.send({ event: 'sendToPlugin', action: A.play, context: 'cPlay', payload: { type: 'setSound', soundId: 'C:\\Windows\\media\\x.wav', soundName: 'x' } });
        await sleep(200);
        assert.strictEqual(host.ofEvent('setSettings', 'cPlay').length, 1, 'a path is never stored');
        host.press(A.play, 'cPlay');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').some(r => r.params.sound_id === b.id && r.params.mode === 'restart'));

        // 10. Library change while the picker is open: debounced re-list pushed to the panel
        engine.addSound('Corneta');
        const replies = host.ofEvent('sendToPropertyInspector', 'cPlay').length;
        engine.broadcast({ type: 'event', event: 'LIBRARY_CHANGED' });
        const pushed = await host.waitFor(() => host.ofEvent('sendToPropertyInspector', 'cPlay').length > replies && host.ofEvent('sendToPropertyInspector', 'cPlay').slice(-1)[0], 3000);
        assert.strictEqual(pushed.payload.sounds.length, 3);

        // 11. Deleted sound: NOT_FOUND -> persistent "Som removido" label on the key
        engine.sounds = engine.sounds.filter(s => s.id !== b.id);
        const beforeDelete = host.lastImage('cToggle');
        host.press(A.toggle, 'cToggle');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').filter(r => r.params.sound_id === b.id && r.params.mode === 'toggle').length === 3);
        await host.nextImage('cToggle', beforeDelete);

        // 12. Unknown and noisy events are ignored without logging
        for (let i = 0; i < 50; i++) engine.broadcast({ type: 'event', event: 'AUDIO_LEVELS', data: { effects: 0.1 } });
        engine.broadcast({ type: 'event', event: 'SOMETHING_NEW', data: {} });
        await sleep(200);
        assert.ok(!/AUDIO_LEVELS|SOMETHING_NEW/.test(host.logs()), 'noise not logged');

        // 13. No secret ever reaches the logs or the host
        const everything = host.logs() + JSON.stringify(host.received);
        assert.ok(!everything.includes(engine.token), 'token never logged or sent to the host');
        assert.ok(!everything.includes(hello.client_nonce), 'nonce never logged');
    } finally {
        await host.stop();
        await engine.stop({ clean: false });
        engine.cleanup();
    }
});

test(`SYNK closed at start, opened later, quit, crashed and restarted with a new token [${runtime}]`, { timeout: 60000 }, async () => {
    const engine = new FakeEngine();
    const s = engine.addSound('Aplausos');
    const host = await startPlugin({ dataDir: engine.dataDir });
    try {
        host.appear(A.play, 'cPlay', { soundId: s.id, soundName: 'Aplausos', mode: 'overlap' });
        host.appear(A.status, 'cStatus');
        const offline = await host.waitFor(() => host.lastImage('cPlay'), 5000, 'offline image');
        const statusOffline = host.lastImage('cStatus');

        // Pressing while SYNK is closed: nothing sent anywhere, error flash on the key
        host.press(A.play, 'cPlay');
        await host.nextImage('cPlay', offline);
        assert.strictEqual(engine.requests.length, 0);

        // 1. SYNK opens: the plugin finds it by itself (no key pressed)
        await sleep(2000);
        await engine.start();
        await engine.waitFor(() => engine.requestsOf('GET_AUDIO').length === 1, 8000);
        await host.nextImage('cStatus', statusOffline);
        const tokenA = engine.token;

        // 2. SYNK quits normally: SHUTTING_DOWN -> offline, then waits >= 1 s before retrying
        const statusOnline = host.lastImage('cStatus');
        await engine.stop({ clean: true });
        const t0 = Date.now();
        await host.nextImage('cStatus', statusOnline);
        await engine.start(); // new token
        assert.notStrictEqual(engine.token, tokenA);
        await engine.waitFor(() => engine.requestsOf('GET_AUDIO').length === 2, 10000);
        assert.ok(Date.now() - t0 >= 900, 'waited ~1 s after SHUTTING_DOWN');
        const hellos = engine.frames.filter(f => f.type === 'hello');
        assert.ok(hellos.length >= 2 && hellos[hellos.length - 1].client_nonce !== hellos[0].client_nonce, 'new nonce per connection');

        // 3. Works after the reconnection
        host.press(A.play, 'cPlay');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').length === 1);

        // 4. Crash: files left behind, pipe gone -> offline; restart -> back with a new token
        const beforeCrash = host.lastImage('cStatus');
        await engine.stop({ clean: false });
        await host.nextImage('cStatus', beforeCrash);
        await sleep(1500);
        await engine.start();
        await engine.waitFor(() => engine.requestsOf('GET_AUDIO').length === 3, 10000);
        host.press(A.play, 'cPlay');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').length === 2);

        // 5. Never more than one connection
        assert.ok(engine.sockets.size <= 1, `open connections: ${engine.sockets.size}`);
    } finally {
        await host.stop();
        await engine.stop({ clean: false });
        engine.cleanup();
    }
});

test(`a stuck key does not block the others; PLAY_SOUND is never retried [${runtime}]`, { timeout: 30000 }, async () => {
    const engine = new FakeEngine();
    const a = engine.addSound('Lento');
    const b = engine.addSound('Rapido');
    engine.handlers.PLAY_SOUND = (() => {
        const original = engine.handlers.PLAY_SOUND;
        return async (p, ctx) => {
            if (p.sound_id === a.id) await new Promise(() => {}); // never answers
            return original(p, ctx);
        };
    })();
    await engine.start();
    const host = await startPlugin({ dataDir: engine.dataDir });
    try {
        host.appear(A.play, 'cSlow', { soundId: a.id, soundName: 'Lento' });
        host.appear(A.play, 'cFast', { soundId: b.id, soundName: 'Rapido' });
        await engine.waitFor(() => engine.requestsOf('GET_AUDIO').length, 8000);
        await sleep(300);
        host.press(A.play, 'cSlow');
        host.press(A.play, 'cSlow'); // second press while the first is stuck: ignored
        await sleep(100);
        host.press(A.play, 'cFast');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').some(r => r.params.sound_id === b.id), 2000);
        // "Sem resposta" flash + shake after the 5 s PLAY_SOUND timeout
        await host.waitFor(() => /key cSlow: TIMEOUT/.test(host.logs()), 8000, 'slow key timed out');
        const before = host.lastImage('cSlow');
        await host.nextImage('cSlow', before, 3000);
        await sleep(500);
        assert.strictEqual(engine.requestsOf('PLAY_SOUND').filter(r => r.params.sound_id === a.id).length, 1, 'never retried');
    } finally {
        await host.stop();
        await engine.stop({ clean: false });
        engine.cleanup();
    }
});

// The bug reported on the device: a key with an image uploaded in Rise Mode went back to the
// plugin's default look as soon as it was pressed. The user's image must stay the base of every
// frame (press, playing glow, stop), and a new image saved in the profile must show up live.
test(`custom key image from the Rise Mode profile survives presses and playback [${runtime}]`, { timeout: 60000 }, async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const R = require('../raster');
    const engine = new FakeEngine();
    const s = engine.addSound('Fah', { has_artwork: true, artwork_b64: await redPng() }); // SYNK artwork must NOT win
    await engine.start();
    const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'synk-prof-'));
    const prof = path.join(profiles, '4WTXKNWC-Q0G4-VQ04-45E1-800TGF286393.sdProfile');
    fs.mkdirSync(path.join(prof, 'Images'), { recursive: true });
    const writeProfile = image => fs.writeFileSync(path.join(prof, 'manifest.json'), JSON.stringify({
        DeviceUUID: 'ControllerDeviceS2',
        Actions: { '2,0': { UUID: A.play, Settings: { soundId: s.id, soundName: 'Fah', mode: 'overlap' }, State: 0, States: [{ Image: image }] } }
    }));
    fs.writeFileSync(path.join(prof, 'Images', 'BLUE0000000000000000000000.png'), await new Jimp(300, 300, 0x0000ffff).getBufferAsync(Jimp.MIME_PNG));
    writeProfile('BLUE0000000000000000000000.png');
    const center = uri => { const r = R.decodeJpeg(uri.replace('data:image/jpeg;base64,', '')); const o = (63 * 126 + 63) * 4; return [r[o], r[o + 1], r[o + 2]]; };
    const isBlue = ([r, g, b]) => b > 180 && r < 60 && g < 60;

    const host = await startPlugin({ dataDir: engine.dataDir, env: { SYNK_PROFILES_DIR: profiles } });
    try {
        host.appear(A.play, 'cFah', { soundId: s.id, soundName: 'Fah', mode: 'overlap' }, { column: 2, row: 0 });
        await engine.waitFor(() => engine.requestsOf('GET_AUDIO').length, 8000);
        const idle = await host.settled('cFah', 500);
        assert.ok(isBlue(center(idle)), `idle shows the user's image, got ${center(idle)}`);

        host.press(A.play, 'cFah');
        await engine.waitFor(() => engine.requestsOf('PLAY_SOUND').length === 1);
        await host.waitFor(() => host.images('cFah').length > 20, 5000, 'press + glow frames');
        const during = host.images('cFah').slice(-5);
        assert.ok(during.every(f => center(f)[2] > center(f)[0]), 'still the blue image while playing');

        await engine.handlers.STOP_ALL();
        engine.broadcast({ type: 'event', event: 'PLAYBACK', data: { voices: [] } });
        const after = await host.settled('cFah', 500);
        assert.strictEqual(after, idle, 'back to exactly the user image after playing');

        // the user uploads another image in Rise Mode: the key follows without a restart
        fs.writeFileSync(path.join(prof, 'Images', 'GREEN000000000000000000000.png'), await new Jimp(300, 300, 0x00ff00ff).getBufferAsync(Jimp.MIME_PNG));
        writeProfile('GREEN000000000000000000000.png');
        await host.waitFor(() => { const c = center(host.lastImage('cFah')); return c[1] > 180 && c[2] < 60; }, 5000, 'new custom image shown');
        assert.ok(!host.received.some(m => m.event === 'setTitle'), 'the plugin never writes the title');
    } finally {
        await host.stop();
        await engine.stop({ clean: false });
        engine.cleanup();
        fs.rmSync(profiles, { recursive: true, force: true });
    }
});
