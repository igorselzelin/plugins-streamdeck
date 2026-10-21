const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Heuristic read of what Claude Code is doing right now, based on the same
// local transcripts (~/.claude/projects/**/*.jsonl) the claude-usage plugin
// reads. There's no official "current activity" API — this infers a rough
// state from the most recent tool call, and from how long it's been since
// the active session file was last touched at all. It will get things wrong
// sometimes; it's a mood cue for a mascot, not a precise status readout.

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const IDLE_MS = 5 * 60 * 1000; // no file activity for 5 minutes -> asleep
const TAIL_BYTES = 32 * 1024;  // only need the last few messages, not the whole transcript

// Claude Code run from inside WSL writes its transcripts to the Linux
// filesystem (e.g. /home/<user>/.claude/projects), which is invisible to a
// plain os.homedir() lookup since this plugin runs as a native Windows
// process. Reach those transcripts over the \\wsl.localhost\<distro>\...
// UNC share instead, checking every WSL user's home (plus root) in every
// installed distro. The distro/user list rarely changes, so it's cached —
// re-listing it (and spawning wsl.exe) on every 5s activity poll would be
// wasteful.
const WSL_ROOTS_CACHE_MS = 5 * 60 * 1000;
let wslRootsCache = null;
let wslRootsCacheAt = 0;

function listWslDistros() {
    try {
        const out = execSync('wsl -l -q', { encoding: 'utf16le', timeout: 3000 });
        return out.split(/\r?\n/).map(s => s.replace(/\0/g, '').trim()).filter(Boolean);
    } catch (_) {
        return []; // wsl.exe not present, or no distros installed
    }
}

function dirExists(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch (_) {
        return false;
    }
}

function findWslProjectDirs() {
    const roots = [];
    for (const distro of listWslDistros()) {
        const distroRoot = `\\\\wsl.localhost\\${distro}`;

        const rootUserProjects = path.join(distroRoot, 'root', '.claude', 'projects');
        if (dirExists(rootUserProjects)) roots.push(rootUserProjects);

        const homeDir = path.join(distroRoot, 'home');
        let users;
        try {
            users = fs.readdirSync(homeDir, { withFileTypes: true });
        } catch (_) {
            users = [];
        }
        for (const user of users) {
            if (!user.isDirectory()) continue;
            const userProjects = path.join(homeDir, user.name, '.claude', 'projects');
            if (dirExists(userProjects)) roots.push(userProjects);
        }
    }
    return roots;
}

function getAllProjectRoots() {
    const now = Date.now();
    if (!wslRootsCache || (now - wslRootsCacheAt) > WSL_ROOTS_CACHE_MS) {
        wslRootsCache = findWslProjectDirs();
        wslRootsCacheAt = now;
    }
    return [PROJECTS_DIR, ...wslRootsCache];
}

const IMPLEMENTING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PLANNING_TOOLS = new Set(['ExitPlanMode', 'Task', 'Agent']);

function walkJsonlFiles(dir) {
    let results = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return results;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results = results.concat(walkJsonlFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            try {
                const stat = fs.statSync(full);
                results.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
            } catch (_) {
                // removed between readdir and stat
            }
        }
    }
    return results;
}

function findLatestSessionFile() {
    let files = [];
    for (const root of getAllProjectRoots()) {
        files = files.concat(walkJsonlFiles(root));
    }
    if (files.length === 0) return null;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0];
}

function readTail(filePath, maxBytes) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (_) {
        return '';
    }
    try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - maxBytes);
        const length = size - start;
        if (length <= 0) return '';
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        return buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

// Walks backward through the tail of the transcript to find the most recent
// assistant turn, and classifies it by its last tool call (or lack of one).
function lastToolName(filePath) {
    const text = readTail(filePath, TAIL_BYTES);
    const lines = text.split('\n').filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try {
            entry = JSON.parse(lines[i]);
        } catch (_) {
            continue; // likely a truncated first line from the tail cut
        }
        if (entry.type !== 'assistant') continue;

        const content = entry.message && entry.message.content;
        if (!Array.isArray(content)) continue;

        for (let j = content.length - 1; j >= 0; j--) {
            if (content[j].type === 'tool_use') return content[j].name;
        }
        const hasText = content.some(c => c.type === 'text' && c.text && c.text.trim());
        if (hasText) return null; // reasoning/response turn, no tool call
    }
    return undefined; // nothing usable found in the tail
}

function classify(toolName) {
    if (toolName === undefined) return 'running'; // couldn't tell — assume generic activity
    if (toolName === null) return 'planning';      // plain text turn, closest to "thinking"
    if (IMPLEMENTING_TOOLS.has(toolName)) return 'implementing';
    if (PLANNING_TOOLS.has(toolName)) return 'planning';
    return 'running'; // Bash/Read/Grep/Glob/WebFetch/WebSearch/etc — generic active tool use
}

// Tool results (the pass/fail outcome of a tool call) come back as a
// `tool_result` content block on a `type: "user"` entry, carrying a real
// `is_error` boolean — confirmed against this project's own live transcript
// (grepped for both true and false occurrences) rather than assumed. Only
// the very last line of the tail is checked: as soon as anything else
// happens, that line stops being "last" and this stops firing on its own —
// no separate flag needed to avoid getting stuck showing an old error.
function lastEntryIsError(filePath) {
    const text = readTail(filePath, TAIL_BYTES);
    const lines = text.split('\n').filter(Boolean);
    if (lines.length === 0) return false;

    let entry;
    try {
        entry = JSON.parse(lines[lines.length - 1]);
    } catch (_) {
        return false;
    }
    if (entry.type !== 'user') return false;

    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) return false;
    return content.some(c => c.type === 'tool_result' && c.is_error === true);
}

// Returns one of: 'sleeping' | 'planning' | 'implementing' | 'running' | 'error'
function getActivity() {
    const latest = findLatestSessionFile();
    if (!latest) return 'sleeping';
    if (Date.now() - latest.mtimeMs > IDLE_MS) return 'sleeping';
    if (lastEntryIsError(latest.path)) return 'error';
    return classify(lastToolName(latest.path));
}

module.exports = { getActivity };
