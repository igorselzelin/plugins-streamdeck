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

async function getPlayerState(accessToken) {
    const res = await httpsRequest('GET', 'https://api.spotify.com/v1/me/player', null, {
        'Authorization': `Bearer ${accessToken}`
    });
    if (res.status === 204 || res.body.length === 0) return null;
    return JSON.parse(res.body.toString());
}

class SpotifyVolumeClient {
    constructor(clientId, clientSecret, refreshToken, log) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.refreshToken = refreshToken;
        this.log = log;
        this.accessToken = null;
        this.tokenExpiry = 0;
        this.volumeBeforeMute = null;
        this.localVolume = null;
        this._volumeSeedPromise = null;
        this._volumeCommitTimer = null;
    }

    async ensureToken() {
        if (Date.now() >= this.tokenExpiry - 30000) {
            this.accessToken = await refreshAccessToken(this.clientId, this.clientSecret, this.refreshToken);
            this.tokenExpiry = Date.now() + 3500 * 1000;
            this.log.info('Spotify token refreshed');
        }
    }

    async getPlayerVolume() {
        await this.ensureToken();
        const data = await getPlayerState(this.accessToken);
        return data?.device?.volume_percent ?? null;
    }

    async setPlayerVolume(percent) {
        await this.ensureToken();
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        const res = await httpsRequest('PUT', `https://api.spotify.com/v1/me/player/volume?volume_percent=${clamped}`, null, {
            'Authorization': `Bearer ${this.accessToken}`
        });
        if (res.status !== 204) throw new Error('Set volume failed: ' + res.status);
        return clamped;
    }

    // Seeds localVolume from the API once, so repeated knob ticks don't each pay for a GET
    // round-trip (a raw GET-then-PUT per tick was too slow to keep up with fast spins and
    // raced with itself, silently dropping most of the turn).
    async _ensureLocalVolume() {
        if (this.localVolume !== null) return;
        if (!this._volumeSeedPromise) {
            this._volumeSeedPromise = this.getPlayerVolume().then(v => {
                this.localVolume = v ?? 50;
            });
        }
        await this._volumeSeedPromise;
    }

    async changeVolumeBy(deltaPercent) {
        await this._ensureLocalVolume();
        this.localVolume = Math.max(0, Math.min(100, this.localVolume + deltaPercent));
        if (this.localVolume > 0) this.volumeBeforeMute = this.localVolume;
        this._scheduleVolumeCommit();
    }

    // Coalesces bursts of ticks into a single PUT, fired shortly after the knob stops moving.
    _scheduleVolumeCommit() {
        clearTimeout(this._volumeCommitTimer);
        this._volumeCommitTimer = setTimeout(() => {
            this.setPlayerVolume(this.localVolume).catch(err => this.log.error('setPlayerVolume error:', err.message));
        }, 150);
    }

    async toggleMute() {
        await this._ensureLocalVolume();
        clearTimeout(this._volumeCommitTimer);
        if (this.localVolume > 0) {
            this.volumeBeforeMute = this.localVolume;
            this.localVolume = 0;
        } else {
            this.localVolume = this.volumeBeforeMute ?? 50;
        }
        await this.setPlayerVolume(this.localVolume);
    }
}

module.exports = { SpotifyVolumeClient };
