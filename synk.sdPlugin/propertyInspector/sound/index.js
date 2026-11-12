/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

// Sound picker shared by Play, Play/Stop and Stop.
// The panel never talks to SYNK: it asks the plugin for the sound list
// (sendToPlugin 'getSounds') and sends the chosen ID back ('setSound');
// the plugin validates and saves it. Sound names are only ever set via
// textContent, never as HTML.

const $local = false, $back = false, $dom = {
    main: $('.sdpi-wrapper'),
    status: $('#status'),
    search: $('#search'),
    list: $('#list'),
    modeRow: $('#modeRow'),
    mode: $('#mode'),
    current: $('#current'),
    reload: $('#reload')
};

const CLOSED = ['err', 'SYNK não está aberto. Abra o SYNK para escolher um som.'];
const STATUS = {
    connected: ['ok', 'Conectado ao SYNK'],
    connecting: ['warn', 'Conectando ao SYNK...'],
    offline: CLOSED,
    stopped: CLOSED
};

let sounds = [];
let selected = { soundId: null, soundName: '', mode: 'overlap' };
let requested = false;
let retryTimer = null;

function setStatus(connection, error) {
    let [cls, text] = STATUS[connection] ?? CLOSED;
    if (connection === 'connected' && error) [cls, text] = ['err', `Erro ao listar sons (${error})`];
    else if (connection !== 'connected' && error === 'VERSION_MISMATCH') [cls, text] = ['err', 'Versões incompatíveis: atualize o SYNK ou o plugin.'];
    else if (connection === 'connected' && sounds.length === 0) [cls, text] = ['warn', 'Nenhum som na biblioteca do SYNK. Importe sons no SYNK.'];
    $dom.status.className = cls;
    $dom.status.textContent = text;
}

function renderCurrent() {
    $dom.current.textContent = selected.soundId ? (selected.soundName || selected.soundId) : 'nenhum';
    $dom.mode.value = selected.mode || 'overlap';
}

function renderList() {
    const query = $dom.search.value.trim().toLocaleLowerCase();
    const plain = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const q = plain(query);
    $dom.list.textContent = '';
    for (const s of sounds) {
        if (q && !plain(s.name.toLocaleLowerCase()).includes(q)) continue;
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        if (s.id === selected.soundId) opt.selected = true;
        $dom.list.appendChild(opt);
    }
}

function requestSounds() {
    requested = true;
    $websocket.sendToPlugin({ type: 'getSounds' });
}

function save(patch) {
    selected = { ...selected, ...patch };
    renderCurrent();
    $websocket.sendToPlugin({ type: 'setSound', ...selected });
}

$dom.search.on('input', $.debounce(renderList, 150));

$dom.list.on('change', () => {
    const s = sounds.find(x => x.id === $dom.list.value);
    if (s) save({ soundId: s.id, soundName: s.name });
});

$dom.mode.on('change', () => save({ mode: $dom.mode.value }));

$dom.reload.on('click', () => {
    $websocket.sendToPlugin({ type: 'retry' });
    requestSounds();
});

const $propEvent = {
    didReceiveSettings(data) {
        const s = data?.settings ?? {};
        selected = { soundId: s.soundId || null, soundName: s.soundName || '', mode: s.mode || 'overlap' };
        $dom.modeRow.style.display = String($action).endsWith('.play') ? '' : 'none';
        renderCurrent();
        if (!requested) requestSounds();
    },
    sendToPropertyInspector(data) {
        if (data?.type !== 'sounds') return;
        sounds = Array.isArray(data.sounds)
            ? data.sounds.filter(s => s && typeof s.id === 'string' && typeof s.name === 'string')
            : [];
        setStatus(data.connection, data.error);
        renderList();
        // While SYNK is not reachable, keep asking so the list fills in as soon as it opens.
        // (Once connected, the plugin pushes a fresh list by itself when the library changes.)
        clearTimeout(retryTimer);
        if (data.connection !== 'connected' || data.error) {
            retryTimer = setTimeout(requestSounds, 3000);
        }
    }
};
