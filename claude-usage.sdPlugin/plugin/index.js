const { Plugins, Actions, log } = require('./utils/plugin');
const { renderRing, renderFlat } = require('./renderGauge');
const planUsage = require('./planUsage');

const plugin = new Plugins();

// TEMP DIAGNOSTIC (2026-08-20): logging raw protocol payloads to find out
// whether willAppear carries button coordinates and whether a device grid
// size is available anywhere — needed to design the "Clawd walks across all
// buttons" plugin. Safe to remove once captured in plugin/log/*.log.
plugin.deviceDidConnect = (data) => log.info('DIAG deviceDidConnect:', JSON.stringify(data));
plugin.deviceDidDisconnect = (data) => log.info('DIAG deviceDidDisconnect:', JSON.stringify(data));
plugin.applicationDidLaunch = (data) => log.info('DIAG applicationDidLaunch:', JSON.stringify(data));
plugin.systemDidWakeUp = (data) => log.info('DIAG systemDidWakeUp:', JSON.stringify(data));

const BACKGROUND = {
    idle: 0x1c1c1eff,
    session: 0x1c1c1eff,
    weekly: 0x1c1c1eff
};

// --- Pro/Max plan limits (session 5h + weekly) ---
// Both read from the same shared planUsage poll (one `claude -p "/usage"`
// call feeds both), refreshed every 60s since these quotas move slowly.
(function setupPlanUsageActions() {
    let pollTimer = null;
    let watchers = 0;
    const renderCallbacks = new Set();

    async function refreshAndRenderAll() {
        await planUsage.refresh(log);
        for (const cb of renderCallbacks) cb();
    }

    function ensurePolling() {
        watchers++;
        if (pollTimer) return;
        refreshAndRenderAll();
        pollTimer = setInterval(refreshAndRenderAll, planUsage.REFRESH_MS);
    }

    function stopPolling() {
        watchers = Math.max(0, watchers - 1);
        if (watchers === 0 && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // key: 'session' | 'weekly', background: gauge background color
    function createPlanAction(key, background) {
        const activeContexts = new Set();
        let showCountdown = false;
        let lastRenderKey = null;

        async function render() {
            if (activeContexts.size === 0) return;

            const snap = planUsage.getSnapshot();
            const entry = snap ? snap[key] : null;
            const renderKey = entry ? `${showCountdown}:${entry.pct}:${entry.resetsAt?.getTime()}` : 'loading';
            if (renderKey === lastRenderKey) return;
            lastRenderKey = renderKey;

            let imageB64;
            if (!entry) {
                imageB64 = await renderFlat(BACKGROUND.idle, '--');
            } else {
                const text = showCountdown
                    ? planUsage.formatCountdown(entry.resetsAt)
                    : Math.round(entry.pct * 100) + '%';
                imageB64 = await renderRing(entry.pct, background, text);
            }

            for (const ctx of activeContexts) {
                plugin.setImage(ctx, `data:image/jpeg;base64,${imageB64}`);
                plugin.setTitle(ctx, ''); // text is baked into the image, not the native title
            }
        }

        // Called after every shared /usage refresh so both buttons update together.
        renderCallbacks.add(() => render().catch(err => log.error('render error:', err.message)));

        return new Actions({
            default: {},

            _willAppear(data) {
                log.info('DIAG willAppear:', JSON.stringify(data)); // TEMP DIAGNOSTIC, see note above
                const { context } = data;
                activeContexts.add(context);
                lastRenderKey = null;
                ensurePolling();
                render().catch(err => log.error('render error:', err.message));
            },

            _willDisappear({ context }) {
                activeContexts.delete(context);
                stopPolling();
            },

            keyUp() {
                showCountdown = !showCountdown;
                lastRenderKey = null;
                render().catch(err => log.error('render error:', err.message));
            }
        });
    }

    plugin.action2 = createPlanAction('session', BACKGROUND.session);
    plugin.action3 = createPlanAction('weekly', BACKGROUND.weekly);
})();
