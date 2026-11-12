// Effects volume on a knob, 0-200 %: rotate to change, press to mute/unmute.
//
// Implements STREAM_DECK_INTEGRATION.md section 8 exactly: ticks accumulate on a
// local target (never on a value echoed back by the engine), at most one
// SET_VOLUME is in flight, and turning during a request only updates the target,
// whose latest value is sent next. The host's dialRotate payload carries
// `payload.ticks` (+/-1 per detent, confirmed in the Spotify plugin's logs).

const { Actions } = require('../utils/plugin');
const rt = require('../runtime');
const { renderVolume } = require('../render');
const { cleanVolumeStep, round2, VOLUME_MAX } = require('../synk/validate');
const { SynkError, LOCAL_CODES } = require('../synk/errors');

let target = null;      // value the plugin wants, not yet confirmed
let inFlight = false;
let dirty = false;
let lastContext = null; // knob to flash an error on

function flush() {
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    dirty = false;
    const value = target;
    rt.api.setEffectsVolume(value).then(() => {
        inFlight = false;
        if (dirty) return flush();
        rt.state.setAudio({ volume: value });   // confirmed = target
        target = null;
        rt.state.setVolumePreview(null);
    }, err => {
        inFlight = false;
        dirty = false;
        target = null;
        rt.state.setVolumePreview(null);        // show(confirmed)
        if (lastContext) rt.flashError(lastContext, err);
    });
}

function onTicks(context, ticks, stepPercent) {
    const confirmed = rt.state.effects.volume;
    if (!rt.supervisor.connected || confirmed === null) {
        rt.supervisor.retryNow();
        if (!rt.supervisor.connected) rt.flashError(context, new SynkError(LOCAL_CODES.OFFLINE));
        return;
    }
    lastContext = context;
    const base = target ?? confirmed;
    target = Math.max(0, Math.min(VOLUME_MAX, round2(base + ticks * stepPercent / 100)));
    rt.state.setVolumePreview(target);          // immediate feedback
    flush();
}

rt.plugin.registerAction('com.hotspot.streamdock.synk.volume', new Actions({
    default: { step: 5 },

    _willAppear({ context }) {
        rt.addKey(context, {
            instant: true, // the value must follow the knob immediately, no dissolves
            render: () => renderVolume({
                volume: rt.state.displayVolume,
                muted: rt.state.effects.muted,
                connection: rt.state.connection,
                errorCode: rt.state.connectionError?.code ?? null,
                error: rt.keyError(context)
            })
        });
    },

    _willDisappear({ context }) { rt.removeKey(context); },

    // propertyInspector/volume sends the step size; the plugin validates and persists it.
    sendToPlugin({ context, payload }) {
        if (payload?.type !== 'setStep') return;
        const next = { step: cleanVolumeStep(payload.step) };
        this.data[context] = next;
        rt.plugin.setSettings(context, next);
    },

    dialRotate({ context, payload }) {
        const ticks = Number(payload?.ticks);
        if (!Number.isFinite(ticks) || ticks === 0) return;
        onTicks(context, Math.max(-20, Math.min(20, Math.trunc(ticks))), cleanVolumeStep(this.data[context]?.step));
    },

    // Knob press = mute toggle (section 7.4), with the same press/ripple feel as the keys.
    ...rt.onPress(
        () => rt.api.setEffectsMuted(!(rt.state.effects.muted ?? false)),
        () => ({ color: rt.state.effects.muted ? rt.COLORS.green : rt.COLORS.red }),
        { down: 'dialDown', up: 'dialUp' }
    )
}));

module.exports = { _test: { onTicks, state: () => ({ target, inFlight, dirty }) } };
