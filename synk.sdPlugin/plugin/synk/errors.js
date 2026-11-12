// Error type shared by the connection layer and the actions.
// `code` is an engine code (STREAM_DECK_INTEGRATION.md 11.1), a local code (11.2) or a
// plugin-only code below. Unknown engine codes are mapped to INTERNAL (section 12).

class SynkError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'SynkError';
        this.code = KNOWN_CODES.has(code) ? code : 'INTERNAL';
    }
}

const ENGINE_CODES = [
    'BAD_FRAME', 'HANDSHAKE_REQUIRED', 'UNAUTHORIZED', 'VERSION_MISMATCH', 'UNKNOWN_COMMAND',
    'INVALID_PARAMS', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'NOT_IMPLEMENTED', 'BUSY', 'TIMEOUT',
    'UNAVAILABLE', 'INTEGRITY_FAILED', 'IO_ERROR', 'INTERNAL'
];

const LOCAL_CODES = Object.freeze({
    // contract section 11.2
    NOT_RUNNING: 'NOT_RUNNING',                     // no ipc.json, or ENOENT on the pipe
    INVALID_DISCOVERY: 'INVALID_DISCOVERY',         // bad ipc.json / ipc.token
    VERSION_MISMATCH: 'VERSION_MISMATCH',
    SERVER_PROOF_MISMATCH: 'SERVER_PROOF_MISMATCH', // pipe server could not prove it holds the token
    TIMEOUT: 'TIMEOUT',
    DISCONNECTED: 'DISCONNECTED',                   // connection lost with requests pending
    // plugin-only
    OFFLINE: 'OFFLINE',                             // no live connection when a key was pressed
    IO: 'IO',                                       // other pipe error (e.g. all instances busy)
    CLOSED: 'CLOSED',                               // closed by the plugin itself
    BAD_RESPONSE: 'BAD_RESPONSE',                   // engine answered something unusable
    INVALID_SOUND: 'INVALID_SOUND'                  // key has no valid sound ID configured
});

const KNOWN_CODES = new Set([...ENGINE_CODES, ...Object.values(LOCAL_CODES)]);

function toSynkError(err) {
    if (err instanceof SynkError) return err;
    return new SynkError('INTERNAL', err?.message || String(err));
}

module.exports = { SynkError, LOCAL_CODES, toSynkError };
