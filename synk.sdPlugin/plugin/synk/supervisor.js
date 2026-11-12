// Owns the single connection between this plugin and SYNK.
//
// Wire format, handshake and heartbeat live in the session returned by
// `openSession` (transport.js). This class does lifecycle only — one connection
// at a time, reconnection with backoff (STREAM_DECK_INTEGRATION.md section 10:
// 250 ms doubling to 5 s, ±20 % jitter, 1 s after SHUTTING_DOWN, 30 s on
// VERSION_MISMATCH), a hard timeout on connecting and on every call, and a
// state the keys can render.
//
// openSession({ onEvent(name, data), onClose(reason), log }) must resolve to
//   { request(cmd, params, timeoutMs): Promise<result>, close(): void, welcome?, info? }

const { EventEmitter } = require('events');
const { SynkError, LOCAL_CODES, toSynkError } = require('./errors');

const STATES = Object.freeze({
    STOPPED: 'stopped',       // nothing on screen needs SYNK
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    OFFLINE: 'offline'        // SYNK not reachable; retrying with backoff
});

const DEFAULTS = {
    minBackoffMs: 250,
    maxBackoffMs: 5000,
    jitter: 0.2,
    versionMismatchRetryMs: 30000,
    connectTimeoutMs: 4000,   // file reads + pipe connect + 3 s handshake
    callTimeoutMs: 3000
};

class Supervisor extends EventEmitter {
    constructor({ openSession, log, ...options }) {
        super();
        this.openSession = openSession;
        this.log = log;
        this.opts = { ...DEFAULTS, ...options };
        this.state = STATES.STOPPED;
        this.lastError = null;
        this.session = null;
        this.attempt = 0;
        this.retryTimer = null;
        this.connecting = false;
        this.generation = 0;       // bumps on stop() so late results from old attempts are dropped
        this.pausedUntil = 0;
        this.loggedCode = null;    // log a repeating connect failure only once
    }

    get connected() {
        return this.state === STATES.CONNECTED;
    }

    get engineInfo() {
        return this.session ? { ...(this.session.info || {}), ...(this.session.welcome || {}) } : null;
    }

    start() {
        if (this.state !== STATES.STOPPED) return;
        this._setState(STATES.CONNECTING);
        this._connect();
    }

    stop() {
        this.generation++;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.connecting = false;
        this.attempt = 0;
        this._dropSession();
        this._setState(STATES.STOPPED);
    }

    // Skips the remaining backoff ("reconnect now", or a key pressed while offline).
    retryNow() {
        if (this.state === STATES.STOPPED) return;
        if (this.connected || this.connecting) return;
        if (Date.now() < this.pausedUntil) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.attempt = 0;
        this._connect();
    }

    // Hold off reconnecting for a while.
    pauseReconnect(ms) {
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    }

    // SHUTTING_DOWN: go offline now and wait `ms` before the first reconnect attempt.
    reconnectAfter(ms) {
        this.pauseReconnect(ms);
        this.attempt = 0;
        const session = this.session;
        if (session) safeClose(session); // its onClose moves us to OFFLINE and schedules the retry
    }

    async call(cmd, params, timeoutMs = this.opts.callTimeoutMs) {
        const session = this.session;
        if (!this.connected || !session) {
            this.retryNow();
            throw new SynkError(LOCAL_CODES.OFFLINE, 'SYNK is not connected');
        }
        // The session has its own per-request timeout (which also forgets the id); this one is a backstop.
        let timer;
        const backstop = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new SynkError(LOCAL_CODES.TIMEOUT, `${cmd} timed out`)), timeoutMs + 250);
        });
        try {
            return await Promise.race([session.request(cmd, params, timeoutMs), backstop]);
        } finally {
            clearTimeout(timer);
        }
    }

    _setState(state, error = null) {
        const changed = state !== this.state || (error?.code ?? null) !== (this.lastError?.code ?? null);
        this.state = state;
        this.lastError = error;
        if (changed) this.emit('state', state, error);
    }

    async _connect() {
        if (this.connecting || this.connected) return;
        this.connecting = true;
        const generation = this.generation;
        if (this.state !== STATES.CONNECTING && this.state !== STATES.OFFLINE) this._setState(STATES.CONNECTING);

        let session = null;
        let connectTimer;
        let abandoned = false;
        try {
            const opening = Promise.resolve().then(() => this.openSession({
                log: this.log,
                onEvent: (name, data) => {
                    if (this.session === session) this.emit('event', name, data);
                },
                onClose: (reason) => {
                    if (this.session === session) this._onSessionClosed(reason);
                }
            }));
            const timeout = new Promise((_, reject) => {
                connectTimer = setTimeout(() => reject(new SynkError(LOCAL_CODES.TIMEOUT, 'connect timed out')), this.opts.connectTimeoutMs);
            });
            // If the attempt times out but the session shows up later, close it so we never hold two connections.
            opening.then(s => { if (abandoned && s) safeClose(s); }, () => {});
            session = await Promise.race([opening, timeout]);
        } catch (err) {
            abandoned = true;
            clearTimeout(connectTimer);
            if (generation !== this.generation) return; // stop() already reset the flags; a newer attempt may own them
            this.connecting = false;
            const error = toSynkError(err);
            if (this.loggedCode !== error.code) {
                this.loggedCode = error.code;
                this.log?.info(`SYNK connect failed: ${error.code}`);
            }
            this._setState(STATES.OFFLINE, error);
            this._scheduleRetry(error.code === LOCAL_CODES.VERSION_MISMATCH ? this.opts.versionMismatchRetryMs : null);
            return;
        }
        clearTimeout(connectTimer);
        if (generation !== this.generation) {
            abandoned = true;
            safeClose(session);
            return;
        }
        this.connecting = false;
        this.session = session;
        this.attempt = 0;
        this.loggedCode = null;
        this.log?.info(`SYNK connected (engine ${session.welcome?.engine_version ?? '?'})`);
        this._setState(STATES.CONNECTED);
    }

    _onSessionClosed(reason) {
        const error = reason instanceof SynkError ? reason : new SynkError(LOCAL_CODES.DISCONNECTED, 'connection closed');
        this.log?.info(`SYNK connection closed: ${error.code}`);
        this.session = null;
        if (this.state === STATES.STOPPED) return;
        this._setState(STATES.OFFLINE, error);
        this._scheduleRetry();
    }

    _scheduleRetry(fixedDelay = null) {
        clearTimeout(this.retryTimer);
        let delay = fixedDelay;
        if (delay === null) {
            const base = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** this.attempt);
            const jitter = 1 + (Math.random() * 2 - 1) * this.opts.jitter;
            delay = Math.round(base * jitter);
            this.attempt = Math.min(this.attempt + 1, 16);
        }
        delay = Math.max(delay, this.pausedUntil - Date.now());
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this._connect();
        }, delay);
    }

    _dropSession() {
        const session = this.session;
        this.session = null;
        if (session) safeClose(session);
    }
}

function safeClose(session) {
    try { session.close(); } catch { /* already closed */ }
}

module.exports = { Supervisor, STATES };
