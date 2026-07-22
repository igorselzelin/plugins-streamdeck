const Jimp = require('jimp');

const SIZE = 126;         // tamanho real do display
const PAUSED_SCALE = 0.90;
const ANIM_FRAMES = 7;    // frames da transição

async function renderBlendFrame(colorImg, bwImg, t) {
    // t: 0 = 100% colorido tamanho cheio  |  1 = 90% preto e branco
    const scale = 1 - (1 - PAUSED_SCALE) * t;
    const scaledSize = Math.floor(SIZE * scale);
    const offset = Math.floor((SIZE - scaledSize) / 2);

    const frame = colorImg.clone();

    // Blend: colorido → preto e branco conforme t
    frame.composite(bwImg.clone(), 0, 0, {
        mode: Jimp.BLEND_SOURCE_OVER,
        opacitySource: t,
        opacityDest: 1
    });

    // Zoom out conforme t
    frame.resize(scaledSize, scaledSize);
    const canvas = new Jimp(SIZE, SIZE, 0x000000ff);
    canvas.composite(frame, offset, offset);

    return (await canvas.getBase64Async(Jimp.MIME_JPEG)).replace('data:image/jpeg;base64,', '');
}

// Pré-renderiza todos os frames ao carregar uma faixa.
// Retorna: { playing, paused, toPause[], toPlay[] }
async function preRenderFrames(albumBase64) {
    const colorImg = (await Jimp.read(Buffer.from(albumBase64, 'base64'))).resize(SIZE, SIZE);
    const bwImg = colorImg.clone().greyscale();

    const all = [];
    for (let i = 0; i <= ANIM_FRAMES; i++) {
        all.push(await renderBlendFrame(colorImg, bwImg, i / ANIM_FRAMES));
    }
    // all[0] = tocando, all[FRAMES] = pausado
    return {
        playing: all[0],
        paused:  all[ANIM_FRAMES],
        toPause: all.slice(1),              // do estado atual até pausado
        toPlay:  all.slice(0, -1).reverse() // do estado atual até tocando
    };
}

// Render estático simples (fallback antes dos frames ficarem prontos)
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
