const { Plugins, Actions, log } = require('../utils/plugin');
const { getPlayerState, playerCommand } = require('../spotifyApi');

const plugin = new Plugins();

const SYNC_MS = 15000; // pick up shuffle changes made from inside Spotify itself
const contexts = new Set();
let syncTimer = null;

// Returns true/false, or null when no device is active
async function getShuffle() {
    const data = await getPlayerState(log);
    return data ? !!data.shuffle_state : null;
}

// Flips shuffle and returns the new state, or null if there is no active device
async function toggleShuffle() {
    const current = await getShuffle();
    if (current === null) return null;
    await playerCommand(`shuffle?state=${!current}`, 'Set shuffle', log);
    return !current;
}

// State 0 = shuffle off (gray icon), state 1 = shuffle on (green icon)
async function syncState() {
    try {
        const shuffle = await getShuffle();
        if (shuffle === null) return; // no active device — keep whatever is shown
        for (const ctx of contexts) plugin.setState(ctx, shuffle ? 1 : 0);
    } catch (err) {
        log.error('syncState error:', err.message);
    }
}

plugin.registerAction('com.hotspot.streamdock.spotifyshuffle.action1', new Actions({
    default: {},

    _willAppear({ context }) {
        contexts.add(context);
        syncState();
        if (!syncTimer) syncTimer = setInterval(syncState, SYNC_MS);
    },

    _willDisappear({ context }) {
        contexts.delete(context);
        if (contexts.size === 0 && syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    },

    async keyUp({ context }) {
        try {
            const shuffle = await toggleShuffle();
            if (shuffle === null) { log.info('toggleShuffle: no active Spotify device'); return; }
            plugin.setState(context, shuffle ? 1 : 0);
        } catch (err) {
            log.error('toggleShuffle error:', err.message);
        }
    }
}));
