/**
 * Spotify authorization script — run ONCE to obtain the refresh_token.
 * Usage: node spotify_auth.js <CLIENT_ID> <CLIENT_SECRET>
 */

const http = require('http');
const https = require('https');
const url = require('url');
const { exec } = require('child_process');

const CLIENT_ID = process.argv[2];
const CLIENT_SECRET = process.argv[3];
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const PORT = 8888;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Usage: node spotify_auth.js <CLIENT_ID> <CLIENT_SECRET>');
    process.exit(1);
}

const authUrl = `https://accounts.spotify.com/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}`;

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    if (!parsed.pathname.startsWith('/callback')) return;

    const code = parsed.query.code;
    if (!code) {
        res.end('Error: no code received.');
        return;
    }

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
    }).toString();

    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const options = {
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${creds}`,
            'Content-Length': Buffer.byteLength(body)
        }
    };

    const tokenReq = https.request(options, (tokenRes) => {
        let data = '';
        tokenRes.on('data', chunk => data += chunk);
        tokenRes.on('end', () => {
            const json = JSON.parse(data);
            if (json.refresh_token) {
                res.end('<h1>Success! You can close this window.</h1>');
                console.log('\n========================================');
                console.log('REFRESH TOKEN OBTAINED SUCCESSFULLY!');
                console.log('========================================');
                console.log('Save these values in the plugin:\n');
                console.log(`CLIENT_ID:     ${CLIENT_ID}`);
                console.log(`CLIENT_SECRET: ${CLIENT_SECRET}`);
                console.log(`REFRESH_TOKEN: ${json.refresh_token}`);
                console.log('========================================\n');
                server.close();
            } else {
                res.end('<h1>Error getting token. Check the console.</h1>');
                console.error('Error:', json);
                server.close();
            }
        });
    });
    tokenReq.write(body);
    tokenReq.end();
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Opening browser for authorization...\n');
    exec(`start "" "${authUrl}"`);
});
