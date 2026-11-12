// StreamDock (HotSpot / Rise Mode Controller) plugin wrapper.
//
// Copied from spotify.sdPlugin/plugin/utils/plugin.js (full-UUID dispatch) with
// a few hardening changes that only apply to this plugin:
//   - a malformed message from the host is logged instead of throwing;
//   - async handlers that reject are logged (one failing button can't spam
//     unhandledRejection or affect the others);
//   - every send checks the socket is open;
//   - sendToPropertyInspector takes an explicit action/context.

const now = new Date();
const log = require('log4js').configure({
    appenders: {
        file: { type: 'file', filename: `./log/${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log`, maxLogSize: 1024 * 1024, backups: 3 }
    },
    categories: {
        default: { appenders: ['file'], level: 'info' }
    }
}).getLogger();

process.on('uncaughtException', (error) => {
    log.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason) => {
    log.error('Unhandled Rejection:', reason);
});

const ws = require('ws');

function invoke(target, event, data) {
    const fn = target?.[event];
    if (typeof fn !== 'function') return;
    try {
        const result = fn.call(target, data);
        if (result && typeof result.catch === 'function') {
            result.catch(err => log.error(`${event} handler failed:`, err?.message ?? err));
        }
    } catch (err) {
        log.error(`${event} handler threw:`, err?.message ?? err);
    }
}

class Plugins {
    static language = process.argv[5];
    constructor() {
        if (Plugins.instance) {
            return Plugins.instance;
        }
        this.ws = new ws("ws://127.0.0.1:" + process.argv[2]);
        this.ws.on('open', () => this.ws.send(JSON.stringify({ uuid: process.argv[3], event: process.argv[4] })));
        this.ws.on('close', process.exit);
        this.ws.on('error', err => log.error('host socket error:', err.message));
        // Handlers are registered by full action UUID (see registerAction).
        this.uuidActions = {};
        this.ws.on('message', e => {
            let data;
            try {
                data = JSON.parse(e.toString());
            } catch (err) {
                log.error('Ignoring malformed host message:', err.message);
                return;
            }
            if (!data || typeof data !== 'object') return;
            const action = typeof data.action === 'string' ? data.action.split('.').pop() : undefined;
            invoke(this.uuidActions[data.action] ?? this[action], data.event, data);
            invoke(this, data.event, data);
        });
        Plugins.instance = this;
    }
    send(message) {
        if (this.ws.readyState !== ws.OPEN) return false;
        this.ws.send(JSON.stringify(message));
        return true;
    }
    // Register the handlers for one action, keyed by its full UUID from manifest.json
    registerAction(uuid, actions) {
        this.uuidActions[uuid] = actions;
    }
    setTitle(context, title) {
        this.send({ event: "setTitle", context, payload: { target: 0, title } });
    }
    // Accepts a data: URL or a path to a PNG/JPEG file
    setImage(context, imagePath) {
        let imageData;
        if (typeof imagePath === 'string' && imagePath.startsWith('data:')) {
            imageData = imagePath;
        } else {
            const fs = require('fs');
            const path = require('path');
            const ext = path.extname(imagePath).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
            imageData = `data:${mimeType};base64,${fs.readFileSync(imagePath).toString('base64')}`;
        }
        this.send({ event: "setImage", context, payload: { target: 0, image: imageData } });
    }
    setState(context, state) {
        this.send({ event: "setState", context, payload: { state } });
    }
    setSettings(context, payload) {
        this.send({ event: "setSettings", context, payload });
    }
    sendToPropertyInspector(action, context, payload) {
        this.send({ event: "sendToPropertyInspector", action, context, payload });
    }
}

class Actions {
    constructor(data) {
        this.data = {};
        this.default = {};
        Object.assign(this, data);
    }
    willAppear(data) {
        const { context, payload: { settings } = {} } = data;
        this.data[context] = Object.assign({ ...this.default }, settings);
        return this._willAppear?.(data);
    }
    willDisappear(data) {
        this._willDisappear?.(data);
        delete this.data[data.context];
    }
    didReceiveSettings(data) {
        const { context, payload: { settings } = {} } = data;
        this.data[context] = Object.assign({ ...this.default }, settings);
        return this._didReceiveSettings?.(data);
    }
}

module.exports = { log, Plugins, Actions };
