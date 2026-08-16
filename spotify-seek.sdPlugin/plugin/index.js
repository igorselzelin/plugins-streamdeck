const { Plugins, Actions, log } = require('./utils/plugin');
const { SpotifySeekClient } = require('./spotify');

// Credentials live in config.js (outside git — see config.example.js and .gitignore)
const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN } = require('./config');

const plugin = new Plugins();
const client = new SpotifySeekClient(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN, log);

// Extracts the rotation direction from a dialRotate payload.
// The exact field name isn't confirmed for this SDK — logged raw below so it can be adjusted after a real test.
function rotationSign(data) {
    const ticks = data?.payload?.ticks ?? data?.payload?.value ?? data?.payload?.delta ?? data?.ticks ?? 0;
    return Math.sign(ticks);
}

plugin.action1 = new Actions({
    default: {},

    async dialRotate(data) {
        log.info('dialRotate raw payload:', JSON.stringify(data));
        const sign = rotationSign(data);
        if (sign === 0) return;
        try { await client.seekBy(sign * 5000); }
        catch (err) { log.error('seekBy error:', err.message); }
    }
});
