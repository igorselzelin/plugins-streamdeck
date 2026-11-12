// What the keys need to know about SYNK, in the plugin's own terms.
// api.js translates SYNK's responses and events into these setters; the
// actions only read from here and listen for 'change'.

const { EventEmitter } = require('events');

class SynkState extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(50);
        this.connection = 'stopped';   // supervisor STATES value
        this.connectionError = null;   // SynkError | null
        this.playing = new Map();      // soundId -> number of 'sound' voices
        this.voices = new Map();       // voice_id -> { soundId, durationMs, seenAt }
        this.sounds = new Map();       // id -> { id, name, hasArtwork, updatedAt }
        this.missing = new Set();      // sound IDs the engine answered NOT_FOUND for
        this.effects = { volume: null, muted: null }; // linear gain 0..2 rounded to 0.01; null = unknown
        this.volumePreview = null;     // knob target not yet confirmed by the engine
        this.muteSupported = null;     // false when the engine answered UNKNOWN_COMMAND to SET_MUTE
        this.audio = { state: null, error: null };    // AudioInfo.state / .error
        this.engine = { version: null };
    }

    setConnection(state, error = null) {
        this.connection = state;
        this.connectionError = error;
        if (state !== 'connected') {
            // Nothing can be known while SYNK is out of sight. Names are kept as offline labels.
            this.playing = new Map();
            this.voices = new Map();
            this.effects = { volume: null, muted: null };
            this.volumePreview = null;
            this.audio = { state: null, error: null };
        }
        this.emit('change', 'connection');
    }

    setPlaying(soundIds) {
        this.setVoices(soundIds.map((soundId, i) => ({ id: `v${i}`, soundId, durationMs: null })));
    }

    // Full PLAYBACK snapshot: [{ id, soundId, durationMs }]. Keeps when each voice was
    // first seen, which gives the progress bar (the engine reports no position).
    setVoices(list) {
        const t = Date.now();
        const voices = new Map();
        for (const v of list) {
            const prev = this.voices.get(v.id);
            voices.set(v.id, { soundId: v.soundId, durationMs: v.durationMs, seenAt: prev && prev.soundId === v.soundId ? prev.seenAt : t });
        }
        this.voices = voices;
        const next = new Map();
        for (const v of list) next.set(v.soundId, (next.get(v.soundId) || 0) + 1);
        if (sameCounts(next, this.playing)) return;
        this.playing = next;
        this.emit('change', 'playing');
    }

    isPlaying(soundId) {
        return !!soundId && this.playing.has(soundId);
    }

    // 0..1 for the newest voice of this sound, or null when unknown.
    progressOf(soundId) {
        let newest = null;
        for (const v of this.voices.values()) {
            if (v.soundId === soundId && (!newest || v.seenAt > newest.seenAt)) newest = v;
        }
        if (!newest || !(newest.durationMs > 0)) return null;
        return Math.max(0, Math.min(1, (Date.now() - newest.seenAt) / newest.durationMs));
    }

    // Number of sound voices (Stop All counter).
    get voiceCount() {
        let n = 0;
        for (const c of this.playing.values()) n += c;
        return n;
    }

    upsertSound(s) {
        const prev = this.sounds.get(s.id);
        const next = { id: s.id, name: s.name, hasArtwork: !!s.hasArtwork, updatedAt: s.updatedAt ?? null };
        const wasMissing = this.missing.delete(s.id);
        if (!wasMissing && prev && prev.name === next.name && prev.hasArtwork === next.hasArtwork && prev.updatedAt === next.updatedAt) return;
        this.sounds.set(s.id, next);
        this.emit('change', 'sound');
    }

    markMissing(soundId) {
        if (this.missing.has(soundId)) return;
        this.missing.add(soundId);
        this.emit('change', 'sound');
    }

    isMissing(soundId) {
        return !!soundId && this.missing.has(soundId);
    }

    soundName(soundId) {
        return this.sounds.get(soundId)?.name ?? null;
    }

    setAudio({ volume, muted, state, error }) {
        let changed = false;
        if (volume !== undefined && volume !== this.effects.volume) { this.effects = { ...this.effects, volume }; changed = true; }
        if (muted !== undefined && muted !== this.effects.muted) {
            this.effects = { ...this.effects, muted };
            if (muted !== null) this.muteSupported = this.muteSupported ?? true;
            changed = true;
        }
        if (state !== undefined && state !== this.audio.state) { this.audio = { ...this.audio, state }; changed = true; }
        if (error !== undefined && error !== this.audio.error) { this.audio = { ...this.audio, error }; changed = true; }
        if (changed) this.emit('change', 'audio');
    }

    setVolumePreview(v) {
        if (v === this.volumePreview) return;
        this.volumePreview = v;
        this.emit('change', 'audio');
    }

    // What the knob / mute key should show: the knob target while turning, else the engine's value.
    get displayVolume() {
        return this.volumePreview ?? this.effects.volume;
    }

    setMuteSupported(supported) {
        if (supported === this.muteSupported) return;
        this.muteSupported = supported;
        this.emit('change', 'audio');
    }

    setEngine({ version }) {
        if (version === this.engine.version) return;
        this.engine = { version };
        this.emit('change', 'engine');
    }
}

function sameCounts(a, b) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    return true;
}

module.exports = { SynkState };
