// Global keys: Stop All, Mute Effects and the connection Status key.

const { Actions } = require('../utils/plugin');
const rt = require('../runtime');
const { renderStopAll, renderMute, renderStatus } = require('../render');

const conn = () => ({ connection: rt.state.connection, errorCode: rt.state.connectionError?.code ?? null });

function simpleAction(uuid, { render, live, press, feedback }) {
    const action = new Actions({
        default: {},
        _willAppear({ context, payload }) {
            rt.addKey(context, {
                uuid,
                coordinates: payload?.coordinates,
                settings: () => action.data[context] ?? {},
                render: custom => render(context, custom),
                live
            });
        },
        _willDisappear({ context }) { rt.removeKey(context); },
        ...rt.onPress(press, feedback)
    });
    rt.plugin.registerAction(uuid, action);
}

// Counter = sound voices in the last PLAYBACK snapshot; red breathing glow while any plays.
simpleAction('com.hotspot.streamdock.synk.stopall', {
    render: (context, custom) => renderStopAll({ ...conn(), custom, playingCount: rt.state.voiceCount, error: rt.keyError(context) }),
    live: () => (rt.state.connection === 'connected' && rt.state.voiceCount > 0 ? { color: rt.COLORS.red } : null),
    press: () => rt.api.stopAll(),
    feedback: () => ({ glyph: 'stop', color: rt.COLORS.red })
});

// Toggle from the latest known engine state (AUDIO_STATUS / GET_AUDIO). Mute never touches the volume.
simpleAction('com.hotspot.streamdock.synk.mute', {
    render: (context, custom) => renderMute({
        ...conn(),
        custom,
        muted: rt.state.effects.muted,
        supported: rt.state.muteSupported,
        error: rt.keyError(context)
    }),
    press: () => rt.api.setEffectsMuted(!(rt.state.effects.muted ?? false)),
    feedback: () => ({ color: rt.state.effects.muted ? rt.COLORS.green : rt.COLORS.red })
});

// Connection indicator. Press: reconnect now when offline, refresh GET_STATUS when online.
simpleAction('com.hotspot.streamdock.synk.status', {
    render: (context, custom) => renderStatus({
        ...conn(),
        custom,
        playingCount: rt.state.voiceCount,
        audioState: rt.state.audio.state,
        engineVersion: rt.state.engine.version
    }),
    press: async () => {
        if (rt.supervisor.connected) await rt.api.refreshStatus();
        else rt.supervisor.retryNow();
    },
    feedback: () => ({ color: rt.COLORS.white })
});
