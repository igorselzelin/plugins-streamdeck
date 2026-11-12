// Validation for anything that comes from key settings, the property inspector or the engine.
// A key stores only a SYNK sound ID — never a path, URL or command.

// STREAM_DECK_INTEGRATION.md section 6: sound IDs are UUIDs, sent by the engine as
// lowercase hyphenated strings. Stored and sent exactly as received.
const SOUND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidSoundId(id) {
    return typeof id === 'string' && SOUND_ID.test(id);
}

// Display-only name cached in the key settings so it still has a label offline.
function cleanName(name) {
    if (typeof name !== 'string') return '';
    return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
}

const PLAY_MODES = ['overlap', 'restart'];

function cleanPlayMode(mode) {
    return PLAY_MODES.includes(mode) ? mode : 'overlap';
}

const VOLUME_STEPS = [1, 2, 5, 10];

function cleanVolumeStep(step) {
    const n = Number(step);
    return VOLUME_STEPS.includes(n) ? n : 5;
}

const VOLUME_MAX = 2.0; // protocol v1 constant (section 13)

const round2 = v => Math.round(v * 100) / 100;

// Engine volumes are 32-bit floats (0.8 -> 0.800000011920929): round on receipt (section 6).
function cleanVolume(v) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(VOLUME_MAX, round2(v))) : null;
}

module.exports = {
    isValidSoundId, cleanName, cleanPlayMode, cleanVolumeStep, cleanVolume, round2,
    PLAY_MODES, VOLUME_STEPS, VOLUME_MAX
};
