// Feral GameMode: switches the CPU governor and raises game priority while a
// game runs. Sober asks for it through the GameMode portal, which only works
// if the host has gamemoded installed. Installing needs root, so it goes
// through pkexec: the desktop's own polkit dialog asks for the password —
// neither this app nor anything else here ever sees it.
const { execFile } = require('child_process');
const os = require('os');
const { cleanEnv } = require('./sober');

// Package manager -> install command (the package is "gamemode" everywhere).
const MANAGERS = [
    ['pacman', ['-S', '--needed', '--noconfirm', 'gamemode']],
    ['apt-get', ['install', '-y', 'gamemode']],
    ['dnf', ['install', '-y', 'gamemode']],
    ['zypper', ['--non-interactive', 'install', 'gamemode']],
];

const which = (cmd) =>
    new Promise((resolve) =>
        execFile('which', [cmd], { env: cleanEnv() }, (err, out) => resolve(err ? null : out.trim())),
    );

async function isInstalled() {
    return Boolean(await which('gamemoded'));
}

// Distros like Arch only let members of the "gamemode" group change the CPU
// governor without a password prompt (polkit rule shipped with the package).
function groupExists() {
    return new Promise((resolve) => execFile('getent', ['group', 'gamemode'], (err) => resolve(!err)));
}

function inGroup() {
    return new Promise((resolve) =>
        execFile('id', ['-nG'], (err, out) => resolve(!err && out.split(/\s+/).includes('gamemode'))),
    );
}

/** Installed and, where the distro uses it, the user is in the group. */
async function isReady() {
    if (!(await isInstalled())) return false;
    return !(await groupExists()) || (await inGroup());
}

async function installCommand() {
    if (!(await which('pkexec'))) return null;
    for (const [manager, args] of MANAGERS) {
        const bin = await which(manager);
        if (bin) return [bin, args];
    }
    return null;
}

/**
 * Installs gamemode with pkexec. Resolves true on success, false if the user
 * dismissed the password dialog; rejects on other failures.
 */
async function install() {
    const cmd = await installCommand();
    if (!cmd) throw new Error('Desteklenen bir paket yöneticisi veya pkexec bulunamadı.');
    const [bin, args] = cmd;
    // One polkit prompt for both steps. The username is passed as "$1", never
    // spliced into the script, so it can't be interpreted by the shell.
    const script =
        `${[bin, ...args].map((a) => `'${a}'`).join(' ')} && ` +
        `if getent group gamemode >/dev/null; then usermod -aG gamemode "$1"; fi`;
    const user = os.userInfo().username;
    return new Promise((resolve, reject) => {
        execFile('pkexec', ['/bin/sh', '-c', script, 'sh', user], { env: cleanEnv() }, (err, _out, stderr) => {
            if (!err) return resolve(true);
            // pkexec: 126 = dialog dismissed / not authorized, 127 = auth failed
            if (err.code === 126 || err.code === 127) return resolve(false);
            reject(new Error(stderr?.trim() || err.message));
        });
    });
}

module.exports = { isInstalled, isReady, inGroup, install, installCommand };
