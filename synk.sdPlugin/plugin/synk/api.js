// The operations the keys need from SYNK, mapped exactly as in
// STREAM_DECK_INTEGRATION.md section 13. Only documented commands, params and
// events are used; unknown events are ignored silently (AUDIO_LEVELS arrives at ~15 Hz).

const { SynkError, LOCAL_CODES } = require('./errors');
const { isValidSoundId, cleanName, cleanVolume, VOLUME_MAX } = require('./validate');

const PLAY_TIMEOUT_MS = 5000;           // section 5: PLAY_SOUND 5 s, everything else 3 s
const LIBRARY_DEBOUNCE_MS = 600;        // section 9: debounce LIBRARY_CHANGED >= 500 ms
const SHUTDOWN_RECONNECT_DELAY_MS = 1000;
const LIBRARY_PAGE = 1000;
const LIBRARY_MAX_PAGES = 50;
const ARTWORK_MIMES = new Set(['image/jpeg', 'image/png']);

function parseSound(s) {
    if (!s || typeof s !== 'object' || !isValidSoundId(s.id)) return null;
    return {
        id: s.id,
        name: cleanName(s.name) || s.id,
        hasArtwork: s.has_artwork === true,
        updatedAt: Number.isFinite(s.updated_at_ms) ? s.updated_at_ms : null
    };
}

/**
 * @param {object} deps
 * @param {import('./supervisor').Supervisor} deps.supervisor
 * @param {import('./state').SynkState} deps.state
 * @param {() => string[]} deps.visibleSoundIds   sound IDs on keys currently on screen
 * @param {() => void} deps.onLibraryChanged      called after a (debounced) library change or a resync
 */
function createApi({ supervisor, state, log, visibleSoundIds = () => [], onLibraryChanged = () => {} }) {
    // Snapshot vs. event race rule (section 10): an event newer than the request wins.
    let playbackSeq = 0;
    let audioSeq = 0;
    let libraryTimer = null;

    const call = (cmd, params, timeoutMs) => supervisor.call(cmd, params, timeoutMs);

    function applyPlayback(data) {
        if (!data || !Array.isArray(data.voices)) return;
        state.setVoices(data.voices
            .filter(v => v && v.kind === 'sound' && typeof v.sound_id === 'string')
            .map((v, i) => ({
                id: Number.isFinite(v.voice_id) ? v.voice_id : `i${i}`,
                soundId: v.sound_id,
                durationMs: Number.isFinite(v.duration_ms) && v.duration_ms > 0 ? v.duration_ms : null
            })));
    }

    function applyAudio(info) {
        if (!info || typeof info !== 'object') return;
        state.setAudio({
            volume: cleanVolume(info.effects_volume) ?? undefined,
            muted: typeof info.effects_muted === 'boolean' ? info.effects_muted : undefined,
            state: typeof info.state === 'string' ? info.state : undefined,
            error: typeof info.error === 'string' ? info.error : info.error === null ? null : undefined
        });
    }

    async function fetchPlayback() {
        const seq = playbackSeq;
        const r = await call('GET_PLAYBACK');
        if (seq === playbackSeq) applyPlayback(r);
    }

    async function fetchAudio() {
        const seq = audioSeq;
        const r = await call('GET_AUDIO');
        if (seq === audioSeq) applyAudio(r);
    }

    async function fetchStatus() {
        const r = await call('GET_STATUS');
        if (r && typeof r.engine_version === 'string') state.setEngine({ version: r.engine_version.slice(0, 20) });
    }

    // GET_SOUND for each sound on a visible key: refreshes names/artwork flags, detects deletion.
    async function refreshSounds(ids) {
        const unique = [...new Set(ids)].filter(isValidSoundId);
        await Promise.all(unique.map(id => call('GET_SOUND', { sound_id: id })
            .then(s => { const parsed = parseSound(s); if (parsed && parsed.id === id) state.upsertSound(parsed); })
            .catch(e => {
                if (e.code === 'NOT_FOUND') state.markMissing(id);
                else if (e.code !== 'OFFLINE' && e.code !== 'DISCONNECTED') log?.warn(`GET_SOUND failed: ${e.code}`);
            })));
    }

    function scheduleLibraryRefresh() {
        clearTimeout(libraryTimer);
        libraryTimer = setTimeout(() => {
            libraryTimer = null;
            if (!supervisor.connected) return;
            refreshSounds(visibleSoundIds()).catch(() => {});
            onLibraryChanged();
        }, LIBRARY_DEBOUNCE_MS);
    }

    // Wraps a sound command: NOT_FOUND marks the sound as removed, for a persistent label.
    async function soundCommand(cmd, soundId, extra, timeoutMs) {
        if (!isValidSoundId(soundId)) throw new SynkError(LOCAL_CODES.INVALID_SOUND, 'no valid sound configured');
        try {
            return await call(cmd, { sound_id: soundId, ...extra }, timeoutMs);
        } catch (e) {
            if (e.code === 'NOT_FOUND') state.markMissing(soundId);
            throw e;
        }
    }

    return {
        limits: { volumeMax: VOLUME_MAX },

        // SYNCING after welcome (section 10): in parallel, each failure isolated.
        async syncAll() {
            const results = await Promise.allSettled([
                fetchAudio(), fetchPlayback(), fetchStatus(), refreshSounds(visibleSoundIds())
            ]);
            onLibraryChanged();
            const failed = results.filter(r => r.status === 'rejected');
            if (failed.length) log?.warn(`SYNK sync: ${failed.map(r => r.reason?.code).join(', ')}`);
        },

        handleEvent(name, data) {
            switch (name) {
                case 'PLAYBACK': playbackSeq++; applyPlayback(data); break;
                case 'AUDIO_STATUS': audioSeq++; applyAudio(data); break;
                case 'LIBRARY_CHANGED': scheduleLibraryRefresh(); break;
                case 'SHUTTING_DOWN':
                    log?.info('SYNK is shutting down');
                    supervisor.reconnectAfter(SHUTDOWN_RECONNECT_DELAY_MS);
                    break;
                default: break; // STATUS, AUDIO_LEVELS, IMPORT_UPDATED, ... and unknown events: ignored
            }
        },

        refreshSounds,
        refreshStatus: fetchStatus,

        // GET_LIBRARY, paging with `total` (section 7.5).
        async listSounds() {
            const out = [];
            for (let page = 0, offset = 0; page < LIBRARY_MAX_PAGES; page++) {
                const r = await call('GET_LIBRARY', { limit: LIBRARY_PAGE, offset });
                if (!r || !Array.isArray(r.sounds)) throw new SynkError(LOCAL_CODES.BAD_RESPONSE, 'GET_LIBRARY returned no sounds array');
                for (const s of r.sounds) {
                    const parsed = parseSound(s);
                    if (parsed) out.push({ id: parsed.id, name: parsed.name });
                }
                offset += r.sounds.length;
                const total = Number.isFinite(r.total) ? r.total : offset;
                if (r.sounds.length === 0 || offset >= total) break;
            }
            return out;
        },

        // Only when the sound has artwork (section 7.6). NOT_FOUND -> null.
        async getArtwork(soundId) {
            if (!isValidSoundId(soundId) || !state.sounds.get(soundId)?.hasArtwork) return null;
            try {
                const r = await call('GET_ARTWORK', { sound_id: soundId });
                if (!r || !ARTWORK_MIMES.has(r.mime) || typeof r.data_base64 !== 'string' || !r.data_base64) return null;
                return `data:${r.mime};base64,${r.data_base64}`;
            } catch (e) {
                if (e.code === 'NOT_FOUND') return null;
                throw e;
            }
        },

        playSound(soundId, mode) {
            const m = mode === 'restart' ? 'restart' : 'overlap';
            return soundCommand('PLAY_SOUND', soundId, { mode: m }, PLAY_TIMEOUT_MS);
        },

        // Toggle is decided by the engine atomically (section 7.1), never client-side.
        toggleSound(soundId) {
            return soundCommand('PLAY_SOUND', soundId, { mode: 'toggle' }, PLAY_TIMEOUT_MS);
        },

        stopSound(soundId) {
            return soundCommand('STOP_SOUND', soundId, {});
        },

        stopAll() {
            return call('STOP_ALL');
        },

        // Mute is a separate flag in the engine: the stored volume is preserved (section 7.4).
        async setEffectsMuted(muted) {
            const seq = audioSeq;
            try {
                const info = await call('SET_MUTE', { target: 'effects', muted: !!muted });
                if (seq === audioSeq) applyAudio(info);
                state.setMuteSupported(true);
                return info;
            } catch (e) {
                if (e.code === 'UNKNOWN_COMMAND' || e.code === 'NOT_IMPLEMENTED') state.setMuteSupported(false);
                throw e;
            }
        },

        // Absolute value, clamped by the plugin (the engine does not clamp).
        setEffectsVolume(volume) {
            const v = cleanVolume(volume);
            if (v === null) return Promise.reject(new SynkError('INVALID_PARAMS', 'volume is not a number'));
            return call('SET_VOLUME', { target: { kind: 'effects' }, volume: v });
        },

        dispose() {
            clearTimeout(libraryTimer);
        }
    };
}

module.exports = { createApi, parseSound, PLAY_TIMEOUT_MS, LIBRARY_DEBOUNCE_MS };
