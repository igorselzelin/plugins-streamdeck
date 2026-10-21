const Jimp = require('jimp');

const SIZE = 126;
const GRID = 42;
const CELL = SIZE / GRID;
const CENTER = GRID / 2;

const PALETTE = {
    bg: 0x1c1c1eff,
    groundShadow: 0x141416ff,
    body: 0xf15b45ff,
    eye: 0x0e0d0dff,
    mouth: 0x0e0d0dff,
    zzz: 0xf0d9c8ff,
    device: 0x2a2a2eff,
    screen: 0x123244ff,
    codeLine: 0x7fd8f5ff,
    bubble: 0xf0ede8ff,
    bubbleMark: 0x2a2a2eff,
    spark: 0xffe08aff,
    idea: 0xffd35cff,
    bug: 0x8bc34aff
};

// All measurements below are taken directly from the reference PNG (400x400,
// transparent bg) by scanning alpha per pixel — not eyeballed. Reference
// pixel coordinates, with x=0 at the reference's left edge of the "core"
// body (head/lower-body width, x 72..330 in the original):
//   core width:      258   (head band and lower-body band both this wide)
//   head height:       61  (y  91..151)
//   arms height:        61  (y 152..212), arms span x -60..318 (full width 376)
//   lower body height: 63  (y 213..275)
//   legs height:        68  (y 276..343)s
//   eyes (core-relative): left [36,67]x[29,60], right [190,222]x[29,60] —
//     32x32 squares, flush with the bottom of the head band.
const CORE_W_REF = 258;

function scale(refPx) {
    // Maps a reference-pixel length to grid cells, core width -> 26 cells.
    return (refPx / CORE_W_REF) * 26;
}

const CORE_LEFT = CENTER - scale(CORE_W_REF) / 2; // left edge of the core band, in grid cells

function band(refX0, refX1) {
    return [Math.round(CORE_LEFT + scale(refX0)), Math.round(CORE_LEFT + scale(refX1)) - 1];
}

const HEAD_H = Math.round(scale(61));
const ARMS_H = Math.round(scale(61));
const LOWERBODY_H = Math.round(scale(63));
const LEGS_H = Math.round(scale(68));

const BODY_H = HEAD_H + ARMS_H + LOWERBODY_H + LEGS_H;
// Centers the body vertically in the grid (a couple rows above true-center,
// since the ground shadow sits just below the feet and should count as part
// of the visual footprint too).
const TOP = Math.round((GRID - BODY_H) / 2) - 1;
const headRow = [TOP, TOP + HEAD_H - 1];
const armsRow = [headRow[1] + 1, headRow[1] + ARMS_H];
const lowerRow = [armsRow[1] + 1, armsRow[1] + LOWERBODY_H];
const legsRow = [lowerRow[1] + 1, lowerRow[1] + LEGS_H];

const coreCols = band(0, CORE_W_REF);
const armsCols = [Math.round(CENTER - scale(376) / 2), Math.round(CENTER + scale(376) / 2) - 1];

// Four claw-tips, all the same width (matching the inner pair from the
// reference — the outer pair there was very slightly thicker, evened out
// here), laid out symmetrically: tip / claw-gap / tip / leg-gap / tip / claw-gap / tip.
const FOOT_W = 32, CLAW_GAP = 31, LEG_GAP = 62; // reference px
const legsSpan = FOOT_W * 4 + CLAW_GAP * 2 + LEG_GAP;
const legsStart = (CORE_W_REF - legsSpan) / 2;
function footBand(n) {
    const start = legsStart + n * (FOOT_W + CLAW_GAP) + (n >= 2 ? LEG_GAP - CLAW_GAP : 0);
    return band(start, start + FOOT_W);
}
const legCols = {
    foot1: footBand(0),
    foot2: footBand(1),
    foot3: footBand(2),
    foot4: footBand(3)
};

// legLift shifts the left leg (foot1+foot2) and/or right leg (foot3+foot4)
// up by N cells (used by 'walking' to march in place). Every other behavior
// passes the neutral default.
function bodyRects(legLift) {
    return [
        [headRow[0], headRow[1], coreCols[0], coreCols[1]],
        [armsRow[0], armsRow[1], armsCols[0], armsCols[1]],
        [lowerRow[0], lowerRow[1], coreCols[0], coreCols[1]],
        [legsRow[0] - legLift.left, legsRow[1] - legLift.left, legCols.foot1[0], legCols.foot1[1]],
        [legsRow[0] - legLift.left, legsRow[1] - legLift.left, legCols.foot2[0], legCols.foot2[1]],
        [legsRow[0] - legLift.right, legsRow[1] - legLift.right, legCols.foot3[0], legCols.foot3[1]],
        [legsRow[0] - legLift.right, legsRow[1] - legLift.right, legCols.foot4[0], legCols.foot4[1]]
    ];
}

function buildBaseGrid(legLift = { left: 0, right: 0 }) {
    const grid = Array.from({ length: GRID }, () => Array(GRID).fill(null));
    const rects = bodyRects(legLift);

    // Flat fill — matches the reference art's solid color exactly, no shading.
    for (const [r0, r1, c0, c1] of rects) {
        for (let y = r0; y <= r1; y++) {
            for (let x = c0; x <= c1; x++) {
                if (y >= 0 && y < GRID) grid[y][x] = PALETTE.body;
            }
        }
    }

    // Ground shadow — a thin dark strip under the feet, fixed in place (does
    // not bob or lift with the legs) so the body reads as standing on it.
    const shadowY = Math.min(GRID - 1, legsRow[1] + 2);
    for (let x = coreCols[0] - 2; x <= coreCols[1] + 2; x++) {
        if (x >= 0 && x < GRID && !grid[shadowY]?.[x]) grid[shadowY][x] = PALETTE.groundShadow;
    }

    return grid;
}

// "Celebrate"/"fist" prop: small raised fists extending straight up from an
// arm's outer tip. Tried shifting the whole arms band up first — it just
// merged into the head at this resolution. A thin stub reads as "arm up"
// far more clearly than moving the existing band ever did.
// side: 'both' (celebrate) | 'left' | 'right' (fist)
function drawArmsUp(grid, side = 'both') {
    const xs = side === 'both' ? [armsCols[0], armsCols[1]] : [side === 'left' ? armsCols[0] : armsCols[1]];
    for (const x of xs) {
        for (let dy = 1; dy <= 3; dy++) {
            const y = armsRow[0] - dy;
            if (y >= 0 && y < GRID) grid[y][x] = PALETTE.body;
        }
    }
}

// Eyes: 32x32 in a 258-wide core -> ~12.4% of core width, flush with the
// bottom of the head band, symmetric with an inner gap of ~47.7% of core width.
// xOffset (a few cells either way) is the "look left/right" cue — the
// smallest change that reads as a glance without redesigning the head.
const eyeColsLeft = band(36, 67);
const eyeColsRight = band(190, 222);

function drawEyes(grid, closed, xOffset = 0) {
    const eyeBottom = headRow[1];
    const eyeSize = eyeColsLeft[1] - eyeColsLeft[0] + 1;
    const left = [eyeColsLeft[0] + xOffset, eyeColsLeft[1] + xOffset];
    const right = [eyeColsRight[0] + xOffset, eyeColsRight[1] + xOffset];

    if (closed) {
        const y = eyeBottom - Math.floor(eyeSize / 2);
        for (const [x0, x1] of [left, right]) {
            for (let x = x0; x <= x1; x++) if (x >= 0 && x < GRID) grid[y][x] = PALETTE.eye;
        }
        return;
    }

    for (const [x0, x1] of [left, right]) {
        for (let y = eyeBottom - eyeSize + 1; y <= eyeBottom; y++) {
            for (let x = x0; x <= x1; x++) if (x >= 0 && x < GRID) grid[y][x] = PALETTE.eye;
        }
    }
}

// mouth: 'none' | 'happy' | 'sleep' | 'yawn'
function drawMouth(grid, mouth) {
    const mouthY = lowerRow[0] + 1;

    if (mouth === 'sleep') {
        grid[mouthY][CENTER] = PALETTE.mouth; // small "o" of a snoozing mouth
        return;
    }
    if (mouth === 'yawn') {
        // a bigger open "o" — reuses the sleep mouth's spot but wider/taller
        for (let y = mouthY - 1; y <= mouthY + 1; y++) {
            for (let x = CENTER - 1; x <= CENTER + 1; x++) grid[y][x] = PALETTE.mouth;
        }
        return;
    }
    if (mouth === 'happy') {
        grid[mouthY][CENTER - 1] = PALETTE.mouth;
        grid[mouthY][CENTER] = PALETTE.mouth;
        grid[mouthY][CENTER + 1] = PALETTE.mouth;
        grid[mouthY - 1][CENTER - 2] = PALETTE.mouth;
        grid[mouthY - 1][CENTER + 2] = PALETTE.mouth;
    }
    // 'none': matches the reference art (just the eyes)
}

// stage 0..2 — marks appear one at a time, drifting further from the head
// each stage, then the loop resets. This is what makes sleeping read as
// animated rather than a static "zzz" sticker. An optional color override
// (see the 'dream' behavior) tints the marks without changing their shape.
const ZZZ_MARKS = [
    { x: armsCols[1] - 2, y: headRow[0] - 2 },
    { x: armsCols[1] + 1, y: headRow[0] - 5 },
    { x: armsCols[1] + 4, y: headRow[0] - 8 }
];

function drawZzz(grid, stage, color = PALETTE.zzz) {
    for (let i = 0; i <= stage; i++) {
        const { x, y } = ZZZ_MARKS[i];
        if (y < 0 || y >= GRID || x < 0 || x >= GRID) continue;
        grid[y][x] = color;
    }
}

// "Implementing" prop: a small laptop held in front, its screen filled with
// code-line dashes that shuffle pattern each frame to read as active typing.
const LAPTOP_SCREEN = { top: lowerRow[0] - 2, bottom: lowerRow[0] + 2, left: CENTER - 7, right: CENTER + 6 };
const LAPTOP_BASE_ROW = LAPTOP_SCREEN.bottom + 1;
const CODE_PATTERNS = [[4, 6, 3], [6, 3, 5], [3, 5, 6], [5, 4, 4]];

function drawLaptop(grid, codeFrame) {
    for (let y = LAPTOP_SCREEN.top; y <= LAPTOP_SCREEN.bottom; y++) {
        for (let x = LAPTOP_SCREEN.left; x <= LAPTOP_SCREEN.right; x++) grid[y][x] = PALETTE.device;
    }
    for (let y = LAPTOP_SCREEN.top + 1; y <= LAPTOP_SCREEN.bottom - 1; y++) {
        for (let x = LAPTOP_SCREEN.left + 1; x <= LAPTOP_SCREEN.right - 1; x++) grid[y][x] = PALETTE.screen;
    }
    for (let x = LAPTOP_SCREEN.left - 1; x <= LAPTOP_SCREEN.right + 1; x++) {
        if (grid[LAPTOP_BASE_ROW]) grid[LAPTOP_BASE_ROW][x] = PALETTE.device;
    }

    const widths = CODE_PATTERNS[codeFrame % CODE_PATTERNS.length];
    widths.forEach((w, i) => {
        const y = LAPTOP_SCREEN.top + 1 + i;
        for (let dx = 0; dx < w; dx++) {
            const x = LAPTOP_SCREEN.left + 2 + dx;
            if (x <= LAPTOP_SCREEN.right - 2) grid[y][x] = PALETTE.codeLine;
        }
    });
}

// A small magnifying glass near the laptop — the 'debug' behavior.
const MAG_CX = LAPTOP_SCREEN.right + 4, MAG_CY = LAPTOP_SCREEN.top + 1;

function drawMagnifier(grid) {
    const ring = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    for (const [dx, dy] of ring) {
        const x = MAG_CX + dx, y = MAG_CY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.device;
    }
    for (const [dx, dy] of [[2, 2], [3, 3]]) {
        const x = MAG_CX + dx, y = MAG_CY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.device;
    }
}

// "Planning" prop: a thought bubble above the head, built up dot by dot —
// stage 0-1 are trailing dots, stage 2 pops the full bubble with a mark
// inside ('dots' = "...", 'question' = "?", used by the 'confused' behavior).
const THOUGHT_DOTS = [
    { x: armsCols[1] - 1, y: headRow[0] - 2 },
    { x: armsCols[1] + 2, y: headRow[0] - 4 }
];
const BUBBLE = { top: headRow[0] - 7, bottom: headRow[0] - 3, left: CENTER + 2, right: CENTER + 10 };

function drawThoughtBubble(grid, stage, markType = 'dots') {
    for (let i = 0; i < THOUGHT_DOTS.length && i < stage; i++) {
        const { x, y } = THOUGHT_DOTS[i];
        if (y >= 0 && y < GRID) grid[y][x] = PALETTE.bubble;
    }
    if (stage < 2) return;

    for (let y = BUBBLE.top; y <= BUBBLE.bottom; y++) {
        for (let x = BUBBLE.left; x <= BUBBLE.right; x++) {
            if (y >= 0 && y < GRID && x >= 0 && x < GRID) grid[y][x] = PALETTE.bubble;
        }
    }

    if (markType === 'question') {
        const qx = Math.round((BUBBLE.left + BUBBLE.right) / 2);
        grid[BUBBLE.top + 1][qx - 1] = PALETTE.bubbleMark;
        grid[BUBBLE.top + 1][qx] = PALETTE.bubbleMark;
        grid[BUBBLE.top + 2][qx] = PALETTE.bubbleMark;
        grid[BUBBLE.bottom - 1][qx] = PALETTE.bubbleMark;
        return;
    }
    if (markType === '404') {
        // Abstract, not literal digits at this resolution — three short
        // bars of different heights, distinct from both '...' and '?'.
        const baseY = BUBBLE.bottom - 1;
        [1, 3, 5].forEach((dx, i) => {
            const h = i + 1;
            for (let k = 0; k < h; k++) {
                const y = baseY - k;
                if (y >= BUBBLE.top) grid[y][BUBBLE.left + dx] = PALETTE.bubbleMark;
            }
        });
        return;
    }
    const midY = Math.round((BUBBLE.top + BUBBLE.bottom) / 2);
    for (const dx of [2, 4, 6]) grid[midY][BUBBLE.left + dx] = PALETTE.bubbleMark;
}

// A small lightbulb above the head — the 'idea' behavior.
const IDEA_CX = CENTER + 6, IDEA_CY = headRow[0] - 5;

function drawIdea(grid) {
    for (const [dx, dy] of [[-1, 0], [0, 0], [1, 0], [0, -1], [0, 1]]) {
        const x = IDEA_CX + dx, y = IDEA_CY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.idea;
    }
    for (const [dx, dy] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
        const x = IDEA_CX + dx, y = IDEA_CY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.idea;
    }
}

// "Running" prop: a small spark near the head that flips orientation each
// frame — a lightweight "processing" cue for generic tool activity (Bash,
// Read, Grep, web calls) that isn't specifically planning or writing code.
// `extra` (the 'fast' behavior) adds a second, further-out particle.
const SPARK_CX = CENTER + 10, SPARK_CY = headRow[0] - 4;
const SPARK_FRAMES = [
    [[0, -2], [0, 2], [-2, 0], [2, 0]],
    [[-2, -2], [2, 2], [-2, 2], [2, -2]]
];

function drawSpinner(grid, frame, extra = false) {
    const points = SPARK_FRAMES[frame % SPARK_FRAMES.length];
    for (const [dx, dy] of points) {
        const x = SPARK_CX + dx, y = SPARK_CY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.spark;
    }
    if (SPARK_CY >= 0 && SPARK_CY < GRID) grid[SPARK_CY][SPARK_CX] = PALETTE.spark;
    if (extra) {
        const [dx, dy] = points[0];
        const x = SPARK_CX + dx * 2, y = SPARK_CY + dy * 2;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.spark;
    }
}

// A small scatter of colored pixels around the head — the 'confetti' success
// behavior. Fixed spots revealed a few at a time (like the zzz/bubble
// build-ups) rather than placed randomly, so the same frame always renders
// the same way.
const CONFETTI_SPOTS = [
    { x: coreCols[0] - 3, y: headRow[0] - 2, color: 'idea' },
    { x: coreCols[1] + 3, y: headRow[0] - 1, color: 'spark' },
    { x: coreCols[0] - 2, y: armsRow[0] - 3, color: 'codeLine' },
    { x: coreCols[1] + 2, y: armsRow[0] - 2, color: 'bubble' },
    { x: CENTER, y: headRow[0] - 6, color: 'idea' },
    { x: coreCols[0] + 1, y: headRow[0] - 5, color: 'spark' }
];

function drawConfetti(grid, count) {
    for (let i = 0; i < count && i < CONFETTI_SPOTS.length; i++) {
        const { x, y, color } = CONFETTI_SPOTS[i];
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE[color];
    }
}

// A small clock above the head — the 'checkClock' bored behavior. Reuses
// the magnifier's ring-drawing shape with a couple of "hands" instead of a
// handle, so it still reads as its own object.
const CLOCK_CX = CENTER + 6, CLOCK_CY = headRow[0] - 5;

function drawClock(grid) {
    const ring = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    for (const [dx, dy] of ring) {
        const x = CLOCK_CX + dx, y = CLOCK_CY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.device;
    }
    grid[CLOCK_CY][CLOCK_CX] = PALETTE.bubbleMark; // center
    grid[CLOCK_CY - 1][CLOCK_CX] = PALETTE.bubbleMark; // hand pointing up
    grid[CLOCK_CY][CLOCK_CX + 1] = PALETTE.bubbleMark; // hand pointing right
}

// A small coffee mug — the 'coffee' implementing behavior, sits beside the
// laptop rather than on top of it.
const MUG_CX = LAPTOP_SCREEN.right + 4, MUG_CY = LAPTOP_BASE_ROW - 1;

function drawMug(grid, steaming) {
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0]]) {
        const x = MUG_CX + dx, y = MUG_CY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.device;
    }
    grid[MUG_CY - 1][MUG_CX + 2] = PALETTE.device; // handle
    if (steaming) {
        grid[MUG_CY - 2][MUG_CX] = PALETTE.bubble;
        grid[MUG_CY - 3][MUG_CX - 1] = PALETTE.bubble;
    }
}

// A pair of small glasses over the eyes — the 'codeReview' implementing
// behavior (device-gray frame), reused as dark sunglasses for the very rare
// 'hacker' bored behavior (solid dark lenses instead). Drawn after the
// eyes, so it overlays them.
function drawGlasses(grid, dark = false) {
    const eyeBottom = headRow[1];
    const eyeSize = eyeColsLeft[1] - eyeColsLeft[0] + 1;
    const y = eyeBottom - Math.floor(eyeSize / 2);
    const lensColor = dark ? PALETTE.eye : PALETTE.device;
    for (const [x0, x1] of [eyeColsLeft, eyeColsRight]) {
        for (let x = x0 - 1; x <= x1 + 1; x++) {
            if (x < 0 || x >= GRID) continue;
            grid[y - 2][x] = PALETTE.device;
            if (dark) for (let yy = y - 1; yy <= y + 1; yy++) grid[yy][x] = lensColor;
        }
    }
    const bridgeX = Math.round((eyeColsLeft[1] + eyeColsRight[0]) / 2);
    grid[y - 2][bridgeX] = PALETTE.device;
}

// A small rubber duck beside him — the 'rubberDuck' planning behavior.
const DUCK_CX = coreCols[1] + 4, DUCK_CY = legsRow[0];

function drawDuck(grid) {
    for (const [dx, dy] of [[-1, 0], [0, 0], [1, 0], [-1, -1], [0, -1]]) {
        const x = DUCK_CX + dx, y = DUCK_CY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.idea;
    }
    const bx = DUCK_CX + 2, by = DUCK_CY - 1;
    if (bx >= 0 && bx < GRID && by >= 0 && by < GRID) grid[by][bx] = PALETTE.spark; // beak
}

// A tiny bug — the 'bug' error behavior. Two frames (legs in/out) so
// "trying to catch it" reads as a little scuttle rather than a static icon.
const BUG_CX = coreCols[1] + 4, BUG_CY = lowerRow[1];

function drawBug(grid, frame) {
    grid[BUG_CY][BUG_CX] = PALETTE.bug;
    grid[BUG_CY][BUG_CX + 1] = PALETTE.bug;
    const legDy = frame % 2 === 0 ? -1 : 1;
    for (const dx of [-1, 2]) {
        const x = BUG_CX + dx, y = BUG_CY + legDy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.bug;
    }
}

// A tiny git graph (branch line + commit dots) — the 'git' implementing
// easter egg. Purely abstract, no text, just a node-graph shape.
const GIT_CX = LAPTOP_SCREEN.right + 4, GIT_CY = LAPTOP_SCREEN.top;

function drawGitGraph(grid, litIndex) {
    for (let dy = 0; dy <= 4; dy += 2) {
        const y = GIT_CY + dy;
        if (y >= 0 && y < GRID) grid[y][GIT_CX] = PALETTE.device;
    }
    const dotYs = [GIT_CY, GIT_CY + 2, GIT_CY + 4];
    dotYs.forEach((y, i) => {
        if (y >= 0 && y < GRID) grid[y][GIT_CX] = i === litIndex ? PALETTE.codeLine : PALETTE.device;
    });
    // a short branch off the middle commit
    const by = GIT_CY + 2;
    if (by >= 0 && by < GRID) grid[by][GIT_CX + 1] = PALETTE.device;
}

// A small rocket that rises across frames — the 'deploy' easter egg.
const ROCKET_CX = CENTER + 9;

function drawRocket(grid, riseOffset) {
    const baseY = headRow[0] - 3 - riseOffset;
    const body = [[0, 0], [0, -1], [0, -2], [-1, 1], [1, 1]];
    for (const [dx, dy] of body) {
        const x = ROCKET_CX + dx, y = baseY + dy;
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.device;
    }
    const fy = baseY + 2;
    if (fy >= 0 && fy < GRID) grid[fy][ROCKET_CX] = PALETTE.spark;
}

// Small blocks stacking beside the laptop, one toppling over — the
// 'stackOverflow' easter egg (section 4 of the request).
const STACK_CX = LAPTOP_SCREEN.right + 3, STACK_BASE_Y = LAPTOP_BASE_ROW;

function drawStack(grid, level) {
    for (let i = 0; i < level; i++) {
        const y = STACK_BASE_Y - i;
        if (y < 0 || y >= GRID) continue;
        grid[y][STACK_CX] = PALETTE.idea;
        if (STACK_CX + 1 < GRID) grid[y][STACK_CX + 1] = PALETTE.idea;
    }
}

function drawFallenBlock(grid) {
    const y = STACK_BASE_Y + 1, x = STACK_CX + 3;
    if (y >= 0 && y < GRID && x < GRID) grid[y][x] = PALETTE.idea;
}

// A tiny bouncing/kicked ball — bored_kick and bored_play. Position is
// passed in directly rather than derived, since the two behaviors move it
// very differently (kicked away vs. bounced in place).
function drawBall(grid, x, y) {
    if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.spark;
}
const BALL_BASE_X = coreCols[1] + 4, BALL_BASE_Y = legsRow[1];

// A few dots "falling" at different heights — the very rare 'matrix' bored
// behavior. Same fixed-spot-revealed trick as confetti/zzz, just read as a
// vertical drift instead of a static scatter.
const MATRIX_COLS = [coreCols[0] - 3, CENTER, coreCols[1] + 3];

function drawMatrixRain(grid, frame) {
    MATRIX_COLS.forEach((x, i) => {
        const y = headRow[0] - 6 + ((frame + i * 2) % 8);
        if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = PALETTE.codeLine;
    });
}

async function gridToImage(grid, { bobCells = 0, xShiftCells = 0 } = {}) {
    // Both offsets work the same way: sample the source grid from a shifted
    // position so the whole silhouette appears to move. bobCells positive
    // lifts the body up; xShiftCells positive leans it right.
    const yOffsetPx = -bobCells * CELL;
    const xOffsetPx = xShiftCells * CELL;
    const img = new Jimp(SIZE, SIZE, PALETTE.bg);
    img.scan(0, 0, SIZE, SIZE, function (px, py, idx) {
        const gx = Math.floor((px - xOffsetPx) / CELL);
        const gy = Math.floor((py - yOffsetPx) / CELL);
        const color = grid[gy]?.[gx];
        if (!color) return;
        this.bitmap.data[idx + 0] = (color >> 24) & 0xff;
        this.bitmap.data[idx + 1] = (color >> 16) & 0xff;
        this.bitmap.data[idx + 2] = (color >> 8) & 0xff;
        this.bitmap.data[idx + 3] = 0xff;
    });
    return (await img.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
}

// --- Behavior layer -------------------------------------------------------
// Each mood/state owns a small pool of named behaviors, each its own short
// frame sequence with a selection weight. index.js plays one behavior all
// the way through, then asks for a new one (see pickBehavior) — never just
// picks a random frame in isolation, so nothing looks broken mid-motion.
// `normal` in every state is exactly the original 4-frame sequence from
// before this behavior system existed — nothing already shipped changes.
const BEHAVIORS = {
    idle: [
        { name: 'normal', weight: 50, frames: [
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 1, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: true, mouth: 'none' }
        ] },
        { name: 'blink', weight: 20, frames: [
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: true, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: true, mouth: 'none' }
        ] },
        { name: 'lookAround', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 0 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: -3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 0 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 0 }
        ] },
        { name: 'yawn', weight: 10, frames: [
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'yawn' },
            { bob: 1, closed: true, mouth: 'yawn' },
            { bob: 0, closed: false, mouth: 'none' }
        ] }
    ],

    sleeping: [
        { name: 'normal', weight: 50, frames: [
            { bob: 0, closed: true, mouth: 'sleep', zzz: 0 },
            { bob: 1, closed: true, mouth: 'sleep', zzz: 1 },
            { bob: 0, closed: true, mouth: 'sleep', zzz: 2 },
            { bob: 1, closed: true, mouth: 'sleep', zzz: 1 }
        ] },
        { name: 'headDrop', weight: 20, frames: [
            { bob: 0, closed: true, mouth: 'sleep', zzz: 0 },
            { bob: -1, closed: true, mouth: 'sleep', zzz: 0 },
            { bob: -1, closed: true, mouth: 'sleep', zzz: 1 },
            { bob: 0, closed: true, mouth: 'sleep', zzz: 1 }
        ] },
        { name: 'dream', weight: 15, frames: [
            { bob: 0, closed: true, mouth: 'sleep', zzz: 0, zzzColor: 'idea' },
            { bob: 1, closed: true, mouth: 'sleep', zzz: 1, zzzColor: 'spark' },
            { bob: 0, closed: true, mouth: 'sleep', zzz: 2, zzzColor: 'bubble' },
            { bob: 1, closed: true, mouth: 'sleep', zzz: 1, zzzColor: 'idea' }
        ] },
        { name: 'wakeUp', weight: 10, frames: [
            { bob: 0, closed: true, mouth: 'sleep', zzz: 2 },
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: true, mouth: 'sleep', zzz: 0 }
        ] }
    ],

    happy: [
        { name: 'normal', weight: 50, frames: [
            { bob: 0, closed: false, mouth: 'happy' },
            { bob: 1, closed: false, mouth: 'happy' },
            { bob: 0, closed: false, mouth: 'happy' },
            { bob: 1, closed: false, mouth: 'happy' }
        ] },
        { name: 'jump', weight: 20, frames: [
            { bob: -1, closed: false, mouth: 'happy' },
            { bob: 2, closed: false, mouth: 'happy' },
            { bob: 1, closed: false, mouth: 'happy' },
            { bob: 0, closed: false, mouth: 'happy' }
        ] },
        { name: 'celebrate', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'happy', armsUp: false },
            { bob: 0, closed: false, mouth: 'happy', armsUp: true },
            { bob: 1, closed: false, mouth: 'happy', armsUp: true },
            { bob: 0, closed: false, mouth: 'happy', armsUp: false }
        ] },
        { name: 'dance', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'happy', xShift: -1 },
            { bob: 0, closed: false, mouth: 'happy', xShift: 1 },
            { bob: 0, closed: false, mouth: 'happy', xShift: -1 },
            { bob: 0, closed: false, mouth: 'happy', xShift: 1 }
        ] }
    ],

    // Deliberately no bob on 'normal' — he's concentrating.
    implementing: [
        { name: 'normal', weight: 50, frames: [
            { bob: 0, closed: false, mouth: 'none', laptop: 0 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1 },
            { bob: 0, closed: true, mouth: 'none', laptop: 2 },
            { bob: 0, closed: false, mouth: 'none', laptop: 3 }
        ] },
        { name: 'fast', weight: 20, frames: [
            { bob: 0, closed: false, mouth: 'none', laptop: 0 },
            { bob: 0, closed: false, mouth: 'none', laptop: 2 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 3 },
            { bob: 0, closed: false, mouth: 'none', laptop: 0 }
        ] },
        { name: 'pause', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'none', laptop: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 2 }
        ] },
        { name: 'debug', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'none', laptop: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, magnifier: true },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, magnifier: true },
            { bob: 0, closed: false, mouth: 'none', laptop: 2 }
        ] },
        // Rare on purpose (section 13 of the request: "se o café aparecer a
        // cada 30s, perde a graça") — low weight, and duration-boosted only
        // after a long continuous coding stretch (see index.js).
        { name: 'coffee', weight: 4, frames: [
            { bob: 0, closed: false, mouth: 'none', laptop: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, mug: true, mugSteam: true },
            { bob: 0, closed: true, mouth: 'none', laptop: 1, mug: true },
            { bob: 0, closed: false, mouth: 'none', laptop: 2 }
        ] },
        { name: 'codeReview', weight: 4, frames: [
            { bob: 0, closed: false, mouth: 'none', laptop: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, glasses: true },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, glasses: true },
            { bob: 0, closed: false, mouth: 'none', laptop: 2 }
        ] },
        { name: 'git', weight: 3, frames: [
            { bob: 0, closed: false, mouth: 'none', laptop: 1, git: 0 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, git: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, git: 2 },
            { bob: 0, closed: false, mouth: 'none', laptop: 2 }
        ] },
        { name: 'stackOverflow', weight: 3, frames: [
            { bob: 0, closed: false, mouth: 'none', laptop: 1, stack: 1 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, stack: 2 },
            { bob: 0, closed: false, mouth: 'none', laptop: 1, stack: 3 },
            { bob: 1, closed: true, mouth: 'none', laptop: 1, fallenBlock: true }
        ] }
    ],

    planning: [
        { name: 'normal', weight: 50, frames: [
            { bob: 0, closed: false, mouth: 'none', bubble: 0 },
            { bob: 0, closed: false, mouth: 'none', bubble: 1 },
            { bob: 1, closed: false, mouth: 'none', bubble: 2 },
            { bob: 0, closed: false, mouth: 'none', bubble: 2 }
        ] },
        { name: 'confused', weight: 20, frames: [
            { bob: 0, closed: false, mouth: 'none', bubble: 2, bubbleMark: 'question', eyeOffset: -3 },
            { bob: 0, closed: false, mouth: 'none', bubble: 2, bubbleMark: 'question', eyeOffset: 3 },
            { bob: 0, closed: false, mouth: 'none', bubble: 2, bubbleMark: 'question', eyeOffset: 0 },
            { bob: 0, closed: false, mouth: 'none', bubble: 1, bubbleMark: 'question' }
        ] },
        { name: 'idea', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'none', bubble: 1 },
            { bob: 0, closed: false, mouth: 'none', idea: true },
            { bob: 1, closed: false, mouth: 'happy', idea: true },
            { bob: 0, closed: false, mouth: 'none' }
        ] },
        { name: 'rubberDuck', weight: 5, frames: [
            { bob: 0, closed: false, mouth: 'none', duck: true },
            { bob: 0, closed: false, mouth: 'none', duck: true, bubble: 1 },
            { bob: 0, closed: false, mouth: 'none', duck: true },
            { bob: 0, closed: false, mouth: 'none' }
        ] }
    ],

    running: [
        { name: 'normal', weight: 50, frames: [
            { bob: 0, closed: false, mouth: 'none', spark: 0 },
            { bob: 1, closed: false, mouth: 'none', spark: 1 },
            { bob: 0, closed: false, mouth: 'none', spark: 0 },
            { bob: 1, closed: false, mouth: 'none', spark: 1 }
        ] },
        { name: 'fast', weight: 20, frames: [
            { bob: 0, closed: false, mouth: 'none', spark: 0, sparkExtra: true },
            { bob: 1, closed: false, mouth: 'none', spark: 1, sparkExtra: true },
            { bob: 0, closed: false, mouth: 'none', spark: 0, sparkExtra: true },
            { bob: 1, closed: false, mouth: 'none', spark: 1, sparkExtra: true }
        ] },
        { name: 'waiting', weight: 20, frames: [
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: true, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' }
        ] },
        { name: 'impatient', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'none', eyeOffset: -3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 0, spark: 0 },
            { bob: 0, closed: false, mouth: 'none', spark: 1 }
        ] },
        { name: '404', weight: 2, frames: [
            { bob: 0, closed: false, mouth: 'none', eyeOffset: -3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 3 },
            { bob: 0, closed: false, mouth: 'none', bubble: 2, bubbleMark: '404' },
            { bob: 0, closed: false, mouth: 'none', bubble: 1 }
        ] }
    ],

    // Very rare click reaction ("tô trabalhando, pô") — one-shot like
    // success/error, falls back the same way once it finishes.
    annoyed: [
        { name: 'normal', weight: 100, frames: [
            { bob: 0, closed: false, mouth: 'none', eyeOffset: -3 },
            { bob: -1, closed: false, mouth: 'none', eyeOffset: -3 },
            { bob: -1, closed: true, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' }
        ] }
    ],

    // Not detected by claudeState — index.js switches into this on its own
    // after a long enough idle stretch (claudeState only knows "sleeping" vs
    // "busy", not "idle for how long"). Reuses only existing primitives.
    bored: [
        { name: 'normal', weight: 50, frames: [
            { bob: 0, closed: false, mouth: 'none' },
            { bob: -1, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: true, mouth: 'none' }
        ] },
        { name: 'sigh', weight: 25, frames: [
            { bob: 0, closed: false, mouth: 'none', eyeOffset: -3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 0 },
            { bob: -1, closed: false, mouth: 'none' }
        ] },
        { name: 'yawn', weight: 25, frames: [
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'yawn' },
            { bob: 1, closed: true, mouth: 'yawn' },
            { bob: 0, closed: false, mouth: 'none' }
        ] },
        { name: 'lookAround', weight: 20, frames: [
            { bob: 0, closed: false, mouth: 'none', eyeOffset: -3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 0 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 3 },
            { bob: 0, closed: false, mouth: 'none', eyeOffset: 0 }
        ] },
        { name: 'checkClock', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none', clock: true },
            { bob: 0, closed: false, mouth: 'none', clock: true },
            { bob: 0, closed: false, mouth: 'none' }
        ] },
        { name: 'kick', weight: 8, frames: [
            { bob: 0, closed: false, mouth: 'none', ball: [BALL_BASE_X, BALL_BASE_Y] },
            { bob: 0, closed: false, mouth: 'happy', ball: [BALL_BASE_X + 3, BALL_BASE_Y] },
            { bob: 0, closed: false, mouth: 'happy', ball: [BALL_BASE_X + 6, BALL_BASE_Y - 1] },
            { bob: 0, closed: false, mouth: 'none' }
        ] },
        { name: 'play', weight: 8, frames: [
            { bob: 0, closed: false, mouth: 'none', ball: [BALL_BASE_X, BALL_BASE_Y - 4] },
            { bob: 0, closed: false, mouth: 'none', ball: [BALL_BASE_X, BALL_BASE_Y - 1] },
            { bob: 0, closed: false, mouth: 'none', ball: [BALL_BASE_X, BALL_BASE_Y - 4] },
            { bob: 0, closed: false, mouth: 'none', ball: [BALL_BASE_X, BALL_BASE_Y - 1] }
        ] },
        // Very rare (section 12 of the request) — kept genuinely uncommon on
        // purpose, weight 1 out of a pool that otherwise sums to well over 100.
        { name: 'matrix', weight: 1, frames: [
            { bob: 0, closed: false, mouth: 'none', matrix: 0 },
            { bob: 0, closed: false, mouth: 'none', matrix: 1 },
            { bob: 0, closed: false, mouth: 'none', matrix: 2 },
            { bob: 0, closed: false, mouth: 'none', matrix: 3 }
        ] },
        { name: 'hacker', weight: 1, frames: [
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none', glasses: true, glassesDark: true },
            { bob: 1, closed: false, mouth: 'none', glasses: true, glassesDark: true },
            { bob: 0, closed: false, mouth: 'none', glasses: true, glassesDark: true }
        ] }
    ],

    // One-shot: index.js plays this once then falls back to whatever's
    // appropriate (see ONE_SHOT_MOODS). Triggered when a stretch of real
    // work (implementing/running/planning) ends cleanly — not on every
    // successful tool result, which would fire constantly and stop meaning
    // anything; see claudeState.js's comment on why there's no reliable
    // "task succeeded" signal to key off directly.
    success: [
        { name: 'jump', weight: 40, frames: [
            { bob: -1, closed: false, mouth: 'happy' },
            { bob: 2, closed: false, mouth: 'happy' },
            { bob: 1, closed: false, mouth: 'happy' },
            { bob: 0, closed: false, mouth: 'happy' }
        ] },
        { name: 'celebrate', weight: 30, frames: [
            { bob: 0, closed: false, mouth: 'happy', armsUp: false },
            { bob: 0, closed: false, mouth: 'happy', armsUp: true },
            { bob: 1, closed: false, mouth: 'happy', armsUp: true },
            { bob: 0, closed: false, mouth: 'happy', armsUp: false }
        ] },
        { name: 'confetti', weight: 30, frames: [
            { bob: 0, closed: false, mouth: 'happy', confetti: 2 },
            { bob: 1, closed: false, mouth: 'happy', confetti: 4 },
            { bob: 0, closed: false, mouth: 'happy', confetti: 6 },
            { bob: 1, closed: false, mouth: 'happy', confetti: 4 }
        ] },
        { name: 'fist', weight: 25, frames: [
            { bob: 0, closed: false, mouth: 'happy', armsUp: true, armsSide: 'right' },
            { bob: 1, closed: false, mouth: 'happy', armsUp: true, armsSide: 'right' },
            { bob: 0, closed: false, mouth: 'happy', armsUp: true, armsSide: 'right' },
            { bob: 0, closed: false, mouth: 'happy' }
        ] },
        { name: 'highFive', weight: 3, frames: [
            { bob: 0, closed: false, mouth: 'happy', armsUp: true, armsSide: 'left' },
            { bob: 0, closed: false, mouth: 'happy', armsUp: true, armsSide: 'left' },
            { bob: 0, closed: false, mouth: 'happy', armsUp: true, armsSide: 'left' },
            { bob: 0, closed: false, mouth: 'happy' }
        ] },
        { name: 'deploy', weight: 3, frames: [
            { bob: 0, closed: false, mouth: 'happy', rocket: 0 },
            { bob: 0, closed: false, mouth: 'happy', rocket: 2, eyeOffset: 2 },
            { bob: 0, closed: false, mouth: 'happy', rocket: 4, eyeOffset: 3 },
            { bob: 0, closed: false, mouth: 'happy' }
        ] }
    ],

    // One-shot, triggered when the last thing in the transcript was a
    // failed tool result (see claudeState.js's lastEntryIsError) — falls
    // back automatically once the assistant's next turn starts, since at
    // that point the failed result is no longer the most recent event.
    error: [
        { name: 'surprised', weight: 40, frames: [
            { bob: 2, closed: false, mouth: 'none' },
            { bob: -1, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' }
        ] },
        { name: 'confused', weight: 35, frames: [
            { bob: 0, closed: false, mouth: 'none', bubble: 2, bubbleMark: 'question' },
            { bob: 0, closed: false, mouth: 'none', bubble: 2, bubbleMark: 'question', eyeOffset: -3 },
            { bob: 0, closed: false, mouth: 'none', bubble: 2, bubbleMark: 'question', eyeOffset: 3 },
            { bob: 0, closed: false, mouth: 'none', bubble: 1 }
        ] },
        { name: 'facepalm', weight: 25, frames: [
            { bob: 0, closed: true, mouth: 'none' },
            { bob: -1, closed: true, mouth: 'none' },
            { bob: -1, closed: true, mouth: 'none' },
            { bob: 0, closed: false, mouth: 'none' }
        ] },
        { name: 'scratch', weight: 15, frames: [
            { bob: 0, closed: false, mouth: 'none', armsUp: true, armsSide: 'left' },
            { bob: 1, closed: false, mouth: 'none', armsUp: true, armsSide: 'left' },
            { bob: 0, closed: false, mouth: 'none', armsUp: true, armsSide: 'left' },
            { bob: 0, closed: false, mouth: 'none' }
        ] },
        { name: 'bug', weight: 10, frames: [
            { bob: 0, closed: false, mouth: 'none', bug: 0 },
            { bob: 0, closed: false, mouth: 'none', bug: 1 },
            { bob: 1, closed: false, mouth: 'none', bug: 0 },
            { bob: 0, closed: false, mouth: 'none' }
        ] }
    ],

    // Marching in place — used only during the transition between buttons
    // (see index.js's walkTransition), not as an ambient mood on its own.
    // Frame 3 (neutral) doubles as the arrival pose; frame 4 is a small
    // settling bob played right after landing, instead of just materializing.
    walking: [
        { name: 'normal', weight: 100, frames: [
            { bob: 0, closed: false, mouth: 'none', legLift: { left: 3, right: 0 } },
            { bob: 0, closed: false, mouth: 'none', legLift: { left: 0, right: 0 } },
            { bob: 0, closed: false, mouth: 'none', legLift: { left: 0, right: 3 } },
            { bob: 0, closed: false, mouth: 'none', legLift: { left: 0, right: 0 } },
            { bob: -1, closed: false, mouth: 'none', legLift: { left: 0, right: 0 } }
        ] }
    ]
};

function getBehaviorFrames(state, behaviorName) {
    const pool = BEHAVIORS[state] || BEHAVIORS.idle;
    return pool.find(b => b.name === behaviorName) || pool[0];
}

async function renderFrame(state, behaviorName, frameIndex) {
    const behavior = getBehaviorFrames(state, behaviorName);
    const frame = behavior.frames[frameIndex % behavior.frames.length];

    const grid = buildBaseGrid(frame.legLift || { left: 0, right: 0 });
    drawEyes(grid, frame.closed, frame.eyeOffset || 0);
    drawMouth(grid, frame.mouth);
    if (frame.zzz !== undefined) drawZzz(grid, frame.zzz, frame.zzzColor ? PALETTE[frame.zzzColor] : PALETTE.zzz);
    if (frame.laptop !== undefined) drawLaptop(grid, frame.laptop);
    if (frame.bubble !== undefined) drawThoughtBubble(grid, frame.bubble, frame.bubbleMark || 'dots');
    if (frame.spark !== undefined) drawSpinner(grid, frame.spark, !!frame.sparkExtra);
    if (frame.idea) drawIdea(grid);
    if (frame.magnifier) drawMagnifier(grid);
    if (frame.armsUp) drawArmsUp(grid, frame.armsSide || 'both');
    if (frame.confetti !== undefined) drawConfetti(grid, frame.confetti);
    if (frame.clock) drawClock(grid);
    if (frame.mug !== undefined) drawMug(grid, !!frame.mugSteam);
    if (frame.duck) drawDuck(grid);
    if (frame.bug !== undefined) drawBug(grid, frame.bug);
    if (frame.git !== undefined) drawGitGraph(grid, frame.git);
    if (frame.rocket !== undefined) drawRocket(grid, frame.rocket);
    if (frame.stack !== undefined) drawStack(grid, frame.stack);
    if (frame.fallenBlock) drawFallenBlock(grid);
    if (frame.ball) drawBall(grid, frame.ball[0], frame.ball[1]);
    if (frame.matrix !== undefined) drawMatrixRain(grid, frame.matrix);
    // glasses drawn last so they sit on top of the eyes, not under them
    if (frame.glasses) drawGlasses(grid, !!frame.glassesDark);

    return gridToImage(grid, { bobCells: frame.bob || 0, xShiftCells: frame.xShift || 0 });
}

// Weighted pick within a state's behavior pool, excluding recently-used
// names when there's another option — this is what keeps "normal, normal,
// normal, normal" from happening while still letting normal dominate
// overall (it has the highest weight in every state). `boostNames` triples
// the weight of matching behaviors — used by index.js to make e.g. 'pause'/
// 'debug'/'coffee' more likely the longer implementing runs continuously,
// without needing a whole separate duration-aware system.
const BOOST_MULTIPLIER = 3;

function pickBehavior(state, excludeNames = [], boostNames = []) {
    const pool = BEHAVIORS[state] || BEHAVIORS.idle;
    let candidates = pool.filter(b => !excludeNames.includes(b.name));
    if (candidates.length === 0) candidates = pool;

    const weightOf = b => boostNames.includes(b.name) ? b.weight * BOOST_MULTIPLIER : b.weight;
    const total = candidates.reduce((sum, b) => sum + weightOf(b), 0);
    let r = Math.random() * total;
    for (const b of candidates) {
        r -= weightOf(b);
        if (r <= 0) return b.name;
    }
    return candidates[candidates.length - 1].name;
}

function behaviorFrameCount(state, behaviorName) {
    return getBehaviorFrames(state, behaviorName).frames.length;
}

// Plain background for the grid cells Clawd isn't currently occupying.
async function renderEmpty() {
    const img = new Jimp(SIZE, SIZE, PALETTE.bg);
    return (await img.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
}

module.exports = { renderFrame, renderEmpty, pickBehavior, behaviorFrameCount };
