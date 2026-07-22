/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

// $local whether to localize
// $back whether the caller decides when to show the panel
// $dom document element references - put anything non-dynamic here
const $local = false, $back = false, $dom = {
    main: $('.sdpi-wrapper')
};

const $propEvent = {
    didReceiveSettings(data) { },
    sendToPropertyInspector(data) { }
};