const { Plugins, Actions, log } = require('./utils/plugin');
const { renderFrame, renderEmpty, pickBehavior, behaviorFrameCount } = require('./renderClawd');
const claudeState = require('./claudeState');

const plugin = new Plugins();

const FRAME_MS = 500;          // how fast frames advance within a mood's loop
const ACTIVITY_POLL_MS = 5000; // how often we check what Claude Code is doing
const IDLE_MOOD_MIN_MS = 15000;
const IDLE_MOOD_MAX_MS = 35000;
const WANDER_MIN_MS = 20000;   // how often he might wander to another button while idle
const WANDER_MAX_MS = 45000;
const HAPPY_CLICK_MS = 2500;   // how long a click's "happy" reaction lasts before resyncing
const WALK_STEP_MS = 280;      // pace of the marching-in-place transition frames
const BORED_AFTER_MS = 2 * 60 * 1000;      // idle this long before "bored" enters the idle-mood pool
const DEEP_IDLE_AFTER_MS = 5 * 60 * 1000;  // idle even longer -> sleeping dominates, gently
const IMPLEMENTING_INTENSE_AFTER_MS = 3 * 60 * 1000; // continuous coding this long -> pause/debug/coffee get likelier
const IMPLEMENTING_BOOST = ['pause', 'debug', 'coffee'];
const CLICK_ANNOYED_CHANCE = 0.05; // rare "tô trabalhando, pô" click reaction

// Three tiers of the idle-mood pool, picked by how long he's been idle —
// this is the "humor baseado no tempo" from the request (section 8/9),
// done as weight shifts rather than new states, exactly as asked. 'bored'
// isn't offered at all until BORED_AFTER_MS; past DEEP_IDLE_AFTER_MS
// sleeping quietly takes over most of the time, echoing "ficou ocioso por
// muito tempo -> sleeping" without a hard scripted transition.
const IDLE_MOODS = [
    { mood: 'sleeping', weight: 0.6 },
    { mood: 'happy', weight: 0.2 },
    { mood: 'idle', weight: 0.2 }
];
const IDLE_MOODS_BORED = [
    { mood: 'sleeping', weight: 0.35 },
    { mood: 'happy', weight: 0.15 },
    { mood: 'idle', weight: 0.15 },
    { mood: 'bored', weight: 0.35 }
];
const IDLE_MOODS_DEEP = [
    { mood: 'sleeping', weight: 0.7 },
    { mood: 'bored', weight: 0.2 },
    { mood: 'happy', weight: 0.05 },
    { mood: 'idle', weight: 0.05 }
];

// success/error/annoyed play their chosen behavior exactly once, then hand
// control back (see tick()) instead of looping like every other mood.
const ONE_SHOT_MOODS = new Set(['success', 'error', 'annoyed']);
// Moods that count as "he was doing real work" — finishing one of these
// cleanly (no error) is what triggers the one-shot 'success' reaction.
const WORK_MOODS = new Set(['implementing', 'running', 'planning']);

// context -> {column, row}, from willAppear's payload.coordinates — one
// entry per button Clawd has been placed on. He occupies exactly one of
// them (currentContext) at a time; the rest show an empty tile.
const contexts = new Map();
const lastShown = new Map(); // context -> 'clawd' | 'empty', to skip redundant pushes

let homeContext = null;    // top-left-most placed button — where he anchors while Claude Code is busy
let currentContext = null; // which context currently shows him
let transitioning = false; // true while walkTransition() is mid-flight

let mood = 'sleeping';
let behavior = 'normal';  // which behavior within `mood` is currently playing
let frameIndex = 0;
let realActivity = null; // last value from claudeState.getActivity()
let idleSince = null;    // timestamp we last entered 'sleeping' — drives 'bored' eligibility
let moodSince = Date.now(); // timestamp the current top-level mood started — drives implementing's intensity boost

// Per-mood memory of the last couple of behaviors played, so the picker
// doesn't repeat the same one back to back — without this, "normal" (the
// highest-weight behavior in every mood) would sometimes run 4-5 times in a
// row and the mascot would read as stuck rather than idly varying.
const recentBehaviors = new Map(); // mood -> [last up-to-2 behavior names]

function pickNewBehavior(forMood, boostNames = []) {
    const recent = recentBehaviors.get(forMood) || [];
    const chosen = pickBehavior(forMood, recent, boostNames);
    recentBehaviors.set(forMood, [...recent, chosen].slice(-2));
    return chosen;
}

// Boost names for whichever behavior pool is about to be picked from —
// currently only 'implementing' has a duration-based nudge (section 5/8 of
// the request: the longer a coding stretch runs, the likelier a pause/
// debug/coffee break becomes).
function boostFor(forMood) {
    if (forMood === 'implementing' && (Date.now() - moodSince) > IMPLEMENTING_INTENSE_AFTER_MS) {
        return IMPLEMENTING_BOOST;
    }
    return [];
}

let frameTimer = null;
let activityTimer = null;
let idleMoodTimer = null;
let wanderTimer = null;
let clickResyncTimer = null;
let emptyImageCache = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getEmptyImage() {
    if (!emptyImageCache) emptyImageCache = await renderEmpty();
    return emptyImageCache;
}

function recomputeHome() {
    let best = null;
    for (const [ctx, pos] of contexts) {
        if (!best || pos.row < best.pos.row || (pos.row === best.pos.row && pos.column < best.pos.column)) {
            best = { ctx, pos };
        }
    }
    homeContext = best ? best.ctx : null;
    if (!currentContext || !contexts.has(currentContext)) {
        currentContext = homeContext;
    }
}

function setMood(next) {
    if (next === mood) return;
    mood = next;
    moodSince = Date.now();
    behavior = pickNewBehavior(mood, boostFor(mood));
    frameIndex = 0;
}

function pickIdleMood() {
    const idleMs = idleSince !== null ? Date.now() - idleSince : 0;
    const pool = idleMs > DEEP_IDLE_AFTER_MS ? IDLE_MOODS_DEEP
        : idleMs > BORED_AFTER_MS ? IDLE_MOODS_BORED
        : IDLE_MOODS;
    const r = Math.random();
    let acc = 0;
    for (const { mood: m, weight } of pool) {
        acc += weight;
        if (r <= acc) return m;
    }
    return 'sleeping';
}

function scheduleIdleMoodChange() {
    if (idleMoodTimer) clearTimeout(idleMoodTimer);
    const delay = IDLE_MOOD_MIN_MS + Math.random() * (IDLE_MOOD_MAX_MS - IDLE_MOOD_MIN_MS);
    idleMoodTimer = setTimeout(() => {
        setMood(pickIdleMood());
        scheduleIdleMoodChange();
    }, delay);
}

function stopIdleMoodCycle() {
    if (idleMoodTimer) { clearTimeout(idleMoodTimer); idleMoodTimer = null; }
}

// Marches in place on the departing button for a few frames, switches it to
// the empty tile, then plants him on the destination button. Buttons are
// separate physical screens, so this "jump with a wind-up" is the closest
// thing to a walk that the hardware can actually show. Step pace scales
// with how far he's moving (Manhattan distance between the two buttons'
// coordinates) — a longer trip marches a bit faster instead of just taking
// more real time at the same pace.
async function walkTransition(toContext) {
    if (!toContext || toContext === currentContext || !contexts.has(toContext)) return;

    transitioning = true;
    try {
        const fromContext = currentContext;
        const fromPos = fromContext ? contexts.get(fromContext) : null;
        const toPos = contexts.get(toContext);
        const distance = fromPos ? Math.abs(toPos.column - fromPos.column) + Math.abs(toPos.row - fromPos.row) : 1;
        const stepMs = Math.max(140, WALK_STEP_MS - distance * 30);

        for (let i = 0; i < 3; i++) {
            const img = await renderFrame('walking', 'normal', i);
            if (fromContext) plugin.setImage(fromContext, `data:image/jpeg;base64,${img}`);
            await sleep(stepMs);
        }

        if (fromContext) {
            const emptyImg = await getEmptyImage();
            plugin.setImage(fromContext, `data:image/jpeg;base64,${emptyImg}`);
            lastShown.set(fromContext, 'empty');
        }

        currentContext = toContext;
        behavior = 'normal';
        frameIndex = 0;

        const arriveImg = await renderFrame('walking', 'normal', 3); // neutral arrival stance
        plugin.setImage(toContext, `data:image/jpeg;base64,${arriveImg}`);
        lastShown.set(toContext, 'clawd');

        // A small settling beat right after landing, instead of just
        // materializing in the neutral pose and holding there.
        await sleep(stepMs);
        const settleImg = await renderFrame('walking', 'normal', 4);
        plugin.setImage(toContext, `data:image/jpeg;base64,${settleImg}`);
    } finally {
        transitioning = false;
    }
}

function scheduleWander() {
    if (wanderTimer) clearTimeout(wanderTimer);
    if (contexts.size < 2) return; // nowhere to wander to with only one button
    const delay = WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS);
    wanderTimer = setTimeout(() => {
        wanderToRandomCell().finally(scheduleWander);
    }, delay);
}

function stopWander() {
    if (wanderTimer) { clearTimeout(wanderTimer); wanderTimer = null; }
}

// Very rare "infinite loop" easter egg (section 4 of the request): instead
// of a normal wander, he walks to another button and immediately walks
// straight back, then reacts confused at ending up right where he started.
// Built entirely out of the existing walkTransition — no new movement
// machinery, just calling it twice.
const INFINITE_LOOP_CHANCE = 0.04;

async function wanderToRandomCell() {
    if (transitioning || realActivity !== 'sleeping') return;
    const others = [...contexts.keys()].filter(c => c !== currentContext);
    if (others.length === 0) return;
    const dest = others[Math.floor(Math.random() * others.length)];

    if (Math.random() < INFINITE_LOOP_CHANCE) {
        const origin = currentContext;
        await walkTransition(dest);
        await sleep(500);
        await walkTransition(origin);
        // Reuses the 'error' one-shot's confused look purely as a cosmetic
        // reaction to "huh, I'm back where I started" — not a real error,
        // realActivity is untouched so tick()'s fallback still resolves
        // correctly once this plays out.
        mood = 'error';
        moodSince = Date.now();
        behavior = 'confused';
        frameIndex = 0;
        render().catch(err => log.error('render error:', err.message));
        return;
    }

    await walkTransition(dest);
}

async function pollActivity() {
    if (transitioning) return;

    let activity;
    try {
        activity = claudeState.getActivity();
    } catch (err) {
        log.error('claudeState.getActivity error:', err.message);
        activity = 'sleeping';
    }

    const wasSleeping = realActivity === 'sleeping';
    realActivity = activity;

    if (activity !== 'sleeping') {
        idleSince = null;
        stopIdleMoodCycle();
        stopWander();
        if (currentContext !== homeContext && homeContext) {
            await walkTransition(homeContext);
        }
        setMood(activity);
        await render();
    } else if (!wasSleeping) {
        // Just went idle. If he was in the middle of real work, celebrate
        // first (a one-shot reaction — tick() hands control back to normal
        // idle wandering once it finishes) instead of going straight to
        // sleeping/wandering.
        const finishedWorkCleanly = WORK_MOODS.has(mood);
        idleSince = Date.now();
        if (finishedWorkCleanly) {
            mood = 'success';
            moodSince = Date.now();
            behavior = pickNewBehavior('success');
            frameIndex = 0;
            // scheduleIdleMoodChange() resumes once the success one-shot
            // finishes in tick() — starting it now would just get clobbered.
        } else {
            setMood('sleeping');
            scheduleIdleMoodChange();
        }
        scheduleWander();
        await render();
    }
}

async function render() {
    if (contexts.size === 0 || transitioning) return;

    let clawdImg = null;
    for (const ctx of contexts.keys()) {
        if (ctx === currentContext) {
            if (!clawdImg) clawdImg = await renderFrame(mood, behavior, frameIndex);
            plugin.setImage(ctx, `data:image/jpeg;base64,${clawdImg}`);
            lastShown.set(ctx, 'clawd');
        } else if (lastShown.get(ctx) !== 'empty') {
            const img = await getEmptyImage();
            plugin.setImage(ctx, `data:image/jpeg;base64,${img}`);
            lastShown.set(ctx, 'empty');
        }
    }
}

function tick() {
    if (transitioning) return;
    frameIndex++;
    if (frameIndex >= behaviorFrameCount(mood, behavior)) {
        if (ONE_SHOT_MOODS.has(mood)) {
            // The one-shot reaction finished — hand back to whatever's
            // actually going on. Reassigned directly (not via setMood,
            // which no-ops when the target equals the current mood) so this
            // always picks a fresh behavior even if realActivity is still
            // the same busy mood we were already about to fall back into.
            const fallback = (realActivity && realActivity !== 'sleeping') ? realActivity : 'sleeping';
            mood = fallback;
            moodSince = Date.now();
            behavior = pickNewBehavior(mood, boostFor(mood));
            frameIndex = 0;
            if (fallback === 'sleeping') scheduleIdleMoodChange();
        } else {
            // This behavior played all the way through — pick the next one
            // rather than looping the same clip forever.
            behavior = pickNewBehavior(mood, boostFor(mood));
            frameIndex = 0;
        }
    }
    render().catch(err => log.error('render error:', err.message));
}

function ensureRunning() {
    if (frameTimer) return;
    pollActivity().catch(err => log.error('pollActivity error:', err.message));
    render().catch(err => log.error('render error:', err.message));
    frameTimer = setInterval(tick, FRAME_MS);
    activityTimer = setInterval(() => {
        pollActivity().catch(err => log.error('pollActivity error:', err.message));
    }, ACTIVITY_POLL_MS);
}

function stopRunning() {
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
    stopIdleMoodCycle();
    stopWander();
    if (clickResyncTimer) { clearTimeout(clickResyncTimer); clickResyncTimer = null; }
}

plugin.action1 = new Actions({
    default: {},

    _willAppear(data) {
        const { context, payload } = data;
        contexts.set(context, (payload && payload.coordinates) || { column: 0, row: 0 });
        recomputeHome();
        ensureRunning();
        // Bug found while testing this round: ensureRunning() only does its
        // setup once (guarded by frameTimer), so adding the 2nd..6th button
        // never used to re-arm wandering — it only started once some other
        // trigger (a busy->idle transition) called scheduleWander() again.
        // Now every button add/remove re-evaluates it, symmetric with
        // _willDisappear below.
        scheduleWander();
    },

    _willDisappear({ context }) {
        contexts.delete(context);
        lastShown.delete(context);
        if (currentContext === context) currentContext = null;
        recomputeHome();
        if (contexts.size === 0) stopRunning();
        else scheduleWander(); // button count changed — re-evaluate whether wandering makes sense
    },

    keyUp({ context }) {
        if (context !== currentContext) return; // only the button he's actually on reacts

        // Reassigned directly rather than via setMood() so a click always
        // gets a fresh reaction — including picking a new 'happy' behavior
        // (jump/celebrate/dance/normal) even if he was already happy from
        // the idle-mood rotation, which setMood's no-op-when-unchanged
        // guard would otherwise swallow.
        const annoyed = Math.random() < CLICK_ANNOYED_CHANCE;
        mood = annoyed ? 'annoyed' : 'happy';
        moodSince = Date.now();
        behavior = pickNewBehavior(mood);
        frameIndex = 0;
        render().catch(err => log.error('render error:', err.message));

        // 'annoyed' is one-shot (see ONE_SHOT_MOODS) and resolves itself via
        // tick() — this timer is only really needed for 'happy', but firing
        // it either way is harmless (it'll just resync to the same thing
        // tick() already settled on).
        if (clickResyncTimer) clearTimeout(clickResyncTimer);
        clickResyncTimer = setTimeout(() => {
            if (realActivity && realActivity !== 'sleeping') {
                setMood(realActivity);
            } else {
                scheduleIdleMoodChange();
            }
        }, HAPPY_CLICK_MS);
    }
});
