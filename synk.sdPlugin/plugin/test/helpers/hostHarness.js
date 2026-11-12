// Simulated StreamDock host: a ws server speaking the host side of the plugin socket
// (registerPlugin, willAppear, keyDown/keyUp, dialRotate/dialDown, sendToPlugin,
// propertyInspectorDidAppear), plus a launcher for the plugin process.
//
// SYNK_E2E_RUNTIME=app runs the ncc bundle (build/index.js) on the real plugin/app.exe
// (pkg Node 18.5), exactly like the Rise Mode Controller; otherwise index.js on this Node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WS = require('ws');

const PLUGIN_DIR = path.join(__dirname, '..', '..');
const runtime = process.env.SYNK_E2E_RUNTIME === 'app' ? 'app' : 'node';

async function startPlugin({ dataDir, env: extraEnv = {} }) {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const wss = new WS.Server({ port, host: '127.0.0.1' });
    await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej); });
    const received = [];
    let sock = null;
    const registered = new Promise(resolve => {
        wss.on('connection', s => {
            sock = s;
            s.on('message', m => {
                const msg = JSON.parse(m.toString());
                received.push(msg);
                if (msg.event === 'registerPlugin') resolve();
            });
        });
    });

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synk-host-'));
    let child;
    const env = { ...process.env, SYNK_DATA_DIR: dataDir, SYNK_PROFILES_DIR: path.join(workDir, 'no-profiles'), ...extraEnv };
    if (runtime === 'app') {
        const bundle = path.join(PLUGIN_DIR, 'build', 'index.js');
        if (!fs.existsSync(bundle)) throw new Error('build/index.js missing: run "npm run bundle" first');
        fs.copyFileSync(path.join(PLUGIN_DIR, 'app.exe'), path.join(workDir, 'app.exe'));
        fs.copyFileSync(bundle, path.join(workDir, 'index.js'));
        child = spawn(path.join(workDir, 'app.exe'),
            ['-port', String(port), '-pluginUUID', 'synk-test', '-registerEvent', 'registerPlugin', '-info', '{"application":{"language":"en"}}'],
            { cwd: workDir, env });
    } else {
        child = spawn(process.execPath, [path.join(PLUGIN_DIR, 'index.js'), String(port), 'synk-test', 'registerPlugin', 'en'], { cwd: workDir, env });
    }
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    await Promise.race([
        registered,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`plugin did not register. stderr: ${stderr}`)), 10000))
    ]);

    const host = {
        runtime,
        received,
        send(msg) { sock.send(JSON.stringify(msg)); },
        appear(action, context, settings = {}, coordinates = { column: 0, row: 0 }) {
            this.send({ event: 'willAppear', action, context, device: 'dev', payload: { settings, coordinates } });
        },
        disappear(action, context) {
            this.send({ event: 'willDisappear', action, context, device: 'dev', payload: { settings: {} } });
        },
        press(action, context) {
            this.send({ event: 'keyDown', action, context, device: 'dev', payload: { settings: {} } });
            this.send({ event: 'keyUp', action, context, device: 'dev', payload: { settings: {} } });
        },
        images(context) {
            return received.filter(m => m.event === 'setImage' && m.context === context).map(m => m.payload.image);
        },
        lastImage(context) {
            const all = this.images(context);
            return all[all.length - 1];
        },
        ofEvent(event, context) {
            return received.filter(m => m.event === event && (!context || m.context === context));
        },
        waitFor(pred, ms = 5000, label = 'condition') {
            const deadline = Date.now() + ms;
            return new Promise((resolve, reject) => {
                const tick = () => {
                    let v;
                    try { v = pred(); } catch (e) { return reject(e); }
                    if (v) return resolve(v);
                    if (Date.now() > deadline) return reject(new Error(`host.waitFor timed out: ${label}`));
                    setTimeout(tick, 15);
                };
                tick();
            });
        },
        // Resolves with the key's image once no new frame arrived for `quietMs` (animations done).
        async settled(context, quietMs = 400, ms = 8000) {
            let count = -1, since = Date.now();
            await this.waitFor(() => {
                const n = this.images(context).length;
                if (n !== count) { count = n; since = Date.now(); return false; }
                return n > 0 && Date.now() - since >= quietMs;
            }, ms, `${context} settled`);
            return this.lastImage(context);
        },
        // Resolves once the key shows a new image (different from `before`).
        async nextImage(context, before, ms = 5000) {
            await this.waitFor(() => this.lastImage(context) && this.lastImage(context) !== before, ms, `new image on ${context}`);
            return this.lastImage(context);
        },
        logs() {
            const dir = path.join(workDir, 'log');
            if (!fs.existsSync(dir)) return '';
            return fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
        },
        async stop() {
            try { sock?.close(); } catch { /* ignore */ }
            await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(() => { child.kill(); r(); }, 3000); });
            await new Promise(r => wss.close(() => r()));
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    };
    return host;
}

const A = {
    play: 'com.hotspot.streamdock.synk.play',
    toggle: 'com.hotspot.streamdock.synk.toggle',
    stop: 'com.hotspot.streamdock.synk.stop',
    stopall: 'com.hotspot.streamdock.synk.stopall',
    mute: 'com.hotspot.streamdock.synk.mute',
    volume: 'com.hotspot.streamdock.synk.volume',
    status: 'com.hotspot.streamdock.synk.status'
};

module.exports = { startPlugin, A, runtime };
