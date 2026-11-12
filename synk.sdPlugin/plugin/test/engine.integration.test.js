// Integration against the REAL synk-engine.exe (simulated audio device, isolated data
// directory under %TEMP% via SYNK_DATA_DIR — the development override documented in
// STREAM_DECK_INTEGRATION.md 2.2). Skipped when the binary is not available.
//
//   SYNK_ENGINE_EXE   path to synk-engine.exe (default D:\synk\target\debug\synk-engine.exe)
//
// The harness opens one extra connection as a "ui" client ONLY to import test WAVs and to
// send SHUTDOWN, because the plugin scope cannot do either. Plugin code never does this.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const t = require('../synk/transport');
const { Supervisor } = require('../synk/supervisor');
const { SynkState } = require('../synk/state');
const { createApi } = require('../synk/api');
const { startPlugin, A, runtime } = require('./helpers/hostHarness');

const ENGINE = process.env.SYNK_ENGINE_EXE || 'D:\\synk\\target\\debug\\synk-engine.exe';
const available = fs.existsSync(ENGINE);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(pred, ms, label) {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await pred();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
        await sleep(50);
    }
}

function writeWav(file, seconds, freq) {
    const rate = 48000, n = rate * seconds;
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 8000), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([h, data]));
}

class Engine {
    constructor(dataDir) { this.dataDir = dataDir; this.suffix = `t${crypto.randomBytes(4).toString('hex')}`; }
    async start() {
        this.child = spawn(ENGINE, [], {
            env: { ...process.env, SYNK_DATA_DIR: this.dataDir, SYNK_PIPE_SUFFIX: this.suffix, SYNK_AUDIO_BACKEND: 'sim', SYNK_LOG: 'warn' },
            stdio: 'ignore'
        });
        this.exited = new Promise(r => this.child.once('exit', r));
        await until(() => { try { return t.readDiscovery(this.dataDir); } catch { return null; } }, 20000, 'ipc.json');
    }
    kill() { this.child.kill(); return this.exited; }
}

// Test-harness "ui" client (challenge mode is available to any client kind).
async function openUi(dataDir) {
    const info = t.readDiscovery(dataDir);
    const key = t.readKey(dataDir);
    const sock = net.connect(info.pipe);
    const cn = crypto.randomBytes(32).toString('hex');
    const pending = new Map();
    let id = 1;
    await new Promise((resolve, reject) => {
        sock.on('connect', () => sock.write(t.encodeFrame({ type: 'hello', protocol: 1, client: 'ui', client_name: 'synk-plugin-tests', auth: 'hmac-sha256', client_nonce: cn })));
        sock.on('error', reject);
        sock.on('data', t.frameReader(msg => {
            if (msg.type === 'challenge') {
                assert.strictEqual(msg.server_proof, t.serverProof(key, cn, msg.server_nonce));
                sock.write(t.encodeFrame({ type: 'auth', client_proof: t.clientProof(key, 'ui', cn, msg.server_nonce) }));
            } else if (msg.type === 'welcome') resolve();
            else if (msg.type === 'response') {
                const p = pending.get(msg.id);
                if (!p) return reject(new Error(`ui handshake failed: ${JSON.stringify(msg.error)}`));
                pending.delete(msg.id);
                msg.ok ? p.res(msg.result) : p.rej(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
            }
        }, reject));
    });
    return {
        request(cmd, params) {
            const n = id++;
            return new Promise((res, rej) => { pending.set(n, { res, rej }); sock.write(t.encodeFrame({ type: 'request', id: n, cmd, ...(params && { params }) })); });
        },
        close() { sock.destroy(); }
    };
}

async function importWavs(ui, files) {
    const jobs = await ui.request('IMPORT_FILES', { paths: files });
    const ids = jobs.map(j => j.id);
    const done = await until(async () => {
        const all = await ui.request('LIST_IMPORTS');
        const mine = all.filter(j => ids.includes(j.id) && j.outcome);
        return mine.length === ids.length && mine;
    }, 60000, 'imports');
    return done.map(j => { assert.strictEqual(j.outcome.kind, 'imported', JSON.stringify(j.outcome)); return j.outcome.sound; });
}

test('plugin vs. the real SYNK engine: contract end to end', { skip: !available && `engine not found at ${ENGINE}`, timeout: 180000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synk-it-'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    const engine = new Engine(dataDir);
    let sup, host;
    try {
        await engine.start();
        const ui = await openUi(dataDir);
        const wavA = path.join(root, 'aplausos.wav'), wavB = path.join(root, 'buzina.wav');
        writeWav(wavA, 4, 440); writeWav(wavB, 4, 660);
        const [a, b] = await importWavs(ui, [wavA, wavB]);
        assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

        // ---- plugin side: transport + supervisor + api + state, exactly as runtime.js wires them
        const state = new SynkState();
        const events = [];
        const lines = [];
        const log = { info: (...x) => lines.push(x.join(' ')), warn: (...x) => lines.push(x.join(' ')), error: (...x) => lines.push(x.join(' ')) };
        sup = new Supervisor({ log, openSession: h => t.openSession({ ...h, dataDir }) });
        const api = createApi({ supervisor: sup, state, log, visibleSoundIds: () => [a.id, b.id] });
        sup.on('state', (s, e) => { state.setConnection(s, e); if (s === 'connected') api.syncAll(); });
        sup.on('event', (n, d) => { events.push(n); api.handleEvent(n, d); });
        sup.start();
        await until(() => sup.connected, 10000, 'connected');
        await until(() => state.effects.volume !== null && state.soundName(b.id), 5000, 'synced');
        assert.strictEqual(state.soundName(a.id), a.name);
        await until(async () => (await sup.call('GET_AUDIO')).state === 'running', 15000, 'audio running');

        // library for the picker
        const list = await api.listSounds();
        assert.deepStrictEqual(list.map(s => s.id).sort(), [a.id, b.id].sort());

        // play / live PLAYBACK / restart / toggle / stop / stop all
        await api.playSound(a.id, 'overlap');
        await until(() => state.isPlaying(a.id), 3000, 'PLAYBACK event: a playing');
        await api.playSound(a.id, 'overlap');
        await until(() => state.playing.get(a.id) === 2, 3000, 'two voices');
        const restarted = await api.playSound(a.id, 'restart');
        assert.strictEqual(restarted.stopped, 2);
        await api.toggleSound(b.id);
        await until(() => state.isPlaying(b.id), 3000, 'toggle on');
        const off = await api.toggleSound(b.id);
        assert.strictEqual(off.voice_id, null);
        await until(() => !state.isPlaying(b.id), 3000, 'toggle off');
        assert.strictEqual((await api.stopSound(a.id)).stopped, 1);
        await api.playSound(a.id, 'overlap');
        await api.playSound(b.id, 'overlap');
        await until(() => state.voiceCount === 2, 3000, 'two sounds');
        assert.strictEqual((await api.stopAll()).stopped, 2);
        await until(() => state.voiceCount === 0, 3000, 'all stopped');

        // volume 0..200 % and mute preserving the volume
        await api.setEffectsVolume(2.0);
        await until(() => state.effects.volume === 2, 3000, 'AUDIO_STATUS 2.0');
        await api.setEffectsVolume(0.8);
        await until(() => state.effects.volume === 0.8, 3000, 'AUDIO_STATUS 0.8 (rounded from f32)');
        await api.setEffectsMuted(true);
        await until(() => state.effects.muted === true, 3000, 'muted');
        assert.strictEqual(state.effects.volume, 0.8, 'mute kept the volume');
        await api.setEffectsVolume(1.25);
        await until(() => state.effects.volume === 1.25, 3000, 'volume while muted');
        assert.strictEqual(state.effects.muted, true, 'still muted after SET_VOLUME');
        await api.setEffectsMuted(false);
        await until(() => state.effects.muted === false, 3000, 'unmuted');
        assert.strictEqual(state.effects.volume, 1.25);

        // errors from the real engine
        await assert.rejects(sup.call('IMPORT_FILES', { paths: [wavA] }), e => e.code === 'FORBIDDEN');
        await assert.rejects(sup.call('PLAY_SOUND', { sound_id: 'C:\\x.wav' }), e => e.code === 'INVALID_PARAMS');
        await assert.rejects(sup.call('SET_VOLUME', { target: { kind: 'effects' }, volume: 2.5 }), e => e.code === 'INVALID_PARAMS');
        const ghost = crypto.randomUUID();
        await assert.rejects(api.playSound(ghost, 'overlap'), e => e.code === 'NOT_FOUND');
        assert.ok(state.isMissing(ghost));
        assert.strictEqual(await api.getArtwork(a.id), null, 'no artwork -> no request, null');

        // ---- the real plugin process (host simulated) against the real engine
        host = await startPlugin({ dataDir });
        host.appear(A.play, 'cPlay', { soundId: a.id, soundName: a.name, mode: 'overlap' });
        host.appear(A.mute, 'cMute');
        host.appear(A.status, 'cStatus');
        await host.waitFor(() => host.images('cPlay').length && host.images('cStatus').length, 10000, 'keys rendered');
        await sleep(1500); // let the plugin connect and sync
        const idle = host.lastImage('cPlay');
        host.press(A.play, 'cPlay');
        await until(async () => (await ui.request('GET_PLAYBACK')).voices.some(v => v.sound_id === a.id), 5000, 'deck press played the sound');
        await host.nextImage('cPlay', idle);
        host.press(A.mute, 'cMute');
        await until(async () => (await ui.request('GET_AUDIO')).effects_muted === true, 5000, 'deck press muted');
        host.press(A.mute, 'cMute');
        await until(async () => (await ui.request('GET_AUDIO')).effects_muted === false, 5000, 'deck press unmuted');
        assert.strictEqual(Math.round((await ui.request('GET_AUDIO')).effects_volume * 100), 125);
        await ui.request('STOP_ALL');

        // ---- SYNK quits: SHUTTING_DOWN, files removed, NOT_RUNNING
        const statusOnline = host.lastImage('cStatus');
        await ui.request('SHUTDOWN');
        await engine.exited;
        await until(() => sup.state === 'offline', 5000, 'offline after shutdown');
        assert.ok(events.includes('SHUTTING_DOWN'));
        assert.ok(!fs.existsSync(path.join(dataDir, 'ipc.json')), 'ipc.json removed at shutdown');
        await host.nextImage('cStatus', statusOnline, 5000);
        await until(() => sup.lastError?.code === 'NOT_RUNNING', 8000, 'NOT_RUNNING while closed');

        // ---- SYNK starts again (new token): both reconnect by themselves
        const statusOffline = host.lastImage('cStatus');
        await engine.start();
        await until(() => sup.connected, 10000, 'reconnected after restart');
        await host.nextImage('cStatus', statusOffline, 10000);
        await api.playSound(a.id, 'overlap');
        await sup.call('STOP_ALL');

        // ---- crash: killed engine, stale files left behind -> offline -> restart -> back
        await engine.kill();
        await until(() => sup.state === 'offline', 8000, 'offline after crash');
        await engine.start();
        await until(() => sup.connected, 10000, 'reconnected after crash');
        assert.strictEqual(state.soundName(a.id), a.name, 'resynced');

        // secrets never logged
        const token = fs.readFileSync(path.join(dataDir, 'ipc.token'), 'utf8').trim();
        assert.ok(!lines.join('\n').includes(token));
        assert.ok(!host.logs().includes(token));
        ui.close();
    } finally {
        sup?.stop();
        await host?.stop();
        if (engine.child && engine.child.exitCode === null) await engine.kill();
        await sleep(200);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

module.exports = { runtime };
