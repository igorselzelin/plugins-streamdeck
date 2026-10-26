const { Plugins, Actions, log } = require('../utils/plugin');
const { getPlayerState, playerCommand } = require('../spotifyApi');

const plugin = new Plugins();

async function seekBy(deltaMs) {
    const data = await getPlayerState(log);
    if (!data || !data.item) return;
    const newPositionMs = Math.max(0, Math.min(data.item.duration_ms, data.progress_ms + deltaMs));
    await playerCommand(`seek?position_ms=${newPositionMs}`, 'Seek', log);
}

// Extracts the rotation direction from a dialRotate payload.
// The exact field name isn't confirmed for this SDK — logged raw below so it can be adjusted after a real test.
function rotationSign(data) {
    const ticks = data?.payload?.ticks ?? data?.payload?.value ?? data?.payload?.delta ?? data?.ticks ?? 0;
    return Math.sign(ticks);
}

plugin.registerAction('com.hotspot.streamdock.spotifyseek.action1', new Actions({
    default: {},

    async dialRotate(data) {
        log.info('dialRotate raw payload:', JSON.stringify(data));
        const sign = rotationSign(data);
        if (sign === 0) return;
        try { await seekBy(sign * 5000); }
        catch (err) { log.error('seekBy error:', err.message); }
    }
}));
