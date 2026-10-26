const { Plugins, Actions, log } = require('./utils/plugin');
const { WinKeys } = require('./winKeys');

const plugin = new Plugins();
const keys = new WinKeys(log);

// Replaces the AutoHotkey F20–F23 hotkeys: focus Discord, send the combo, return to the previous window.
const PROCESS = 'Discord';
const F = { op: 'focus' }, R = { op: 'restore' };
const wait = ms => ({ op: 'sleep', ms });
const press = combo => ({ op: 'keys', keys: combo });

// Action UUIDs are kept from when each of these was its own plugin, so buttons already placed keep working.
const HOTKEYS = {
    'com.hotspot.streamdock.discordmute.action1':   [F, wait(100), press('ctrl+shift+m'), wait(100), R],                        // mute
    'com.hotspot.streamdock.discorddeafen.action1': [F, wait(100), press('ctrl+shift+d'), wait(100), R],                        // deafen
    'com.hotspot.streamdock.discordkeyv.action1':   [F, wait(200), press('ctrl+shift+v'), wait(100), F, press('enter'), wait(100), R], // camera
    'com.hotspot.streamdock.discordkeye.action1':   [F, wait(200), press('ctrl+shift+e'), wait(100), R]                        // hang up
};

for (const [uuid, steps] of Object.entries(HOTKEYS)) {
    plugin.registerAction(uuid, new Actions({
        default: {},

        _willAppear() {
            keys.start().catch(err => log.error('worker start error:', err.message)); // warm up so the first press isn't slow
        },

        async keyUp() {
            try {
                const result = await keys.run(PROCESS, steps);
                if (result !== 'ok') log.info(`${uuid}: ${result}`);
            } catch (err) {
                log.error('keys.run error:', err.message);
            }
        }
    }));
}
