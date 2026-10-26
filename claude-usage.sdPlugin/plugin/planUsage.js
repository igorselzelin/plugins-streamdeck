const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Account-level plan limits (Pro/Max 5-hour rolling session + weekly quota).
// There's no local file or documented API for this — it's read by shelling out
// to `claude -p "/usage"`, which is the same command a user would type
// themselves. This is a read-only, zero-cost call (it's answered locally by
// the CLI, no model turn happens) and does not count against the very quota
// it reports. --no-session-persistence keeps it from leaving a transcript
// file behind that would otherwise confuse the other action's "most recently
// active session" detection.
//
// IMPORTANT: do NOT add --bare here — it forces API-key-only auth and skips
// OAuth/keychain, which breaks subscription-based /usage lookups entirely.

// Safety-net poll. Real-time updates come from watchActivity() below, which
// triggers a refresh as soon as any Claude Code session writes to disk.
const REFRESH_MS = 30_000;
const TIMEOUT_MS = 15_000;
const MIN_FETCH_GAP_MS = 4_000; // never hit the API more often than this
const ACTIVITY_DEBOUNCE_MS = 1_500;
const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// `claude -p "/usage"` shares its local session/config state with any other
// claude process running under this same Windows account — including one
// launched from inside WSL via interop (there's no separate WSL install;
// `claude.exe` at ~/.local/bin is reached from WSL through the Windows PATH
// mount, so it's the exact same binary and ~/.claude state). While another
// session is actively mid-turn, this call can lose the race for that shared
// state and silently fall back to printing a generic exit summary ("Total
// cost: $0.0000 / Total duration...") instead of the real /usage report. A
// few quick retries usually land in a gap between the other session's writes.
const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 4000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Last-known-good snapshot, persisted outside the plugin's own deployed
// folder (so it survives redeploys and isn't touched by the ncc/autofile.js
// pipeline — see fontData.js for why anything under __dirname is risky
// there). This is what fixes the "--" that shows right after Rise Mode
// Controller restarts: without it, the in-memory cache starts null, and if
// that first refresh happens to land during a busy WSL/interactive session,
// the button is stuck on "--" instead of showing the last real numbers.
const CACHE_FILE = path.join(os.homedir(), '.claude-usage-plan-cache.json');

function reviveSnapshot(data) {
    if (!data || !data.session || !data.weekly) return null;
    return {
        session: { pct: data.session.pct, resetsAt: data.session.resetsAt ? new Date(data.session.resetsAt) : null },
        weekly: { pct: data.weekly.pct, resetsAt: data.weekly.resetsAt ? new Date(data.weekly.resetsAt) : null },
        fetchedAt: data.fetchedAt
    };
}

function loadCacheFromDisk() {
    try {
        return reviveSnapshot(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
    } catch (err) {
        return null; // no cache file yet, or corrupt — fine, just starts as null like before
    }
}

function saveCacheToDisk(snapshot) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
            session: { pct: snapshot.session.pct, resetsAt: snapshot.session.resetsAt ? snapshot.session.resetsAt.toISOString() : null },
            weekly: { pct: snapshot.weekly.pct, resetsAt: snapshot.weekly.resetsAt ? snapshot.weekly.resetsAt.toISOString() : null },
            fetchedAt: snapshot.fetchedAt
        }));
    } catch (err) {
        // best-effort only — worst case we just lose the cold-start shortcut next restart
    }
}

function resolveClaudeExe() {
    const candidates = [
        path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
        path.join(os.homedir(), '.local', 'bin', 'claude')
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return 'claude'; // fall back to PATH resolution
}

const CLAUDE_EXE = resolveClaudeExe();

let cache = loadCacheFromDisk(); // { session: {pct, resetsAt}, weekly: {pct, resetsAt}, fetchedAt }
let inflight = null;

function parseResetLabel(label) {
    // e.g. "Aug 20, 3:10am (America/Sao_Paulo)" — no year in the string, and
    // the CLI already prints it in the user's local time zone, so we treat
    // it as local wall-clock time on this machine (single-user tool, same
    // machine that's running Claude Code).
    const m = label.match(/(\w{3})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (!m) return null;
    const [, mon, day, hour12raw, min, ampm] = m;
    let hour = parseInt(hour12raw, 10) % 12;
    if (/pm/i.test(ampm)) hour += 12;
    const minute = min ? parseInt(min, 10) : 0;

    const now = new Date();
    const build = (year) => new Date(`${mon} ${day}, ${year} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);

    let date = build(now.getFullYear());
    if (isNaN(date.getTime())) return null;
    // Reset times are always near-future; if parsing landed clearly in the
    // past, it must be a year boundary (e.g. checking in late December).
    if (date.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
        date = build(now.getFullYear() + 1);
    }
    return date;
}

function parseUsageText(text) {
    const sessionMatch = text.match(/Current session:\s*(\d+)%\s*used\s*(?:\(subscription reset\))?\s*·\s*resets\s*([^\n]+)/i);
    const weeklyMatch = text.match(/Current week[^:\n]*:\s*(\d+)%\s*used\s*·\s*resets\s*([^\n]+)/i);
    if (!sessionMatch || !weeklyMatch) return null;
    return {
        session: { pct: parseInt(sessionMatch[1], 10) / 100, resetsAt: parseResetLabel(sessionMatch[2].trim()) },
        weekly: { pct: parseInt(weeklyMatch[1], 10) / 100, resetsAt: parseResetLabel(weeklyMatch[2].trim()) }
    };
}

function runUsageCommand() {
    return new Promise((resolve, reject) => {
        const child = spawn(CLAUDE_EXE, [
            '-p', '/usage',
            '--output-format', 'json',
            '--no-session-persistence'
        ], { windowsHide: true });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('claude /usage timed out'));
        }, TIMEOUT_MS);

        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) { reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`)); return; }
            try {
                const parsed = JSON.parse(stdout);
                resolve(parsed.result || '');
            } catch (err) {
                reject(new Error('failed to parse claude output: ' + err.message));
            }
        });
    });
}

// Same endpoint Claude Code itself uses for /usage: ~300ms, no process spawn,
// no contention with other running sessions. The access token is read fresh
// on each call because Claude Code rotates it; if it has expired (401) we fall
// back to the CLI below, which refreshes it as a side effect.
async function fetchUsageFromApi() {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8')).claudeAiOauth;
    const res = await fetch(API_URL, {
        headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'claude-code/2.0.0'
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`usage API HTTP ${res.status}`);
    const j = await res.json();
    if (!j.five_hour || !j.seven_day) throw new Error('usage API: unexpected shape');
    const entry = (e) => ({ pct: e.utilization / 100, resetsAt: e.resets_at ? new Date(e.resets_at) : null });
    return { session: entry(j.five_hour), weekly: entry(j.seven_day) };
}

let lastFetchAt = 0;

async function refresh(log) {
    if (inflight) return inflight;
    inflight = (async () => {
        lastFetchAt = Date.now();
        try {
            cache = { ...(await fetchUsageFromApi()), fetchedAt: Date.now() };
            saveCacheToDisk(cache);
            inflight = null;
            return;
        } catch (err) {
            if (log) log.warn(`planUsage: API fetch failed (${err.message}), falling back to CLI`);
        }
        let lastFailure = null;
        for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
            try {
                const text = await runUsageCommand();
                const parsed = parseUsageText(text);
                if (parsed) {
                    cache = { ...parsed, fetchedAt: Date.now() };
                    saveCacheToDisk(cache);
                    lastFailure = null;
                    break;
                }
                lastFailure = `could not parse /usage output: ${text.slice(0, 300)}`;
            } catch (err) {
                lastFailure = `refresh error: ${err.message}`;
            }
            if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS);
        }
        if (lastFailure && log) log.error(`planUsage: ${lastFailure} (after ${RETRY_ATTEMPTS} attempts)`);
        inflight = null;
    })();
    return inflight;
}

function getSnapshot() {
    return cache;
}

// Real-time trigger: any Claude Code session (VS Code, CLI, WSL) appends to a
// transcript under ~/.claude/projects on every message, so a recursive watch
// there is a cheap "usage just changed" signal. Debounced and rate-limited by
// MIN_FETCH_GAP_MS; onUpdate runs after each triggered refresh.
function watchActivity(log, onUpdate) {
    let timer = null;
    const trigger = () => {
        if (timer) return;
        const wait = Math.max(ACTIVITY_DEBOUNCE_MS, MIN_FETCH_GAP_MS - (Date.now() - lastFetchAt));
        timer = setTimeout(async () => {
            timer = null;
            await refresh(log);
            onUpdate();
        }, wait);
    };
    try {
        const watcher = fs.watch(PROJECTS_DIR, { recursive: true }, trigger);
        watcher.on('error', err => log && log.warn(`planUsage: watcher error: ${err.message}`));
        return () => { watcher.close(); clearTimeout(timer); };
    } catch (err) {
        if (log) log.warn(`planUsage: cannot watch ${PROJECTS_DIR} (${err.message}); relying on polling`);
        return () => {};
    }
}

function formatCountdown(date) {
    if (!date) return '--';
    const ms = date.getTime() - Date.now();
    if (ms <= 0) return 'now';
    const totalMin = Math.round(ms / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const minutes = totalMin % 60;
    // Single largest unit only — keeps the button label short enough to
    // draw at a readable size (e.g. "4h", "6d", "45m", not "4h 12m").
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
}

module.exports = { refresh, getSnapshot, formatCountdown, watchActivity, REFRESH_MS };
