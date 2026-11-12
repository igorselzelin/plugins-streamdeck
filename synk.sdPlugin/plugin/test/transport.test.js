// transport.js against the contract: test vector, discovery validation, challenge
// handshake (incl. squatter), framing, requests, events, timeouts and secret hygiene.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../synk/transport');
const { FakeEngine, encode } = require('./helpers/fakeEngine');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'synk-disc-'));
}

// Collects everything logged, to prove secrets never appear.
function capturingLog() {
    const lines = [];
    const rec = (...a) => lines.push(a.join(' '));
    return { lines, info: rec, warn: rec, error: rec };
}

async function withEngine(fn, setup) {
    const e = new FakeEngine();
    if (setup) setup(e);
    await e.start();
    try { return await fn(e); } finally { await e.stop({ clean: false }); e.cleanup(); }
}

// ---------------------------------------------------------------- crypto

test('HMAC proofs match the contract test vector (section 3.2)', () => {
    const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    const cn = '11'.repeat(32), sn = '22'.repeat(32);
    assert.strictEqual(t.serverProof(key, cn, sn), '98e1cf6be170ec27b110b258b05d9761fded3337835c7ae98655359a9a53038e');
    assert.strictEqual(t.clientProof(key, 'plugin', cn, sn), '915c81f29eb226ca6f7f8269e108944e4a921a6a64b39d4966756ffc568aefe6');
});

// ---------------------------------------------------------------- discovery

test('discovery: missing ipc.json means SYNK is not running', () => {
    assert.throws(() => t.readDiscovery(tmpDir()), e => e.code === 'NOT_RUNNING');
});

test('discovery: a half-written ipc.json is "not running yet", not an error', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'ipc.json'), '{"format":1,"pipe":');
    assert.throws(() => t.readDiscovery(d), e => e.code === 'NOT_RUNNING');
});

test('discovery: validation of format, pipe, auth, protocol and size', () => {
    const d = tmpDir();
    const write = o => fs.writeFileSync(path.join(d, 'ipc.json'), JSON.stringify({
        format: 1, pipe: '\\\\.\\pipe\\synk-engine-S-1-5-21-1-2-3-1001', protocol: 1, auth: ['token', 'hmac-sha256'], ...o
    }));
    write({});
    assert.strictEqual(t.readDiscovery(d).pipe, '\\\\.\\pipe\\synk-engine-S-1-5-21-1-2-3-1001');
    write({ unknown_future_field: { x: 1 } });
    assert.ok(t.readDiscovery(d), 'unknown fields are ignored');
    const bad = [
        [{ format: 2 }, 'INVALID_DISCOVERY'],
        [{ pipe: '\\\\evil-host\\pipe\\synk-engine-S-1-5-21-1' }, 'INVALID_DISCOVERY'], // remote pipe
        [{ pipe: '\\\\.\\pipe\\other-pipe' }, 'INVALID_DISCOVERY'],
        [{ pipe: '\\\\.\\pipe\\synk-engine-S-1-5-21-1\\..\\x' }, 'INVALID_DISCOVERY'],
        [{ pipe: '\\\\.\\pipe\\synk-engine-S-1-' + '1'.repeat(200) }, 'INVALID_DISCOVERY'],
        [{ pipe: 42 }, 'INVALID_DISCOVERY'],
        [{ auth: ['token'] }, 'INVALID_DISCOVERY'],
        [{ auth: 'hmac-sha256' }, 'INVALID_DISCOVERY'],
        [{ protocol: 2 }, 'VERSION_MISMATCH']
    ];
    for (const [o, code] of bad) {
        write(o);
        assert.throws(() => t.readDiscovery(d), e => e.code === code, JSON.stringify(o));
    }
    fs.writeFileSync(path.join(d, 'ipc.json'), ' '.repeat(5000));
    assert.throws(() => t.readDiscovery(d), e => e.code === 'INVALID_DISCOVERY');
});

test('token: 64 hex (any case, surrounding whitespace trimmed); anything else refused before decoding', () => {
    const d = tmpDir();
    const write = s => fs.writeFileSync(path.join(d, 'ipc.token'), s);
    write(`  ${'Ab'.repeat(32)}\r\n`);
    assert.strictEqual(t.readKey(d).length, 32);
    for (const s of ['zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), '', 'ab'.repeat(200)]) {
        write(s);
        assert.throws(() => t.readKey(d), e => e.code === 'INVALID_DISCOVERY', s.slice(0, 10));
    }
    fs.rmSync(path.join(d, 'ipc.token'));
    assert.throws(() => t.readKey(d), e => e.code === 'NOT_RUNNING');
});

test('stale ipc.json (engine crashed): ENOENT on the pipe is NOT_RUNNING', async () => {
    const e = new FakeEngine();
    e.writeDiscovery(); // files present, nothing listening
    await assert.rejects(t.openSession({ dataDir: e.dataDir }), err => err.code === 'NOT_RUNNING');
    e.cleanup();
});

// ---------------------------------------------------------------- handshake

test('challenge handshake: hello has no token, lowercase nonce, kind "plugin"; welcome opens the session', () =>
    withEngine(async e => {
        const log = capturingLog();
        const s = await t.openSession({ dataDir: e.dataDir, log });
        const hello = e.frames[0];
        assert.strictEqual(hello.type, 'hello');
        assert.strictEqual(hello.protocol, 1);
        assert.strictEqual(hello.client, 'plugin');
        assert.strictEqual(hello.auth, 'hmac-sha256');
        assert.match(hello.client_nonce, /^[0-9a-f]{64}$/);
        assert.ok(!('token' in hello));
        assert.ok(!JSON.stringify(e.frames).includes(e.token), 'the token never crosses the pipe');
        assert.strictEqual(e.frames[1].type, 'auth');
        assert.strictEqual(s.welcome.engine_version, e.version);
        assert.deepStrictEqual(await s.request('PING'), {});
        s.close();
        const secrets = [e.token, hello.client_nonce, e.frames[1].client_proof];
        for (const line of log.lines) for (const secret of secrets) assert.ok(!line.includes(secret), 'secret in log');
    }));

test('a new client nonce on every connection', () =>
    withEngine(async e => {
        const a = await t.openSession({ dataDir: e.dataDir });
        const b = await t.openSession({ dataDir: e.dataDir });
        const hellos = e.frames.filter(f => f.type === 'hello');
        assert.notStrictEqual(hellos[0].client_nonce, hellos[1].client_nonce);
        a.close(); b.close();
    }));

test('pipe squatter: a wrong server proof aborts BEFORE sending auth', () =>
    withEngine(async e => {
        const log = capturingLog();
        await assert.rejects(t.openSession({ dataDir: e.dataDir, log }), err => err.code === 'SERVER_PROOF_MISMATCH');
        await sleep(50);
        assert.deepStrictEqual(e.frames.map(f => f.type), ['hello'], 'nothing after hello');
        assert.ok(log.lines.some(l => l.includes('could not prove')));
        assert.ok(!log.lines.some(l => l.includes(e.token)));
    }, e => { e.proofMode = 'wrong'; }));

test('engine rejects the client proof: UNAUTHORIZED', () =>
    withEngine(async e => {
        await assert.rejects(t.openSession({ dataDir: e.dataDir }), err => err.code === 'UNAUTHORIZED');
    }, e => { e.acceptClientProof = false; }));

test('token rotated between reading and connecting: the next attempt re-reads it and succeeds', () =>
    withEngine(async e => {
        e.writeDiscovery({}, { token: 'ab'.repeat(32) }); // stale token on disk
        await assert.rejects(t.openSession({ dataDir: e.dataDir }), err => err.code === 'SERVER_PROOF_MISMATCH');
        e.writeDiscovery(); // the real one
        const s = await t.openSession({ dataDir: e.dataDir });
        s.close();
    }));

test('handshake that never completes times out after 3 s', () =>
    withEngine(async e => {
        const started = Date.now();
        await assert.rejects(t.openSession({ dataDir: e.dataDir }), err => err.code === 'TIMEOUT');
        assert.ok(Date.now() - started >= 2900);
    }, e => { e.proofMode = 'silent'; }));

test('welcome with another protocol version is refused', () =>
    withEngine(async e => {
        await assert.rejects(t.openSession({ dataDir: e.dataDir }), err => err.code === 'VERSION_MISMATCH');
    }, e => { e.welcomeProtocol = 2; }));

// ---------------------------------------------------------------- requests, events, framing

test('ids start at 1 and increase; params omitted when absent; responses matched out of order', () =>
    withEngine(async e => {
        e.delays.GET_AUDIO = 80;
        const s = await t.openSession({ dataDir: e.dataDir });
        const [audio, playback] = await Promise.all([s.request('GET_AUDIO'), s.request('STOP_ALL')]);
        assert.strictEqual(audio.effects_volume, 0.8);
        assert.deepStrictEqual(playback, { stopped: 0 });
        const reqs = e.frames.filter(f => f.type === 'request');
        assert.deepStrictEqual(reqs.map(r => r.id), [1, 2]);
        assert.ok(!('params' in reqs[1]));
        s.close();
    }));

test('engine errors keep their code; unknown codes become INTERNAL; FORBIDDEN outside the plugin scope', () =>
    withEngine(async e => {
        e.handlers.GET_STATUS = () => { throw { code: 'BRAND_NEW_CODE', message: 'x' }; };
        const s = await t.openSession({ dataDir: e.dataDir });
        await assert.rejects(s.request('GET_SOUND', { sound_id: '7dad22be-335c-402e-8cad-1e0355c3f4b7' }), err => err.code === 'NOT_FOUND');
        await assert.rejects(s.request('GET_STATUS'), err => err.code === 'INTERNAL');
        await assert.rejects(s.request('IMPORT_FILES', { paths: ['C:\\x.wav'] }), err => err.code === 'FORBIDDEN');
        s.close();
    }));

test('events are delivered; data absent for payload-less events', () =>
    withEngine(async e => {
        const events = [];
        const s = await t.openSession({ dataDir: e.dataDir, onEvent: (n, d) => events.push([n, d]) });
        e.broadcast({ type: 'event', event: 'LIBRARY_CHANGED' });
        e.broadcast({ type: 'event', event: 'PLAYBACK', data: { voices: [] } });
        await e.waitFor(() => events.length === 2);
        assert.deepStrictEqual(events, [['LIBRARY_CHANGED', undefined], ['PLAYBACK', { voices: [] }]]);
        s.close();
    }));

test('framing: partial and coalesced chunks, malformed JSON skipped, big frames accepted', () =>
    withEngine(async e => {
        const events = [];
        const s = await t.openSession({ dataDir: e.dataDir, onEvent: (n, d) => events.push(n) });
        const a = encode({ type: 'event', event: 'A' });
        const bad = encode('{not json');
        const b = encode({ type: 'event', event: 'B' });
        const big = encode({ type: 'event', event: 'BIG', data: { blob: 'x'.repeat(3 * 1024 * 1024) } });
        const all = Buffer.concat([a, bad, b, big]);
        for (const sock of e.sockets) {
            sock.write(all.subarray(0, 3));          // partial header
            await sleep(20);
            sock.write(all.subarray(3, a.length + 5)); // rest of A + part of the bad frame
            await sleep(20);
            sock.write(all.subarray(a.length + 5));  // everything else at once
        }
        await e.waitFor(() => events.length === 3);
        assert.deepStrictEqual(events, ['A', 'B', 'BIG']);
        assert.deepStrictEqual(await s.request('PING'), {}, 'connection survives a malformed frame');
        s.close();
    }));

test('a zero-length frame from the engine closes the connection', () =>
    withEngine(async e => {
        let closed = null;
        await t.openSession({ dataDir: e.dataDir, onClose: r => { closed = r; } });
        e.sendRaw(Buffer.alloc(4)); // length 0
        await e.waitFor(() => closed);
        assert.strictEqual(closed.code, 'BAD_FRAME');
    }));

test('client frames over 64 KiB are refused locally', () =>
    withEngine(async e => {
        const s = await t.openSession({ dataDir: e.dataDir });
        await assert.rejects(s.request('GET_LIBRARY', { search: 'x'.repeat(70 * 1024) }), err => err.code === 'BAD_FRAME');
        assert.deepStrictEqual(await s.request('PING'), {});
        s.close();
    }));

test('request timeout forgets the id; a late response is ignored', () =>
    withEngine(async e => {
        e.delays.GET_AUDIO = 200;
        const s = await t.openSession({ dataDir: e.dataDir });
        await assert.rejects(s.request('GET_AUDIO', undefined, 50), err => err.code === 'TIMEOUT');
        await sleep(250); // late response arrives and must not break anything
        assert.deepStrictEqual(await s.request('PING'), {});
        s.close();
    }));

test('connection lost: pending requests fail with DISCONNECTED and onClose fires exactly once', () =>
    withEngine(async e => {
        e.drop.GET_PLAYBACK = true;
        let closes = 0;
        const s = await t.openSession({ dataDir: e.dataDir, onClose: () => closes++ });
        const pending = s.request('GET_PLAYBACK');
        await e.waitFor(() => e.requestsOf('GET_PLAYBACK').length);
        for (const sock of e.sockets) sock.destroy();
        await assert.rejects(pending, err => err.code === 'DISCONNECTED');
        await sleep(30);
        s.close(); // closing again is harmless
        assert.strictEqual(closes, 1);
        await assert.rejects(s.request('PING'), err => err.code === 'DISCONNECTED');
    }));

test('heartbeat: PING every heartbeat_interval_ms; a failed PING drops the connection', () =>
    withEngine(async e => {
        e.heartbeatMs = 1000;
        let closed = null;
        await t.openSession({ dataDir: e.dataDir, onClose: r => { closed = r; } });
        await e.waitFor(() => e.requestsOf('PING').length >= 1, 1500);
        e.drop.PING = true; // engine stops answering
        await e.waitFor(() => closed, 6000);
        assert.strictEqual(closed.code, 'TIMEOUT');
    }));
