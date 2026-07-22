const path = require('path');
const Jimp = require('jimp');
const { spawn } = require('child_process');
const { Plugins, Actions, log } = require('./utils/plugin');
const { SpotifyPoller } = require('./spotify');
const { renderTrackCard, preRenderFrames } = require('./renderTrackCard');

// Credenciais ficam em config.js (fora do git — veja config.example.js e .gitignore)
const {
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REFRESH_TOKEN,
    SPOTIFY_EXE
} = require('./config');

const SPOTIFY_LOGO = path.join(process.cwd(), '../static/spotify.png');

const CREDENTIALS_OK = !SPOTIFY_CLIENT_ID.startsWith('SEU_');
const SIZE = 126;

const plugin = new Plugins();
let poller = null;
let currentTrack = null;   // { name, artist, imageBase64, isPlaying }
let frameCache = null;     // { playing, paused, toPause[], toPlay[] }
let currentDisplayB64 = null;
const activeContexts = new Set();
let animToken = { cancelled: false };

function cancelAnim() {
    animToken.cancelled = true;
    animToken = { cancelled: false };
    return animToken;
}

async function sendFrames(contexts, frames, intervalMs, token) {
    for (const b64 of frames) {
        if (token.cancelled) return;
        currentDisplayB64 = b64;
        for (const ctx of contexts) plugin.setImage(ctx, `data:image/jpeg;base64,${b64}`);
        await new Promise(r => setTimeout(r, intervalMs));
    }
}

async function fadeTransition(contexts, fromB64, toB64, token, steps = 5, ms = 40) {
    const black = new Jimp(SIZE, SIZE, 0x000000ff);

    if (fromB64) {
        const fromImg = await Jimp.read(Buffer.from(fromB64, 'base64'));
        for (let i = 1; i <= steps; i++) {
            if (token.cancelled) return;
            const f = fromImg.clone();
            f.composite(black, 0, 0, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: i / steps, opacityDest: 1 });
            const b64 = (await f.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
            currentDisplayB64 = b64;
            for (const ctx of contexts) plugin.setImage(ctx, `data:image/jpeg;base64,${b64}`);
            await new Promise(r => setTimeout(r, ms));
        }
    }

    if (token.cancelled) return;

    const toImg = await Jimp.read(Buffer.from(toB64, 'base64'));
    for (let i = steps - 1; i >= 0; i--) {
        if (token.cancelled) return;
        const f = toImg.clone();
        f.composite(black, 0, 0, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: i / steps, opacityDest: 1 });
        const b64 = (await f.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
        currentDisplayB64 = b64;
        for (const ctx of contexts) plugin.setImage(ctx, `data:image/jpeg;base64,${b64}`);
        await new Promise(r => setTimeout(r, ms));
    }
}

function showSpotifyLogo() {
    currentDisplayB64 = null;
    for (const ctx of activeContexts) {
        plugin.setTitle(ctx, '');
        plugin.setImage(ctx, SPOTIFY_LOGO);
    }
}

async function tryActivateSpotify() {
    for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (currentTrack !== null || !poller) return;
        try { await poller.resumePlayback(); return; }
        catch (_) { }
    }
}

async function renderContext(context, track, token) {
    plugin.setTitle(context, '');
    if (!track) {
        plugin.setImage(context, SPOTIFY_LOGO);
        return;
    }
    if (!track.imageBase64) return;
    const b64 = frameCache
        ? (track.isPlaying ? frameCache.playing : frameCache.paused)
        : await renderTrackCard(track.imageBase64, !track.isPlaying);
    if (token?.cancelled) return;
    currentDisplayB64 = b64;
    plugin.setImage(context, `data:image/jpeg;base64,${b64}`);
}

async function onStateChange(track) {
    const isSameState = currentTrack && track &&
        track.name === currentTrack.name &&
        track.isPlaying === currentTrack.isPlaying;

    if (isSameState) return;

    const isNewTrack = !currentTrack || !track || track.name !== currentTrack.name;
    const oldB64 = currentDisplayB64;
    currentTrack = track;

    const token = cancelAnim();

    if (isNewTrack) {
        frameCache = null;

        if (track?.imageBase64) {
            for (const ctx of activeContexts) plugin.setTitle(ctx, '');
            const newB64 = await renderTrackCard(track.imageBase64, !track.isPlaying);
            if (token.cancelled) return;

            await fadeTransition([...activeContexts], oldB64, newB64, token);

            if (!token.cancelled) {
                preRenderFrames(track.imageBase64)
                    .then(cache => { frameCache = cache; log.info('Frames prontos'); })
                    .catch(err => log.error('preRenderFrames erro:', err.message));
            }
        } else {
            // Spotify fechado ou sem faixa — exibe logo
            showSpotifyLogo();
        }
    } else {
        for (const ctx of activeContexts) await renderContext(ctx, track, token);
    }
}

plugin.action1 = new Actions({
    default: {},

    _willAppear({ context }) {
        activeContexts.add(context);

        if (!CREDENTIALS_OK) {
            plugin.setTitle(context, 'Configure\nSpotify');
            return;
        }

        if (currentTrack) {
            renderContext(context, currentTrack, animToken);
        } else {
            plugin.setTitle(context, '');
            plugin.setImage(context, SPOTIFY_LOGO);
        }

        if (!poller) {
            poller = new SpotifyPoller(
                SPOTIFY_CLIENT_ID,
                SPOTIFY_CLIENT_SECRET,
                SPOTIFY_REFRESH_TOKEN,
                onStateChange,
                (err) => log.error('Spotify erro:', err),
                log
            );
            poller.start(3000);
        }
    },

    _willDisappear({ context }) {
        activeContexts.delete(context);
        if (activeContexts.size === 0 && poller) {
            poller.stop();
            poller = null;
        }
    },

    _propertyInspectorDidAppear(data) { },

    async keyUp({ context }) {
        if (!poller) return;

        // Spotify fechado: abre o app
        if (!currentTrack) {
            spawn(SPOTIFY_EXE, [], { detached: true, stdio: 'ignore' }).unref();
            tryActivateSpotify();
            return;
        }

        plugin.setTitle(context, '');

        const wasPlaying = currentTrack.isPlaying;

        const apiPromise = wasPlaying
            ? poller.pausePlayback()
            : poller.resumePlayback();

        currentTrack = { ...currentTrack, isPlaying: !wasPlaying };

        const token = cancelAnim();

        if (frameCache) {
            await sendFrames([context], wasPlaying ? frameCache.toPause : frameCache.toPlay, 40, token);
        } else {
            const b64 = await renderTrackCard(currentTrack.imageBase64, !currentTrack.isPlaying);
            if (!token.cancelled) {
                currentDisplayB64 = b64;
                plugin.setImage(context, `data:image/jpeg;base64,${b64}`);
            }
        }

        try { await apiPromise; }
        catch (err) { log.error('keyUp API erro:', err.message); }
    },

    dialRotate(data) { log.info('dialRotate', data); },
    dialDown(data)   { log.info('dialDown', data); }
});
