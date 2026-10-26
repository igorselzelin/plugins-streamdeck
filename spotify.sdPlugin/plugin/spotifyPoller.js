const { httpsRequest, getPlayerState, playerCommand } = require('./spotifyApi');

async function downloadImageAsBase64(imageUrl) {
    const res = await httpsRequest('GET', imageUrl, null);
    if (res.status !== 200) throw new Error('Image download failed: ' + res.status);
    return res.body.toString('base64');
}

class SpotifyPoller {
    constructor(onStateChange, onError, log) {
        this.onStateChange = onStateChange;
        this.onError = onError;
        this.log = log;
        this.lastTrackId = null;
        this.lastIsPlaying = null;
        this.lastImageBase64 = null;
        this.timer = null;
    }

    async poll() {
        try {
            const data = await getPlayerState(this.log);

            if (!data || !data.item) {
                if (this.lastTrackId !== null) {
                    this.lastTrackId = null;
                    this.lastIsPlaying = null;
                    this.lastImageBase64 = null;
                    this.onStateChange(null);
                }
                return;
            }

            const track = data.item;
            const trackId = track.id;
            const isPlaying = data.is_playing;

            // Download image only when the track changes
            if (trackId !== this.lastTrackId) {
                const imageUrl = track.album.images[0]?.url;
                this.lastImageBase64 = imageUrl ? await downloadImageAsBase64(imageUrl) : null;
            }

            // Fire callback if the track or play/pause state changed
            if (trackId !== this.lastTrackId || isPlaying !== this.lastIsPlaying) {
                this.lastTrackId = trackId;
                this.lastIsPlaying = isPlaying;
                const artist = track.artists.map(a => a.name).join(', ');
                this.log.info(`${isPlaying ? '▶' : '⏸'} ${track.name} — ${artist}`);
                this.onStateChange({
                    name: track.name,
                    artist,
                    imageBase64: this.lastImageBase64,
                    isPlaying
                });
            }
        } catch (err) {
            this.log.error('SpotifyPoller error:', err.message);
            if (this.onError) this.onError(err);
        }
    }

    pausePlayback() {
        return playerCommand('pause', 'Pause', this.log);
    }

    resumePlayback() {
        return playerCommand('play', 'Resume', this.log);
    }

    start(intervalMs = 3000) {
        this.poll();
        this.timer = setInterval(() => this.poll(), intervalMs);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }
}

module.exports = { SpotifyPoller };
