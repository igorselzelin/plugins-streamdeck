// SYNK wire transport, implemented from D:\synk\docs\STREAM_DECK_INTEGRATION.md
// (sections 2-5, 10, 11) and checked against scripts/deck-reference-client.cjs.
//
//   discovery  %LOCALAPPDATA%\SYNK\ipc.json  (re-read on every attempt, never cached)
//   secret     %LOCALAPPDATA%\SYNK\ipc.token (64 hex -> 32-byte HMAC key, kept only during the handshake)
//   channel    local named pipe from ipc.json, 4-byte LE length + UTF-8 JSON frames
//   auth       HMAC-SHA256 challenge-response: the engine proves first, the token never crosses the pipe
//
// The token, the key, nonces and proofs are never logged, stored or sent anywhere.
// Node 18.5 compatible: only net, crypto, fs, path.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { SynkError } = require('./errors');

const PROTOCOL = 1;
const CLIENT_KIND = 'plugin';
const CLIENT_NAME = 'synk-streamdock 0.3.0';   // logged by the engine: no secrets here
const MAX_SERVER_FRAME = 8 * 1024 * 1024;
const MAX_CLIENT_FRAME = 64 * 1024;
const MAX_DISCOVERY_BYTES = 4096;
const MAX_TOKEN_BYTES = 256;
const PIPE_RE = /^\\\\\.\\pipe\\synk-engine-S-1-[0-9][A-Za-z0-9-]*$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[0-9a-fA-F]{64}$/;
const HANDSHAKE_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------- discovery

// %LOCALAPPDATA%\SYNK, or an absolute SYNK_DATA_DIR (development only; the host never sets it).
function defaultDataDir() {
    const override = process.env.SYNK_DATA_DIR;
    if (override && path.isAbsolute(override)) return override;
    if (!process.env.LOCALAPPDATA) throw new SynkError('NOT_RUNNING', 'LOCALAPPDATA is not set');
    return path.join(process.env.LOCALAPPDATA, 'SYNK');
}

function readSmallFile(file, max) {
    let st;
    try {
        st = fs.statSync(file);
    } catch (e) {
        if (e.code === 'ENOENT') throw new SynkError('NOT_RUNNING', `${path.basename(file)} not found`);
        throw new SynkError('INVALID_DISCOVERY', `cannot read ${path.basename(file)}: ${e.code || e.message}`);
    }
    if (!st.isFile() || st.size > max) throw new SynkError('INVALID_DISCOVERY', `${path.basename(file)} is not a small file`);
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') throw new SynkError('NOT_RUNNING', `${path.basename(file)} disappeared`);
        throw new SynkError('INVALID_DISCOVERY', `cannot read ${path.basename(file)}: ${e.code || e.message}`);
    }
}

function readDiscovery(dir) {
    const raw = readSmallFile(path.join(dir, 'ipc.json'), MAX_DISCOVERY_BYTES);
    let info;
    try {
        info = JSON.parse(raw);
    } catch {
        // Possibly caught mid-write by a starting engine: "not running yet".
        throw new SynkError('NOT_RUNNING', 'ipc.json is incomplete');
    }
    if (!info || typeof info !== 'object' || info.format !== 1) throw new SynkError('INVALID_DISCOVERY', 'unsupported ipc.json format');
    if (typeof info.pipe !== 'string' || info.pipe.length > 200 || !PIPE_RE.test(info.pipe)) {
        throw new SynkError('INVALID_DISCOVERY', 'ipc.json names an invalid pipe');
    }
    if (!Array.isArray(info.auth) || !info.auth.includes('hmac-sha256')) {
        throw new SynkError('INVALID_DISCOVERY', 'engine does not offer hmac-sha256');
    }
    if (info.protocol !== PROTOCOL) {
        throw new SynkError('VERSION_MISMATCH', `engine protocol ${info.protocol}, plugin speaks ${PROTOCOL}`);
    }
    return info;
}

function readKey(dir) {
    const token = readSmallFile(path.join(dir, 'ipc.token'), MAX_TOKEN_BYTES).trim();
    // Validate before Buffer.from, which silently truncates invalid hex.
    if (!TOKEN_RE.test(token)) throw new SynkError('INVALID_DISCOVERY', 'malformed ipc.token');
    return Buffer.from(token, 'hex');
}

// ---------------------------------------------------------------- crypto

const hmacHex = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
const serverProof = (key, cn, sn) => hmacHex(key, `SYNK-AUTH-1|server|${cn}|${sn}`);
const clientProof = (key, kind, cn, sn) => hmacHex(key, `SYNK-AUTH-1|client|${kind}|${cn}|${sn}`);

function sameHex(received, expected) {
    return typeof received === 'string' && HEX64_RE.test(received) && received.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'));
}

// ---------------------------------------------------------------- framing

function encodeFrame(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    if (body.length === 0 || body.length > MAX_CLIENT_FRAME) throw new SynkError('BAD_FRAME', 'frame too large');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
}

// Splits the byte stream into JSON frames; a chunk may hold a partial frame or several.
function frameReader(onFrame, onError) {
    let buf = Buffer.alloc(0);
    let broken = false;
    return (chunk) => {
        if (broken) return;
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= 4) {
            const len = buf.readUInt32LE(0);
            if (len === 0 || len > MAX_SERVER_FRAME) {
                broken = true;
                return onError(new SynkError('BAD_FRAME', `bad frame length ${len}`));
            }
            if (buf.length < 4 + len) return;
            const body = buf.subarray(4, 4 + len);
            buf = buf.subarray(4 + len);
            let msg;
            try { msg = JSON.parse(body.toString('utf8')); } catch { continue; } // skip a malformed frame
            if (msg && typeof msg === 'object') onFrame(msg);
        }
    };
}

// ---------------------------------------------------------------- session

/**
 * Connects, authenticates and resolves to { request(cmd, params, timeoutMs), close(), welcome, info }.
 * Rejects with a SynkError (NOT_RUNNING, INVALID_DISCOVERY, VERSION_MISMATCH, SERVER_PROOF_MISMATCH,
 * TIMEOUT, UNAUTHORIZED, BAD_FRAME, IO...). After it resolves, onClose(SynkError) fires exactly once.
 */
async function openSession({ onEvent = () => {}, onClose = () => {}, log, dataDir } = {}) {
    const dir = dataDir || defaultDataDir();
    const info = readDiscovery(dir);
    let key = readKey(dir);

    return new Promise((resolve, reject) => {
        const sock = net.connect(info.pipe);
        const cn = crypto.randomBytes(32).toString('hex');
        const pending = new Map();
        let nextId = 1;
        let state = 'hello'; // hello -> challenge -> open -> closed
        let heartbeat = null;

        const handshakeTimer = setTimeout(() => fail(new SynkError('TIMEOUT', 'handshake timed out')), HANDSHAKE_TIMEOUT_MS);

        function send(obj) {
            sock.write(encodeFrame(obj));
        }

        function fail(err) {
            if (state === 'closed') return;
            const wasOpen = state === 'open';
            state = 'closed';
            key = null;
            clearTimeout(handshakeTimer);
            clearInterval(heartbeat);
            sock.destroy();
            for (const p of pending.values()) {
                clearTimeout(p.timer);
                p.reject(new SynkError('DISCONNECTED', 'connection closed'));
            }
            pending.clear();
            if (wasOpen) onClose(err);
            else reject(err);
        }

        function request(cmd, params, timeoutMs = REQUEST_TIMEOUT_MS) {
            if (state !== 'open') return Promise.reject(new SynkError('DISCONNECTED', 'not connected'));
            const id = nextId++;
            const frame = { type: 'request', id, cmd };
            if (params !== undefined && params !== null) frame.params = params;
            let bytes;
            try { bytes = encodeFrame(frame); } catch (e) { return Promise.reject(e); }
            return new Promise((res, rej) => {
                // On timeout the id is forgotten; a late response is ignored. Never retried here.
                const timer = setTimeout(() => {
                    pending.delete(id);
                    rej(new SynkError('TIMEOUT', `${cmd} timed out`));
                }, timeoutMs);
                pending.set(id, { resolve: res, reject: rej, timer });
                sock.write(bytes);
            });
        }

        function onFrame(msg) {
            if (state === 'hello' && msg.type === 'challenge') {
                // The ENGINE proves first. A squatter cannot compute this; never answer it.
                const sn = msg.server_nonce;
                if (typeof sn !== 'string' || !HEX64_RE.test(sn) || !sameHex(msg.server_proof, serverProof(key, cn, sn))) {
                    log?.warn('SYNK: the pipe server could not prove it is SYNK; closing without answering');
                    return fail(new SynkError('SERVER_PROOF_MISMATCH', 'the pipe server could not prove it is SYNK'));
                }
                state = 'challenge';
                const proof = clientProof(key, CLIENT_KIND, cn, sn);
                key = null; // not needed after the handshake
                return send({ type: 'auth', client_proof: proof });
            }
            if (state === 'challenge' && msg.type === 'welcome') {
                if (msg.protocol !== PROTOCOL) return fail(new SynkError('VERSION_MISMATCH', `engine welcomed protocol ${msg.protocol}`));
                clearTimeout(handshakeTimer);
                state = 'open';
                const interval = Number.isFinite(msg.heartbeat_interval_ms) ? Math.max(1000, msg.heartbeat_interval_ms) : 5000;
                heartbeat = setInterval(() => {
                    request('PING').catch(() => fail(new SynkError('TIMEOUT', 'heartbeat failed')));
                }, interval);
                return resolve({
                    request,
                    close: () => fail(new SynkError('CLOSED', 'closed by plugin')),
                    welcome: { protocol: msg.protocol, engine_version: msg.engine_version, heartbeat_interval_ms: interval },
                    info: { engine_version: info.engine_version, pid: info.pid }
                });
            }
            if (msg.type === 'response') {
                if (state !== 'open' || msg.id === 0) {
                    // Handshake rejection, or a connection-level error: {id:0, ok:false, error}
                    const code = typeof msg.error?.code === 'string' ? msg.error.code : 'INTERNAL';
                    if (state !== 'open') return fail(new SynkError(code, msg.error?.message || code));
                    log?.warn(`SYNK connection-level error: ${code}`);
                    return;
                }
                const p = pending.get(msg.id);
                if (!p) return; // late response after a client-side timeout
                pending.delete(msg.id);
                clearTimeout(p.timer);
                if (msg.ok === true) p.resolve(msg.result);
                else {
                    const code = typeof msg.error?.code === 'string' ? msg.error.code : 'INTERNAL';
                    p.reject(new SynkError(code, typeof msg.error?.message === 'string' ? msg.error.message : code));
                }
                return;
            }
            if (state === 'open' && msg.type === 'event') {
                if (typeof msg.event !== 'string') return;
                try { onEvent(msg.event, msg.data); } catch (e) { log?.error(`SYNK event ${msg.event} handler failed: ${e.message}`); }
                return;
            }
            fail(new SynkError('BAD_FRAME', `unexpected ${msg.type} frame in state ${state}`));
        }

        sock.on('connect', () => {
            try {
                send({ type: 'hello', protocol: PROTOCOL, client: CLIENT_KIND, client_name: CLIENT_NAME, auth: 'hmac-sha256', client_nonce: cn });
            } catch (e) { fail(e); }
        });
        sock.on('data', frameReader(onFrame, fail));
        sock.on('error', (e) => fail(e.code === 'ENOENT'
            ? new SynkError('NOT_RUNNING', 'engine pipe not found')
            : new SynkError('IO', `pipe error ${e.code || e.message}`)));
        sock.on('close', () => fail(new SynkError('DISCONNECTED', 'engine closed the connection')));
    });
}

module.exports = {
    openSession,
    // exported for tests
    readDiscovery, readKey, serverProof, clientProof, encodeFrame, frameReader,
    PROTOCOL, MAX_CLIENT_FRAME, MAX_SERVER_FRAME
};
