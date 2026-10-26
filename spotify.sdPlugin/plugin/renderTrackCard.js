const Jimp = require('jimp');

const SIZE = 126;         // actual display size
const PAUSED_SCALE = 0.90;
const ANIM_FRAMES = 7;    // transition frames

async function renderBlendFrame(colorImg, bwImg, t) {
    // t: 0 = 100% color, full size  |  1 = 90% black and white
    const scale = 1 - (1 - PAUSED_SCALE) * t;
    const scaledSize = Math.floor(SIZE * scale);
    const offset = Math.floor((SIZE - scaledSize) / 2);

    const frame = colorImg.clone();

    // Blend: color → black and white as t increases
    frame.composite(bwImg.clone(), 0, 0, {
        mode: Jimp.BLEND_SOURCE_OVER,
        opacitySource: t,
        opacityDest: 1
    });

    // Zoom out as t increases
    frame.resize(scaledSize, scaledSize);
    const canvas = new Jimp(SIZE, SIZE, 0x000000ff);
    canvas.composite(frame, offset, offset);

    return (await canvas.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
}

// Pre-renders all frames when a track loads.
// Returns: { playing, paused, toPause[], toPlay[] }
async function preRenderFrames(albumBase64) {
    const colorImg = (await Jimp.read(Buffer.from(albumBase64, 'base64'))).resize(SIZE, SIZE);
    const bwImg = colorImg.clone().greyscale();

    const all = [];
    for (let i = 0; i <= ANIM_FRAMES; i++) {
        all.push(await renderBlendFrame(colorImg, bwImg, i / ANIM_FRAMES));
    }
    // all[0] = playing, all[FRAMES] = paused
    return {
        playing: all[0],
        paused:  all[ANIM_FRAMES],
        toPause: all.slice(1),              // from current state to paused
        toPlay:  all.slice(0, -1).reverse() // from current state to playing
    };
}

// Simple static render (fallback before frames are ready)
async function renderTrackCard(albumBase64, paused = false) {
    const img = (await Jimp.read(Buffer.from(albumBase64, 'base64'))).resize(SIZE, SIZE);

    if (!paused) {
        return (await img.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
    }

    img.greyscale();
    const small = Math.floor(SIZE * PAUSED_SCALE);
    const offset = Math.floor((SIZE - small) / 2);
    img.resize(small, small);
    const canvas = new Jimp(SIZE, SIZE, 0x000000ff);
    canvas.composite(img, offset, offset);
    return (await canvas.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
}

module.exports = { renderTrackCard, preRenderFrames };
