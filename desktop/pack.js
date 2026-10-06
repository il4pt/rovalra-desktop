// Wrapper around electron-builder. Forces a neutral locale: under tr_TR,
// case-folding turns "I" into dotless "ı", so makensis rejects its own
// "!addincludedir" directive and the Windows build fails.
const { spawnSync } = require('child_process');

const cli = require.resolve('electron-builder/cli.js');
const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
