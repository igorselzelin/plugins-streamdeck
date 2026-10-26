const { Plugins, Actions, log } = require('../utils/plugin');
const { getPlayerState, playerCommand } = require('../spotifyApi');

const plugin = new Plugins();

let volumeBeforeMute = null;
let localVolume = null;
let volumeSeedPromise = null;
let volumeCommitTimer = null;

async function setPlayerVolume(percent) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await playerCommand(`volume?volume_percent=${clamped}`, 'Set volume', log);
    return clamped;
}

// Seeds localVolume from the API once, so repeated knob ticks don't each pay for a GET
// round-trip (a raw GET-then-PUT per tick was too slow to keep up with fast spins and
// raced with itself, silently dropping most of the turn).
async function ensureLocalVolume() {
    if (localVolume !== null) return;
    if (!volumeSeedPromise) {
        volumeSeedPromise = getPlayerState(log).then(data => {
            localVolume = data?.device?.volume_percent ?? 50;
        });
    }
    await volumeSeedPromise;
}

async function changeVolumeBy(deltaPercent) {
    await ensureLocalVolume();
    localVolume = Math.max(0, Math.min(100, localVolume + deltaPercent));
    if (localVolume > 0) volumeBeforeMute = localVolume;
    scheduleVolumeCommit();
}

// Coalesces bursts of ticks into a single PUT, fired shortly after the knob stops moving.
function scheduleVolumeCommit() {
    clearTimeout(volumeCommitTimer);
    volumeCommitTimer = setTimeout(() => {
        setPlayerVolume(localVolume).catch(err => log.error('setPlayerVolume error:', err.message));
    }, 150);
}

async function toggleMute() {
    await ensureLocalVolume();
    clearTimeout(volumeCommitTimer);
    if (localVolume > 0) {
        volumeBeforeMute = localVolume;
        localVolume = 0;
    } else {
        localVolume = volumeBeforeMute ?? 50;
    }
    await setPlayerVolume(localVolume);
}

// Extracts the rotation direction from a dialRotate payload.
// The exact field name isn't confirmed for this SDK — logged raw below so it can be adjusted after a real test.
function rotationSign(data) {
    const ticks = data?.payload?.ticks ?? data?.payload?.value ?? data?.payload?.delta ?? data?.ticks ?? 0;
    return Math.sign(ticks);
}

plugin.registerAction('com.hotspot.streamdock.spotifyvolume.action1', new Actions({
    default: {},

    async dialRotate(data) {
        log.info('dialRotate raw payload:', JSON.stringify(data));
        const sign = rotationSign(data);
        if (sign === 0) return;
        try { await changeVolumeBy(sign * 5); }
        catch (err) { log.error('changeVolumeBy error:', err.message); }
    },

    async dialDown() {
        try { await toggleMute(); }
        catch (err) { log.error('toggleMute error:', err.message); }
    }
}));
