const { Plugins, Actions, log } = require('../utils/plugin');
const { WinKeys } = require('../winKeys');

const plugin = new Plugins();
const keys = new WinKeys(log);

// Replaces the AutoHotkey F19 hotkey: focus Spotify, send Alt+Shift+Q, return to the previous window.
const PROCESS = 'Spotify';
const STEPS = [{ op: 'focus' }, { op: 'sleep', ms: 150 }, { op: 'keys', keys: 'alt+shift+q' }, { op: 'sleep', ms: 100 }, { op: 'restore' }];

plugin.registerAction('com.hotspot.streamdock.spotifykey.action1', new Actions({
    default: {},

    _willAppear() {
        keys.start().catch(err => log.error('worker start error:', err.message)); // warm up so the first press isn't slow
    },

    async keyUp() {
        try {
            const result = await keys.run(PROCESS, STEPS);
            if (result !== 'ok') log.info(`${PROCESS}: ${result}`);
        } catch (err) {
            log.error('keys.run error:', err.message);
        }
    }
}));
