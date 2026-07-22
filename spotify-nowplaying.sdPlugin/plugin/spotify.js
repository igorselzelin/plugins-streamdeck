const https = require('https');

function httpsRequest(method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method,
            headers: { ...headers }
        };
        if (data) {
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(data);
        } else {
            options.headers['Content-Length'] = 0;
        }
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString();
    const res = await httpsRequest('POST', 'https://accounts.spotify.com/api/token', null, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`,
        'Content-Length': Buffer.byteLength(body)
    });
    // POST with urlencoded needs special handling
    return new Promise((resolve, reject) => {
        const parsed = new URL('https://accounts.spotify.com/api/token');
        const req = https.request({
            hostname: parsed.hostname,
            path: parsed.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${creds}`,
                'Content-Length': Buffer.byteLength(body)
            }
        }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                const json = JSON.parse(d);
                if (!json.access_token) reject(new Error('Invalid token: ' + d));
                else resolve(json.access_token);
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function getCurrentTrack(accessToken) {
    const res = await httpsRequest('GET', 'https://api.spotify.com/v1/me/player', null, {
        'Authorization': `Bearer ${accessToken}`
    });
    if (res.status === 204 || res.body.length === 0) return null;
    return JSON.parse(res.body.toString());
}

async function downloadImageAsBase64(imageUrl) {
    const res = await httpsRequest('GET', imageUrl, null);
    if (res.status !== 200) throw new Error('Image download failed: ' + res.status);
    return res.body.toString('base64');
}

class SpotifyPoller {
    constructor(clientId, clientSecret, refreshToken, onStateChange, onError, log) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.refreshToken = refreshToken;
        this.onStateChange = onStateChange;
        this.onError = onError;
        this.log = log;
        this.accessToken = null;
        this.tokenExpiry = 0;
        this.lastTrackId = null;
        this.lastIsPlaying = null;
        this.lastImageBase64 = null;
        this.timer = null;
    }

    async ensureToken() {
        if (Date.now() >= this.tokenExpiry - 30000) {
            this.accessToken = await refreshAccessToken(this.clientId, this.clientSecret, this.refreshToken);
            this.tokenExpiry = Date.now() + 3500 * 1000;
            this.log.info('Spotify token refreshed');
        }
    }

    async poll() {
        try {
            await this.ensureToken();
            const data = await getCurrentTrack(this.accessToken);

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

    async pausePlayback() {
        await this.ensureToken();
        const res = await httpsRequest('PUT', 'https://api.spotify.com/v1/me/player/pause', null, {
            'Authorization': `Bearer ${this.accessToken}`
        });
        if (res.status !== 204) throw new Error('Pause failed: ' + res.status);
    }

    async resumePlayback() {
        await this.ensureToken();
        const res = await httpsRequest('PUT', 'https://api.spotify.com/v1/me/player/play', null, {
            'Authorization': `Bearer ${this.accessToken}`
        });
        if (res.status !== 204) throw new Error('Resume failed: ' + res.status);
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
