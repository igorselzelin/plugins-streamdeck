const https = require('https');

// Keep TLS connections to api.spotify.com / i.scdn.co open between requests: without this
// every poll paid a fresh DNS + TCP + TLS handshake (~100-250ms) before Spotify even saw it.
const agent = new https.Agent({ keepAlive: true, maxSockets: 6, keepAliveMsecs: 15000 });
const REQUEST_TIMEOUT_MS = 6000;

// Credentials live in config.js (outside git — see config.example.js and .gitignore)
const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN } = require('./config');

function httpsRequest(method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isForm = typeof body === 'string';
        const data = body ? (isForm ? body : JSON.stringify(body)) : null;
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method,
            agent,
            headers: { ...headers }
        };
        if (data) {
            options.headers['Content-Type'] = isForm ? 'application/x-www-form-urlencoded' : 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(data);
        } else {
            options.headers['Content-Length'] = 0;
        }
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        // A hung request would otherwise stall the poll loop indefinitely
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Request timeout: ${parsed.hostname}${parsed.pathname}`)));
        if (data) req.write(data);
        req.end();
    });
}

async function refreshAccessToken() {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: SPOTIFY_REFRESH_TOKEN }).toString();
    const res = await httpsRequest('POST', 'https://accounts.spotify.com/api/token', body, {
        'Authorization': `Basic ${creds}`
    });
    const json = JSON.parse(res.body.toString());
    if (!json.access_token) throw new Error('Invalid token: ' + res.body.toString());
    return json.access_token;
}

// One token shared by every Spotify action in this plugin (a single process now hosts
// them all), instead of each feature refreshing its own copy.
let accessToken = null;
let tokenExpiry = 0;
let tokenInflight = null;

async function getAccessToken(log) {
    if (Date.now() < tokenExpiry - 30000) return accessToken;
    if (!tokenInflight) {
        tokenInflight = refreshAccessToken()
            .then(token => {
                accessToken = token;
                tokenExpiry = Date.now() + 3500 * 1000;
                if (log) log.info('Spotify token refreshed');
                return token;
            })
            .finally(() => { tokenInflight = null; });
    }
    return tokenInflight;
}

async function authHeaders(log) {
    return { 'Authorization': `Bearer ${await getAccessToken(log)}` };
}

// GET /me/player — null when no device is active (Spotify answers 204 with no body)
async function getPlayerState(log) {
    const res = await httpsRequest('GET', 'https://api.spotify.com/v1/me/player', null, await authHeaders(log));
    if (res.status === 204 || res.body.length === 0) return null;
    if (res.status !== 200) {
        // 429/5xx used to be parsed as "no item" and shown as Spotify closed
        const err = new Error(`Player state failed: ${res.status}`);
        const retryAfter = Number(res.headers?.['retry-after']);
        if (res.status === 429 && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
        throw err;
    }
    return JSON.parse(res.body.toString());
}

// GET /me/player/queue — upcoming tracks, used to pre-download the next cover
async function getQueue(log) {
    const res = await httpsRequest('GET', 'https://api.spotify.com/v1/me/player/queue', null, await authHeaders(log));
    if (res.status !== 200 || res.body.length === 0) return null;
    return JSON.parse(res.body.toString());
}

// PUT to a /me/player/* endpoint; Spotify answers 204 — or, lately, 200 — on success
async function playerCommand(path, label, log) {
    const res = await httpsRequest('PUT', `https://api.spotify.com/v1/me/player/${path}`, null, await authHeaders(log));
    if (res.status < 200 || res.status >= 300) throw new Error(`${label} failed: ${res.status}`);
}

module.exports = { httpsRequest, getPlayerState, getQueue, playerCommand, authHeaders };
