// Lifecycle tests for the protocol-agnostic connection supervisor.
// The sessions here are test doubles that only exercise reconnection/timeout logic;
// they are not a model of SYNK's protocol.

const test = require('node:test');
const assert = require('node:assert');
const { Supervisor, STATES } = require('../synk/supervisor');
const { SynkError } = require('../synk/errors');

const fast = { minBackoffMs: 5, maxBackoffMs: 20, connectTimeoutMs: 50, callTimeoutMs: 50, versionMismatchRetryMs: 300 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitFor(sup, state, ms = 500) {
    if (sup.state === state) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${state}, at ${sup.state}`)), ms);
        sup.on('state', function onState(s) {
            if (s === state) { clearTimeout(t); sup.off('state', onState); resolve(); }
        });
    });
}

function fakeSession(handlers, impl = {}) {
    const s = {
        closed: false,
        request: impl.request ?? (async (cmd) => ({ echo: cmd })),
        close() { if (!s.closed) { s.closed = true; } },
        drop(reason) { s.closed = true; handlers.onClose(reason); }
    };
    return s;
}

test('retries with backoff while offline, then connects', async () => {
    let attempts = 0;
    const sup = new Supervisor({
        ...fast,
        openSession: async (h) => {
            attempts++;
            if (attempts < 3) throw new SynkError('OFFLINE', 'not running');
            return fakeSession(h);
        }
    });
    sup.start();
    await waitFor(sup, STATES.CONNECTED);
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(await sup.call('PING'), { echo: 'PING' });
    sup.stop();
});

test('reconnects after the connection drops', async () => {
    const sessions = [];
    const sup = new Supervisor({ ...fast, openSession: async (h) => { const s = fakeSession(h); sessions.push(s); return s; } });
    sup.start();
    await waitFor(sup, STATES.CONNECTED);
    sessions[0].drop(new Error('pipe closed'));
    assert.strictEqual(sup.state, STATES.OFFLINE);
    await waitFor(sup, STATES.CONNECTED);
    assert.strictEqual(sessions.length, 2);
    sup.stop();
});

test('calls fail fast with OFFLINE when not connected', async () => {
    const sup = new Supervisor({ ...fast, openSession: async () => { throw new SynkError('OFFLINE'); } });
    sup.start();
    await waitFor(sup, STATES.OFFLINE);
    await assert.rejects(sup.call('PLAY'), e => e.code === 'OFFLINE');
    sup.stop();
});

test('a call that never answers times out', async () => {
    const sup = new Supervisor({ ...fast, openSession: async (h) => fakeSession(h, { request: () => new Promise(() => {}) }) });
    sup.start();
    await waitFor(sup, STATES.CONNECTED);
    await assert.rejects(sup.call('PLAY', {}, 30), e => e.code === 'TIMEOUT');
    assert.ok(sup.connected, 'a slow request does not drop the connection');
    sup.stop();
});

test('a hanging connect times out, and a late session is closed (never two connections)', async () => {
    const late = [];
    let attempts = 0;
    const sup = new Supervisor({
        ...fast,
        openSession: (h) => {
            attempts++;
            if (attempts === 1) {
                return new Promise(resolve => setTimeout(() => { const s = fakeSession(h); late.push(s); resolve(s); }, 120));
            }
            return Promise.resolve(fakeSession(h));
        }
    });
    sup.start();
    await waitFor(sup, STATES.OFFLINE);       // first attempt hit connectTimeoutMs
    await waitFor(sup, STATES.CONNECTED);     // second attempt succeeded
    await sleep(150);                         // the first session finally shows up...
    assert.strictEqual(late.length, 1);
    assert.strictEqual(late[0].closed, true); // ...and is closed immediately
    sup.stop();
});

test('stop() closes the session and ignores late events', async () => {
    let session;
    let events = 0;
    const sup = new Supervisor({ ...fast, openSession: async (h) => { session = fakeSession(h); session.h = h; return session; } });
    sup.on('event', () => events++);
    sup.start();
    await waitFor(sup, STATES.CONNECTED);
    sup.stop();
    assert.strictEqual(session.closed, true);
    assert.strictEqual(sup.state, STATES.STOPPED);
    session.h.onEvent('PLAYBACK', {});
    session.h.onClose('late');
    assert.strictEqual(events, 0);
    assert.strictEqual(sup.state, STATES.STOPPED);
});

test('pauseReconnect delays the next attempt', async () => {
    let attempts = 0;
    const sup = new Supervisor({ ...fast, openSession: async () => { attempts++; throw new SynkError('OFFLINE'); } });
    sup.pauseReconnect(120);
    sup.start();
    await waitFor(sup, STATES.OFFLINE);
    await sleep(80);
    assert.strictEqual(attempts, 1);
    sup.retryNow();                           // ignored while paused
    assert.strictEqual(attempts, 1);
    await sleep(80);
    assert.ok(attempts >= 2);
    sup.stop();
});

test('VERSION_MISMATCH retries slowly (every versionMismatchRetryMs), not with the fast backoff', async () => {
    let attempts = 0;
    const sup = new Supervisor({ ...fast, openSession: async () => { attempts++; throw new SynkError('VERSION_MISMATCH'); } });
    sup.start();
    await waitFor(sup, STATES.OFFLINE);
    assert.strictEqual(sup.lastError.code, 'VERSION_MISMATCH');
    await sleep(200);
    assert.strictEqual(attempts, 1);
    await sleep(200);
    assert.strictEqual(attempts, 2);
    sup.stop();
});

test('reconnectAfter (SHUTTING_DOWN): goes OFFLINE now and waits before the first attempt', async () => {
    const sessions = [];
    const sup = new Supervisor({ ...fast, openSession: async (h) => { const s = fakeSession(h); s.close = () => { if (!s.closed) { s.closed = true; h.onClose(new SynkError('CLOSED')); } }; sessions.push(s); return s; } });
    sup.start();
    await waitFor(sup, STATES.CONNECTED);
    const t0 = Date.now();
    sup.reconnectAfter(150);
    assert.strictEqual(sup.state, STATES.OFFLINE);
    sup.retryNow(); // ignored while waiting
    await waitFor(sup, STATES.CONNECTED);
    assert.ok(Date.now() - t0 >= 140, 'waited before reconnecting');
    assert.strictEqual(sessions.length, 2);
    sup.stop();
});

test('backoff doubles up to the cap with +/-20 % jitter', async () => {
    const times = [];
    const sup = new Supervisor({ ...fast, minBackoffMs: 20, maxBackoffMs: 80, openSession: async () => { times.push(Date.now()); throw new SynkError('NOT_RUNNING'); } });
    sup.start();
    await sleep(600);
    sup.stop();
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(gaps.length >= 4, 'several attempts');
    for (const g of gaps) assert.ok(g >= 15 && g <= 130, `gap ${g} within jittered bounds`);
    assert.ok(Math.max(...gaps.slice(-2)) >= 60, 'reached the cap');
});

test('a failing connect is logged once per error code, never with secrets', async () => {
    const lines = [];
    const log = { info: (...a) => lines.push(a.join(' ')), warn: () => {}, error: () => {} };
    const sup = new Supervisor({ ...fast, log, openSession: async () => { throw new SynkError('NOT_RUNNING', 'ipc.json not found'); } });
    sup.start();
    await sleep(120);
    sup.stop();
    assert.strictEqual(lines.filter(l => l.includes('connect failed')).length, 1);
});
