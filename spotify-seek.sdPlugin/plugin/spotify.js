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

class SpotifySeekClient {
    constructor(clientId, clientSecret, refreshToken, log) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.refreshToken = refreshToken;
        this.log = log;
        this.accessToken = null;
        this.tokenExpiry = 0;
    }

    async ensureToken() {
        if (Date.now() >= this.tokenExpiry - 30000) {
            this.accessToken = await refreshAccessToken(this.clientId, this.clientSecret, this.refreshToken);
            this.tokenExpiry = Date.now() + 3500 * 1000;
            this.log.info('Spotify token refreshed');
        }
    }

    async seekBy(deltaMs) {
        await this.ensureToken();
        const data = await getPlayerState(this.accessToken);
        if (!data || !data.item) return;
        const newPositionMs = Math.max(0, Math.min(data.item.duration_ms, data.progress_ms + deltaMs));
        const res = await httpsRequest('PUT', `https://api.spotify.com/v1/me/player/seek?position_ms=${newPositionMs}`, null, {
            'Authorization': `Bearer ${this.accessToken}`
        });
        if (res.status !== 204) throw new Error('Seek failed: ' + res.status);
    }
}

module.exports = { SpotifySeekClient };
