// Hands roblox-player:/roblox:/roblox-studio: URLs to the native game client.
// Windows: the official Roblox installer registers these schemes, so the OS
// handles them. Linux: games run through the bundled Sober runtime (sober.js);
// Studio goes to Vinegar if present.
const { shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const sober = require('./sober');

const SCHEME = /^(roblox-player|roblox|roblox-studio):/i;

function isRobloxProtocol(url) {
    return SCHEME.test(url);
}

function isStudioUrl(url) {
    return /^roblox-studio:/i.test(url);
}

class ClientMissingError extends Error {
    constructor(kind) {
        super(kind === 'studio' ? 'Roblox Studio bulunamadı.' : 'Oyun bileşenleri kurulu değil.');
        this.name = 'ClientMissingError';
        this.kind = kind;
    }
}

function hasFlatpak(appId) {
    try {
        execFileSync('flatpak', ['info', appId], { stdio: 'ignore', env: sober.cleanEnv() });
        return true;
    } catch {
        return false;
    }
}

async function launchStudioLinux(url) {
    if (!hasFlatpak('org.vinegarhq.Vinegar')) throw new ClientMissingError('studio');
    const child = spawn('flatpak', ['run', 'org.vinegarhq.Vinegar', url], {
        env: sober.cleanEnv(),
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
}

/**
 * Launches the URL. On Linux games, resolves with the game's ChildProcess so
 * the caller can react when it exits; otherwise resolves with null.
 * Throws ClientMissingError when the runtime needs installing first.
 */
async function launchRobloxUrl(url, prefs = {}) {
    if (!isRobloxProtocol(url)) throw new Error(`Not a Roblox URL: ${url}`);
    console.log('[launcher]', url.slice(0, 120));

    if (process.platform !== 'linux') {
        // Windows/macOS: delegate to the registered Roblox protocol handler.
        await shell.openExternal(url);
        return null;
    }

    if (isStudioUrl(url)) {
        await launchStudioLinux(url);
        return null;
    }

    if (await sober.needsSetup(prefs)) throw new ClientMissingError('player');
    sober.applyRobloxSettings(prefs);
    return sober.launch(url, prefs);
}

module.exports = { launchRobloxUrl, isRobloxProtocol, ClientMissingError };
