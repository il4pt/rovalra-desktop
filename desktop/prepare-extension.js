// Copies the built extension (../dist) into ./extension and adapts it to
// Electron, whose extension runtime only implements a subset of Chrome APIs.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'dist');
const OUT = path.join(__dirname, 'extension');

// Implemented by bridge.js instead of Electron; listing them in the manifest
// only produces "unknown permission" warnings.
const BRIDGED_PERMISSIONS = ['webNavigation', 'contextMenus', 'webRequest', 'declarativeNetRequest'];

if (!fs.existsSync(path.join(SRC, 'manifest.json'))) {
    console.error(`Extension build not found at ${SRC}. Run "npm run build" in the repo root.`);
    process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });

const shim = fs.readFileSync(path.join(__dirname, 'sw-shim.js'), 'utf8');
const bgPath = path.join(OUT, 'background.js');
fs.writeFileSync(bgPath, shim + '\n' + fs.readFileSync(bgPath, 'utf8'));

const manifestPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const strip = (list) => (list || []).filter((p) => !BRIDGED_PERMISSIONS.includes(p));
manifest.permissions = strip(manifest.permissions);
manifest.optional_permissions = strip(manifest.optional_permissions);

// Static rulesets move to a sidecar file that bridge.js's DNR engine loads.
const dnrDir = path.join(OUT, 'rovalra-desktop');
fs.mkdirSync(dnrDir, { recursive: true });
fs.writeFileSync(
    path.join(dnrDir, 'dnr.json'),
    JSON.stringify(manifest.declarative_net_request?.rule_resources || []),
);
delete manifest.declarative_net_request;
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

console.log(`Prepared Electron-compatible extension in ${OUT}`);
