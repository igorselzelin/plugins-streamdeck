// Regenerates the static icons in ../static from the same renderer the buttons use,
// so the action list and the live keys look alike. Run: npm run icons

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const render = require('../render');

const OUT = path.join(__dirname, '..', '..', 'static');

async function save(name, b64) {
    const img = await Jimp.read(Buffer.from(b64, 'base64'));
    await img.writeAsync(path.join(OUT, `${name}.png`));
    console.log('wrote', name);
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const live = { connection: 'connected', error: null };
    await save('play', await render.renderSound({ ...live, variant: 'play', soundId: 'icon-play', name: 'Tocar som', artwork: null, playing: false }));
    await save('toggle', await render.renderSound({ ...live, variant: 'toggle', soundId: 'icon-toggle', name: 'Tocar / Parar', artwork: null, playing: false }));
    await save('stop', await render.renderSound({ ...live, variant: 'stop', soundId: 'icon-stop', name: 'Parar som', artwork: null, playing: true }));
    await save('stopall', await render.renderStopAll({ ...live, playingCount: 0 }));
    await save('mute', await render.renderMute({ ...live, muted: false }));
    await save('status', await render.renderStatus({ connection: 'connected', playingCount: 0 }));
    await save('synk', await render.renderStatus({ connection: 'connected', playingCount: 0 }));

    // Volume knob icon: a simple level bar.
    const vol = new Jimp(render.SIZE, render.SIZE, 0x1c1c1eff);
    for (let i = 0; i < 5; i++) {
        const h = 16 + i * 14;
        vol.scan(18 + i * 20, 98 - h, 14, h, function (x, y, idx) {
            this.bitmap.data.writeUInt32BE(i < 3 ? 0x2ecc71ff : 0x5a5a5eff, idx);
        });
    }
    await vol.writeAsync(path.join(OUT, 'volume.png'));
    console.log('wrote volume');
})().catch(err => { console.error(err); process.exit(1); });
