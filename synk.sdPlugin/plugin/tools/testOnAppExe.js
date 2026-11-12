// Runs the end-to-end suite against the ncc bundle on plugin/app.exe (pkg Node 18.5),
// the same runtime the Rise Mode Controller launches. Run: npm run test:app (bundles first)
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd, args, env = {}) => {
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false, env: { ...process.env, ...env } });
    if (r.status !== 0) process.exit(r.status ?? 1);
};

run(process.execPath, ['--test', 'test/actions.e2e.test.js'], { SYNK_E2E_RUNTIME: 'app' });
