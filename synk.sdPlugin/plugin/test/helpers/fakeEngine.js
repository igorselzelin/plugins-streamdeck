// TEST DOUBLE of synk-engine's plugin-facing side, built from STREAM_DECK_INTEGRATION.md:
// discovery files, HMAC challenge handshake, framing, plugin scope, events.
// It only exists so the plugin can be tested without a running SYNK; the real-engine
// test (engine.integration.test.js) checks the same plugin code against the real binary.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const PLUGIN_SCOPE = new Set([
    'PING', 'GET_STATUS', 'GET_AUDIO', 'GET_PLAYBACK', 'GET_LIBRARY', 'GET_SOUND', 'GET_ARTWORK',
    'LIST_COLLECTIONS', 'PLAY_SOUND', 'STOP_SOUND', 'STOP_ALL', 'PAUSE_SOUND', 'RESUME_SOUND',
    'SET_VOLUME', 'SET_MUTE'
]);

const hmacHex = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');

function encode(obj) {
    const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
}

function reader(onFrame) {
    let buf = Buffer.alloc(0);
    return chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
            const len = buf.readUInt32LE(0);
            if (buf.length < 4 + len) return;
            const body = buf.subarray(4, 4 + len).toString('utf8');
            buf = buf.subarray(4 + len);
            try { onFrame(JSON.parse(body)); } catch { onFrame({ type: '__malformed__' }); }
        }
    };
}

const uuid = () => crypto.randomUUID();

class FakeEngine {
    constructor(opts = {}) {
        this.dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'synk-fake-'));
        this.pipe = `\\\\.\\pipe\\synk-engine-S-1-5-21-1000-test-${crypto.randomBytes(6).toString('hex')}`;
        this.proofMode = 'ok';          // 'ok' | 'wrong' (squatter) | 'silent' (never answers hello)
        this.acceptClientProof = true;  // false -> UNAUTHORIZED
        this.frames = [];               // every frame received from clients (after the handshake too)
        this.requests = [];             // { cmd, params }
        this.sockets = new Set();
        this.handlers = {};             // cmd -> (params, ctx) => result | throws { code, message }
        this.sounds = [];
        this.playing = [];              // voices
        this.audio = { state: 'running', backend: 'sim', active: true, master_volume: 1, effects_volume: 0.8, effects_muted: false, voices: 0, error: null, extra_field: 'ignored' };
        this.delays = {};               // cmd -> ms before answering
        this.drop = {};                 // cmd -> true: never answer
        this.token = crypto.randomBytes(32).toString('hex');
        this.version = '0.1.0-fake';
        this.installDefaults();
    }

    addSound(name, extra = {}) {
        const s = { id: uuid(), name, duration_ms: 1000, has_artwork: false, volume: 1, favorite: false, updated_at_ms: Date.now(), original_name: `${name}.wav`, ...extra };
        this.sounds.push(s);
        return s;
    }

    installDefaults() {
        const err = (code, message = code) => { throw { code, message }; };
        const find = id => this.sounds.find(s => s.id === id) || err('NOT_FOUND', 'sound not found');
        const isUuid = v => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
        const only = (params, allowed) => {
            for (const k of Object.keys(params || {})) if (!allowed.includes(k)) err('INVALID_PARAMS', `unknown field ${k}`);
        };
        const playbackEvent = () => this.broadcast({ type: 'event', event: 'PLAYBACK', data: { voices: this.playing.map(v => ({ ...v })) } });
        const audioEvent = () => this.broadcast({ type: 'event', event: 'AUDIO_STATUS', data: { ...this.audio } });
        let voiceId = 1;
        Object.assign(this.handlers, {
            PING: () => ({}),
            GET_STATUS: () => ({ engine_version: this.version, protocol: 1, uptime_ms: 1000, clients: { ui: 0, plugin: this.sockets.size }, audio: this.audio.state, active_voices: this.playing.length }),
            GET_AUDIO: () => ({ ...this.audio }),
            GET_PLAYBACK: () => ({ voices: this.playing.map(v => ({ ...v })) }),
            GET_LIBRARY: (p = {}) => {
                only(p, ['search', 'favorites_only', 'played_only', 'collection', 'category', 'sort', 'offset', 'limit']);
                const offset = p.offset || 0, limit = p.limit || 1000;
                return { sounds: this.sounds.slice(offset, offset + limit), total: this.sounds.length };
            },
            GET_SOUND: p => { only(p, ['sound_id']); if (!isUuid(p?.sound_id)) err('INVALID_PARAMS'); return find(p.sound_id); },
            GET_ARTWORK: p => {
                only(p, ['sound_id']);
                const s = find(p.sound_id);
                if (!s.has_artwork) err('NOT_FOUND', 'this sound has no artwork');
                return { mime: s.artwork_mime || 'image/png', data_base64: s.artwork_b64 };
            },
            PLAY_SOUND: p => {
                only(p, ['sound_id', 'mode', 'volume']);
                if (!isUuid(p?.sound_id)) err('INVALID_PARAMS', 'sound_id must be a UUID');
                if (p.mode !== undefined && !['overlap', 'restart', 'toggle'].includes(p.mode)) err('INVALID_PARAMS');
                find(p.sound_id);
                if (this.audio.state !== 'running') err('UNAVAILABLE', 'no output device');
                const mine = this.playing.filter(v => v.sound_id === p.sound_id);
                if (p.mode === 'toggle' && mine.length) {
                    this.playing = this.playing.filter(v => v.sound_id !== p.sound_id);
                    playbackEvent();
                    return { voice_id: null, stopped: mine.length, prepared: null, prepare_ms: null };
                }
                let stopped = 0;
                if (p.mode === 'restart') { stopped = mine.length; this.playing = this.playing.filter(v => v.sound_id !== p.sound_id); }
                const v = { voice_id: voiceId++, sound_id: p.sound_id, kind: 'sound', paused: false, duration_ms: 1000 };
                this.playing.push(v);
                playbackEvent(); // the event often arrives BEFORE the response
                this.broadcast({ type: 'event', event: 'LIBRARY_CHANGED' });
                return { voice_id: v.voice_id, stopped, prepared: 'cache', prepare_ms: 0.01 };
            },
            STOP_SOUND: p => {
                only(p, ['sound_id']);
                if (!isUuid(p?.sound_id)) err('INVALID_PARAMS');
                const n = this.playing.filter(v => v.sound_id === p.sound_id).length;
                this.playing = this.playing.filter(v => v.sound_id !== p.sound_id);
                if (n) playbackEvent();
                return { stopped: n };
            },
            STOP_ALL: p => {
                if (p !== undefined) err('INVALID_PARAMS');
                const n = this.playing.length;
                this.playing = [];
                if (n) playbackEvent();
                return { stopped: n };
            },
            SET_VOLUME: p => {
                only(p, ['target', 'volume']);
                if (!p || typeof p.volume !== 'number' || !(p.volume >= 0 && p.volume <= 2)) err('INVALID_PARAMS', 'volume out of range');
                if (p.target?.kind !== 'effects') err('INVALID_PARAMS');
                this.audio.effects_volume = Math.fround(p.volume); // engine stores f32
                audioEvent();
                return {};
            },
            SET_MUTE: p => {
                only(p, ['target', 'muted']);
                if (p?.target !== 'effects' || typeof p.muted !== 'boolean') err('INVALID_PARAMS');
                this.audio.effects_muted = p.muted;
                audioEvent();
                return { ...this.audio };
            }
        });
    }

    writeDiscovery(overrides = {}, { token = this.token } = {}) {
        fs.writeFileSync(path.join(this.dataDir, 'ipc.token'), `${token}\r\n`);
        const info = { format: 1, pipe: this.pipe, pid: process.pid, protocol: 1, engine_version: this.version, started_at_ms: Date.now(), auth: ['token', 'hmac-sha256'], future_field: true, ...overrides };
        fs.writeFileSync(path.join(this.dataDir, 'ipc.json'), JSON.stringify(info));
    }

    removeDiscovery() {
        for (const f of ['ipc.json', 'ipc.token']) fs.rmSync(path.join(this.dataDir, f), { force: true });
    }

    // Simulates an engine start: new token, files written, pipe listening.
    async start() {
        this.token = crypto.randomBytes(32).toString('hex');
        this.server = net.createServer(sock => this.onConnection(sock));
        await new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(this.pipe, res); });
        this.writeDiscovery();
        return this;
    }

    // Simulates a crash (files left behind) or a clean exit (files removed, SHUTTING_DOWN first).
    async stop({ clean = true } = {}) {
        if (clean) {
            this.broadcast({ type: 'event', event: 'SHUTTING_DOWN' });
            await new Promise(r => setTimeout(r, 50));
            this.removeDiscovery();
        }
        for (const s of this.sockets) s.destroy();
        this.sockets.clear();
        if (this.server) await new Promise(r => this.server.close(() => r()));
        this.server = null;
    }

    broadcast(frame) {
        for (const s of this.sockets) if (s.synkOpen) s.write(encode(frame));
    }

    sendRaw(bytes) {
        for (const s of this.sockets) if (s.synkOpen) s.write(bytes);
    }

    requestsOf(cmd) {
        return this.requests.filter(r => r.cmd === cmd);
    }

    waitFor(pred, ms = 3000) {
        const deadline = Date.now() + ms;
        return new Promise((resolve, reject) => {
            const tick = () => {
                const v = pred();
                if (v) return resolve(v);
                if (Date.now() > deadline) return reject(new Error('fakeEngine.waitFor timed out'));
                setTimeout(tick, 10);
            };
            tick();
        });
    }

    onConnection(sock) {
        this.sockets.add(sock);
        sock.on('close', () => this.sockets.delete(sock));
        sock.on('error', () => {});
        const key = Buffer.from(this.token, 'hex');
        let state = 'hello', cn, sn, kind;
        const send = f => sock.write(encode(f));
        const reject = (code) => { send({ type: 'response', id: 0, ok: false, error: { code, message: code } }); sock.end(); };
        sock.on('data', reader(async msg => {
            this.frames.push(msg);
            if (state === 'hello') {
                if (msg.type !== 'hello') return reject(msg.type === 'request' ? 'HANDSHAKE_REQUIRED' : 'BAD_FRAME');
                if ('token' in msg || msg.auth !== 'hmac-sha256' || !/^[0-9a-f]{64}$/.test(msg.client_nonce || '')) return reject('BAD_FRAME');
                if (msg.protocol !== 1) return reject('VERSION_MISMATCH');
                if (this.proofMode === 'silent') return;
                cn = msg.client_nonce; kind = msg.client;
                sn = crypto.randomBytes(32).toString('hex');
                const proof = this.proofMode === 'wrong' ? crypto.randomBytes(32).toString('hex') : hmacHex(key, `SYNK-AUTH-1|server|${cn}|${sn}`);
                state = 'challenge';
                return send({ type: 'challenge', server_nonce: sn, server_proof: proof });
            }
            if (state === 'challenge') {
                const expected = hmacHex(key, `SYNK-AUTH-1|client|${kind}|${cn}|${sn}`);
                if (msg.type !== 'auth' || msg.client_proof !== expected || !this.acceptClientProof) return reject('UNAUTHORIZED');
                state = 'open';
                sock.synkOpen = true;
                return send({ type: 'welcome', protocol: this.welcomeProtocol ?? 1, engine_version: this.version, heartbeat_interval_ms: this.heartbeatMs ?? 5000, idle_timeout_ms: 15000 });
            }
            if (msg.type !== 'request') return send({ type: 'response', id: 0, ok: false, error: { code: 'BAD_FRAME', message: 'bad frame' } });
            this.requests.push({ cmd: msg.cmd, params: msg.params, id: msg.id });
            if (this.drop[msg.cmd]) return;
            if (this.delays[msg.cmd]) await new Promise(r => setTimeout(r, this.delays[msg.cmd]));
            if (!PLUGIN_SCOPE.has(msg.cmd)) return send({ type: 'response', id: msg.id, ok: false, error: { code: 'FORBIDDEN', message: 'not allowed for plugin' } });
            const h = this.handlers[msg.cmd];
            if (!h) return send({ type: 'response', id: msg.id, ok: false, error: { code: 'UNKNOWN_COMMAND', message: msg.cmd } });
            try {
                const result = await h(msg.params, { sock });
                if (!sock.destroyed) send({ type: 'response', id: msg.id, ok: true, result });
            } catch (e) {
                if (!sock.destroyed) send({ type: 'response', id: msg.id, ok: false, error: { code: e.code || 'INTERNAL', message: e.message || '' } });
            }
        }));
    }

    cleanup() {
        fs.rmSync(this.dataDir, { recursive: true, force: true });
    }
}

module.exports = { FakeEngine, encode, hmacHex };
