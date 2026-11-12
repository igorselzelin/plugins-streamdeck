/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

const $local = false, $back = false, $dom = {
    main: $('.sdpi-wrapper'),
    step: $('#step')
};

$dom.step.on('change', () => $websocket.sendToPlugin({ type: 'setStep', step: Number($dom.step.value) }));

const $propEvent = {
    didReceiveSettings(data) {
        $dom.step.value = String(data?.settings?.step ?? 5);
    },
    sendToPropertyInspector(data) { }
};
