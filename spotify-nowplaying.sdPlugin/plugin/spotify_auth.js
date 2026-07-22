/**
 * Script de autorização Spotify — rode UMA VEZ para obter o refresh_token.
 * Uso: node spotify_auth.js <CLIENT_ID> <CLIENT_SECRET>
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
    console.error('Uso: node spotify_auth.js <CLIENT_ID> <CLIENT_SECRET>');
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
        res.end('Erro: nenhum code recebido.');
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
                res.end('<h1>Sucesso! Feche esta janela.</h1>');
                console.log('\n========================================');
                console.log('REFRESH TOKEN OBTIDO COM SUCESSO!');
                console.log('========================================');
                console.log('Guarde esses valores no plugin:\n');
                console.log(`CLIENT_ID:     ${CLIENT_ID}`);
                console.log(`CLIENT_SECRET: ${CLIENT_SECRET}`);
                console.log(`REFRESH_TOKEN: ${json.refresh_token}`);
                console.log('========================================\n');
                server.close();
            } else {
                res.end('<h1>Erro ao obter token. Veja o console.</h1>');
                console.error('Erro:', json);
                server.close();
            }
        });
    });
    tokenReq.write(body);
    tokenReq.end();
});

server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log('Abrindo navegador para autorização...\n');
    exec(`start "" "${authUrl}"`);
});
