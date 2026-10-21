const Jimp = require('jimp');
const parseBmfontXml = require('parse-bmfont-xml');
const fontData = require('./fontData');

const SIZE = 126;
const CENTER = SIZE / 2;
const OUTER_R = 54;
const INNER_R = 44; // thinner ring than before, to leave more room for bigger text

const TRACK_COLOR = 0x3a3a3eff; // mid gray, for contrast against a dark background

// The device's native title font size (manifest "FontSize") isn't reliably
// honored by this SDK — text overflowed the button regardless of the value
// set there. Baking the text into the image ourselves gives full control.
//
// Getting a bitmap font loaded here turned out to be its own fight: both
// Jimp's own Jimp.FONT_SANS_16_WHITE constant AND a hand-built path to a
// copy of the font placed in this plugin's own source tree get silently
// rewritten by ncc's asset relocator at build time — it detects the
// path.join(__dirname, "...") shape, copies ONLY the .fnt file (not the
// .png it references internally via XML, which ncc can't see) into a
// flattened build/ location, and rewrites the path to match. The .png
// then 404s at runtime no matter how the original path was constructed.
//
// The fix: never let a font asset touch the filesystem at runtime at all.
// fontData.js embeds the .fnt XML and the .png (as base64) as plain JS
// string constants — nothing for ncc's relocator to find or rewrite. The
// font object jimp's print()/measureText() expect is built by hand below,
// replicating @jimp/plugin-print's own loadFont() transform.
let fontPromise = null;
function loadFont() {
    if (!fontPromise) {
        fontPromise = (async () => {
            const raw = parseBmfontXml(fontData.xml);

            const chars = {};
            for (const c of raw.chars) chars[String.fromCharCode(c.id)] = c;

            const kernings = {};
            for (const k of raw.kernings) {
                const first = String.fromCharCode(k.first);
                kernings[first] = kernings[first] || {};
                kernings[first][String.fromCharCode(k.second)] = k.amount;
            }

            const pageImage = await Jimp.read(Buffer.from(fontData.pngBase64, 'base64'));

            return { chars, kernings, pages: [pageImage], common: raw.common, info: raw.info };
        })();
    }
    return fontPromise;
}

function ringColor(fraction) {
    if (fraction < 0.6) return 0x2ecc71ff;
    if (fraction < 0.85) return 0xf1c40fff;
    return 0xe74c3cff;
}

function setPixel(img, idx, color) {
    img.bitmap.data[idx + 0] = (color >> 24) & 0xff;
    img.bitmap.data[idx + 1] = (color >> 16) & 0xff;
    img.bitmap.data[idx + 2] = (color >> 8) & 0xff;
    img.bitmap.data[idx + 3] = 0xff;
}

async function drawCenteredText(img, text) {
    if (!text) return;
    const font = await loadFont();
    const width = Jimp.measureText(font, text);
    const height = Jimp.measureTextHeight(font, text, width);
    img.print(font, (SIZE - width) / 2, (SIZE - height) / 2, text);
}

// Flat solid-color background with centered text — idle/loading states.
async function renderFlat(background, text) {
    const img = new Jimp(SIZE, SIZE, background);
    await drawCenteredText(img, text);
    return (await img.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
}

// Donut progress ring, colored green/yellow/red by how full it is, with the
// value baked into the empty center as text.
async function renderRing(fraction, background = 0x1c1c1eff, text) {
    const img = new Jimp(SIZE, SIZE, background);
    const activeColor = ringColor(fraction);
    img.scan(0, 0, SIZE, SIZE, function (x, y, idx) {
        const dx = x - CENTER;
        const dy = y - CENTER;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < INNER_R || r > OUTER_R) return;
        let angle = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180, 0 = pointing right
        angle = (angle + 90 + 360) % 360; // rotate so 0 = top, sweeps clockwise
        const t = angle / 360;
        setPixel(this, idx, t <= fraction ? activeColor : TRACK_COLOR);
    });
    await drawCenteredText(img, text);
    return (await img.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
}

module.exports = { renderFlat, renderRing };
