const { httpsRequest, getPlayerState, getQueue, playerCommand } = require('./spotifyApi');
const { SIZE, decodeToRaster } = require('./raster');

// Poll cadence. A fixed 3s interval meant a new track could take up to 3s (plus a
// full-size cover download) to show up; now the loop polls faster while playing and
// also wakes up right when the current track is predicted to end.
const PLAYING_MS = 1000;
const PAUSED_MS = 1500;
const NO_DEVICE_MS = 2500;
const ERROR_MS = 3000;
const TRACK_END_SLACK_MS = 150;  // poll this long after the predicted end of the track
const PREFETCH_BEFORE_END_MS = 20000;
const COVER_CACHE_MAX = 12;

// Smallest cover that still covers the key (Spotify sends 640/300/64 px): the 300px one
// downloads and decodes several times faster than the 640px one with no visible loss.
function pickImageUrl(item) {
    const images = (item.album?.images ?? item.images ?? []).filter(i => i?.url);
    if (!images.length) return null;
    const bigEnough = images.filter(i => (i.width ?? 0) >= SIZE).sort((a, b) => a.width - b.width);
    return (bigEnough[0] ?? images[0]).url;
}

function trackKey(item) {
    return item.id ?? item.uri ?? item.name;
}

// url → Promise<raster>, decoded once and kept for the last few covers
class CoverCache {
    constructor(log) {
        this.log = log;
        this.map = new Map();
    }

    get(url) {
        let entry = this.map.get(url);
        if (entry) {
            this.map.delete(url);   // refresh LRU position
            this.map.set(url, entry);
            return entry;
        }
        entry = httpsRequest('GET', url, null).then(res => {
            if (res.status !== 200) throw new Error('Image download failed: ' + res.status);
            return decodeToRaster(res.body);
        });
        entry.catch(() => this.map.delete(url));
        this.map.set(url, entry);
        while (this.map.size > COVER_CACHE_MAX) this.map.delete(this.map.keys().next().value);
        return entry;
    }

    prefetch(url) {
        if (url) this.get(url).catch(err => this.log.error('Cover prefetch error:', err.message));
    }
}

class SpotifyPoller {
    constructor(onStateChange, onError, log) {
        this.onStateChange = onStateChange;
        this.onError = onError;
        this.log = log;
        this.covers = new CoverCache(log);
        this.lastTrackId = null;
        this.lastIsPlaying = null;
        this.expected = null;        // { isPlaying, until } after an optimistic toggle
        this.prefetchedFor = null;   // track id whose "next cover" was already prefetched late in the track
        this.timer = null;
        this.inflight = false;
        this.soon = null;
        this.running = false;
    }

    // Called right after an optimistic play/pause: polls that still report the old state
    // (Spotify takes a moment to reflect the command) are ignored until `ms` passes,
    // instead of flipping the key back and forth.
    expectPlaying(isPlaying, ms = 2500) {
        this.expected = { isPlaying, until: Date.now() + ms };
        this.lastIsPlaying = isPlaying;
    }

    // Forgets the assumed play state and polls now, so the real state is re-emitted
    // (used when an optimistic play/pause command failed)
    resync() {
        this.expected = null;
        this.lastIsPlaying = null;
        this.pollSoon(0);
    }

    async poll() {
        if (!this.running) return;
        if (this.inflight) return;
        this.inflight = true;
        let next = ERROR_MS;

        try {
            const sentAt = Date.now();
            const data = await getPlayerState(this.log);
            if (!this.running) return;

            if (!data || !data.item) {
                next = NO_DEVICE_MS;
                if (this.lastTrackId !== null) {
                    this.lastTrackId = null;
                    this.lastIsPlaying = null;
                    this.expected = null;
                    this.onStateChange(null);
                }
                return;
            }

            const item = data.item;
            const trackId = trackKey(item);
            let isPlaying = data.is_playing;

            if (this.expected) {
                if (isPlaying === this.expected.isPlaying || Date.now() > this.expected.until || trackId !== this.lastTrackId) {
                    this.expected = null;
                } else {
                    isPlaying = this.lastIsPlaying; // stale answer from before the command landed
                }
            }

            if (trackId !== this.lastTrackId) {
                const url = pickImageUrl(item);
                let cover = null;
                try { cover = url ? await this.covers.get(url) : null; }
                catch (err) { this.log.error('Cover download error:', err.message); }
                if (!this.running) return;

                this.lastTrackId = trackId;
                this.lastIsPlaying = isPlaying;
                this.emit(item, cover, isPlaying);
                this.prefetchNext();
            } else if (isPlaying !== this.lastIsPlaying) {
                this.lastIsPlaying = isPlaying;
                this.emit(item, undefined, isPlaying);
            }

            if (data.is_playing) {
                next = PLAYING_MS;
                const elapsed = (Date.now() - sentAt) / 2; // progress was sampled mid-request
                const remaining = (item.duration_ms ?? Infinity) - (data.progress_ms ?? 0) - elapsed;
                if (remaining + TRACK_END_SLACK_MS < next) next = Math.max(80, remaining + TRACK_END_SLACK_MS);
                if (remaining < PREFETCH_BEFORE_END_MS && this.prefetchedFor !== trackId) {
                    this.prefetchedFor = trackId; // queue may have changed since the track started
                    this.prefetchNext();
                }
            } else {
                next = PAUSED_MS;
            }
        } catch (err) {
            this.log.error('SpotifyPoller error:', err.message);
            if (err.retryAfterMs) next = Math.max(next, err.retryAfterMs);
            if (this.onError) this.onError(err);
        } finally {
            this.inflight = false;
            if (this.soon !== null) { next = Math.min(next, this.soon); this.soon = null; }
            this.schedule(next);
        }
    }

    emit(item, cover, isPlaying) {
        const artist = (item.artists ?? []).map(a => a.name).join(', ') || item.show?.name || '';
        this.log.info(`${isPlaying ? '▶' : '⏸'} ${item.name} — ${artist}`);
        this.onStateChange({
            id: trackKey(item),
            name: item.name,
            artist,
            cover,          // raster for a new track, undefined when only play/pause changed
            isPlaying
        });
    }

    // Downloads + decodes the next queued cover in the background so it's already in
    // memory when the track changes.
    async prefetchNext() {
        try {
            const queue = await getQueue(this.log);
            const nextItem = queue?.queue?.[0];
            if (nextItem) this.covers.prefetch(pickImageUrl(nextItem));
        } catch (err) {
            this.log.error('Queue prefetch error:', err.message);
        }
    }

    schedule(ms) {
        if (!this.running) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.poll(), ms);
    }

    // Poll again within `ms` (sooner than the regular cadence)
    pollSoon(ms = 0) {
        if (!this.running) return;
        if (this.inflight) this.soon = Math.min(this.soon ?? ms, ms);
        else this.schedule(ms);
    }

    pausePlayback() {
        return playerCommand('pause', 'Pause', this.log);
    }

    resumePlayback() {
        return playerCommand('play', 'Resume', this.log);
    }

    start() {
        this.running = true;
        this.poll();
    }

    stop() {
        this.running = false;
        clearTimeout(this.timer);
    }
}

module.exports = { SpotifyPoller };
