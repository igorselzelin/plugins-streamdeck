// Sound keys: Play, Play/Stop and Stop. Each key stores only the SYNK sound ID
// (plus a cached display name for when SYNK is offline) — never a path.

const { Actions } = require('../utils/plugin');
const rt = require('../runtime');
const { renderSound } = require('../render');
const { SynkError, LOCAL_CODES, toSynkError } = require('../synk/errors');
const { isValidSoundId, cleanName, cleanPlayMode } = require('../synk/validate');

const PI_LIST_TIMEOUT_MS = 10000;

function cleanSettings(raw = {}) {
    return {
        soundId: isValidSoundId(raw.soundId) ? raw.soundId : null,
        soundName: cleanName(raw.soundName),
        mode: cleanPlayMode(raw.mode)
    };
}

function requireSound(settings) {
    if (!settings?.soundId) throw new SynkError(LOCAL_CODES.INVALID_SOUND, 'no sound configured');
    return settings.soundId;
}

function pick(obj, fields) {
    const out = {};
    for (const f of fields) if (f in obj) out[f] = obj[f];
    return out;
}

// Sends the sound list (GET_LIBRARY) to the property inspector of one key.
async function replySounds(uuid, context, settings) {
    const reply = { type: 'sounds', connection: rt.state.connection, selected: settings ?? null, sounds: [], error: null };
    if (rt.state.connection === 'connected') {
        let timer;
        try {
            const sounds = await Promise.race([
                rt.api.listSounds(),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new SynkError(LOCAL_CODES.TIMEOUT, 'listSounds timed out')), PI_LIST_TIMEOUT_MS); })
            ]);
            reply.sounds = sounds;
        } catch (err) {
            reply.error = toSynkError(err).code;
        } finally {
            clearTimeout(timer);
        }
    } else {
        reply.error = rt.state.connectionError?.code ?? null;
    }
    reply.connection = rt.state.connection;
    rt.plugin.sendToPropertyInspector(uuid, context, reply);
}

function soundAction(uuid, variant, press, feedback) {
    const action = new Actions({
        default: { soundId: null, soundName: '', mode: 'overlap' },

        _willAppear({ context, payload }) {
            this.data[context] = cleanSettings(this.data[context]);
            const soundId = () => this.data[context]?.soundId ?? null;
            rt.addKey(context, {
                uuid,
                coordinates: payload?.coordinates,
                settings: () => this.data[context] ?? {},
                soundId,
                render: custom => {
                    const s = this.data[context];
                    if (!s) return null;
                    return renderSound({
                        variant,
                        soundId: s.soundId,
                        custom,
                        artwork: rt.artworkFor(s.soundId),
                        playing: rt.state.isPlaying(s.soundId),
                        missing: rt.state.isMissing(s.soundId),
                        connection: rt.state.connection,
                        errorCode: rt.state.connectionError?.code ?? null,
                        error: rt.keyError(context)
                    });
                },
                // Playing: breathing green glow + progress bar, drawn live by keyview.js
                live: () => {
                    const id = soundId();
                    if (!id || rt.state.connection !== 'connected' || rt.state.isMissing(id) || !rt.state.isPlaying(id)) return null;
                    return { color: rt.COLORS.green, progress: () => rt.state.progressOf(id) };
                }
            });
        },

        _willDisappear({ context }) {
            rt.removeKey(context);
        },

        _didReceiveSettings({ context }) {
            this.data[context] = cleanSettings(this.data[context]);
            rt.soundChanged(context);
            rt.refreshKey(context);
        },

        propertyInspectorDidAppear({ context }) {
            rt.setOpenInspector(context, () => replySounds(uuid, context, this.data[context]));
        },

        propertyInspectorDidDisappear({ context }) {
            rt.clearOpenInspector(context);
        },

        // Messages from propertyInspector/sound. The plugin validates and persists the choice.
        async sendToPlugin({ context, payload }) {
            if (!payload || typeof payload !== 'object' || !this.data[context]) return;
            if (payload.type === 'getSounds') {
                await replySounds(uuid, context, this.data[context]);
            } else if (payload.type === 'setSound') {
                const next = cleanSettings({ ...this.data[context], ...pick(payload, ['soundId', 'soundName', 'mode']) });
                if (payload.soundId && !next.soundId) { rt.log.warn('PI sent an invalid sound ID; ignored'); return; }
                this.data[context] = next;
                rt.plugin.setSettings(context, next);
                rt.soundChanged(context);
                rt.refreshKey(context);
            } else if (payload.type === 'retry') {
                rt.supervisor.retryNow();
            }
        },

        ...rt.onPress(({ context }) => press(action.data[context]), ({ context }) => feedback(action.data[context]))
    });
    rt.plugin.registerAction(uuid, action);
}

const PLAY_FX = () => ({ glyph: 'play', color: rt.COLORS.green });
const STOP_FX = () => ({ glyph: 'stop', color: rt.COLORS.white });

soundAction('com.hotspot.streamdock.synk.play', 'play',
    s => rt.api.playSound(requireSound(s), s.mode),
    PLAY_FX);

// The engine decides the toggle; the glyph follows what we know at press time.
soundAction('com.hotspot.streamdock.synk.toggle', 'toggle',
    s => rt.api.toggleSound(requireSound(s)),
    s => (rt.state.isPlaying(s?.soundId) ? STOP_FX() : PLAY_FX()));

soundAction('com.hotspot.streamdock.synk.stop', 'stop',
    s => rt.api.stopSound(requireSound(s)),
    STOP_FX);

module.exports = { cleanSettings };
