// Linux game runtime. Roblox's Windows client is blocked under Wine, so games
// run through Sober (VinegarHQ, Flathub), which this module installs, sets up
// and launches silently — the user only ever sees RoValra Desktop's own UI.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ID = 'org.vinegarhq.Sober';
const FLATHUB_REPO = 'https://dl.flathub.org/repo/flathub.flatpakrepo';
const APP_HOME = path.join(os.homedir(), '.var', 'app', APP_ID);
const CONFIG_PATH = path.join(APP_HOME, 'config', 'sober', 'config.json');
const DATA_DIR = path.join(APP_HOME, 'data', 'sober');
const STATE_PATH = path.join(DATA_DIR, 'state');
const PACKAGES_DIR = path.join(DATA_DIR, 'packages');
const USER_FLATPAK_DIR = path.join(os.homedir(), '.local', 'share', 'flatpak');
const APPROX_PACKAGE_MB = 150; // Roblox's Android build, for the progress estimate
const BOOTSTRAP_DONE = /installed Roblox using update service/i;
const BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;

// Documented options: https://vinegarhq.org/Sober/Configuration/
// Tuned for low-memory laptops with integrated GPUs.
const TUNED_CONFIG = {
    // Must stay true: Sober exiting is how we know the game closed. Without it
    // Sober drops to Roblox's own home screen after a game ends.
    close_on_leave: true,
    graphics_optimization_mode: 'performance',
    // Vulkan stays on: OpenGL caps FPS at 60 when launched from a browser
    // (vinegarhq/sober#1246) and Mesa's Vulkan driver is faster on Intel Xe.
    use_opengl: false,
    enable_gamemode: true,
    discord_rpc_enabled: false,
    server_location_indicator_enabled: false,
    touch_mode: 'off',
};

// Performance profiles. FastFlags are limited to Roblox's local-override
// allowlist (Sept 2025); anything else is ignored by the client, so these are
// all that can be tuned. qualityLevel is Roblox's own graphics slider (1-10).
const PROFILES = {
    performance: {
        label: 'Performans',
        graphics_optimization_mode: 'performance',
        qualityLevel: 2,
        fflags: {
            DFFlagTextureQualityOverrideEnabled: true,
            DFIntTextureQualityOverride: 1,
            DFIntCSGLevelOfDetailSwitchingDistance: 100,
            DFIntCSGLevelOfDetailSwitchingDistanceL12: 75,
            DFIntCSGLevelOfDetailSwitchingDistanceL23: 100,
            DFIntCSGLevelOfDetailSwitchingDistanceL34: 150,
            FIntFRMMaxGrassDistance: 0,
            FIntGrassMovementReducedMotionFactor: true,
            DFFlagDebugPauseVoxelizer: true,
        },
    },
    balanced: {
        label: 'Dengeli',
        graphics_optimization_mode: 'balanced',
        qualityLevel: 5,
        fflags: {
            DFFlagTextureQualityOverrideEnabled: true,
            DFIntTextureQualityOverride: 2,
            DFIntCSGLevelOfDetailSwitchingDistance: 400,
            DFIntCSGLevelOfDetailSwitchingDistanceL12: 200,
            DFIntCSGLevelOfDetailSwitchingDistanceL23: 350,
            DFIntCSGLevelOfDetailSwitchingDistanceL34: 500,
            FIntFRMMaxGrassDistance: 200,
            FIntGrassMovementReducedMotionFactor: true,
        },
    },
    quality: {
        label: 'Kalite',
        graphics_optimization_mode: 'quality',
        qualityLevel: 9,
        fflags: {
            DFFlagTextureQualityOverrideEnabled: true,
            DFIntTextureQualityOverride: 2, // 3 crashes (OOM) on shared-memory iGPUs
            FIntDebugForceMSAASamples: 2,
        },
    },
};

const MANGOHUD_ID = 'org.freedesktop.Platform.VulkanLayer.MangoHud';
const ROBLOX_SETTINGS = path.join(DATA_DIR, 'appData', 'GlobalBasicSettings_13.xml');

/**
 * Environment for host tools. Electron/Chromium and the AppImage runtime set
 * variables (LD_LIBRARY_PATH, APPDIR, CHROME_*, ...) that must not leak into
 * flatpak or the game — they can break library loading or change GL behaviour.
 */
function cleanEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(ELECTRON_|CHROME_|GOOGLE_|APPIMAGE|APPDIR|OWD$|ARGV0$)/.test(key)) delete env[key];
    }
    for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'PYTHONHOME', 'PYTHONPATH', 'GSETTINGS_SCHEMA_DIR', 'QT_PLUGIN_PATH']) {
        delete env[key];
    }
    return env;
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        let tail = '';
        const feed = (buf) => (tail = (tail + buf.toString()).slice(-2000));
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.once('error', reject);
        child.once('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} çıkış kodu ${code}\n${tail}`)),
        );
    });
}

function diskUsageMb(dir) {
    return new Promise((resolve) =>
        execFile('du', ['-sm', dir], (err, out) => resolve(err ? 0 : parseInt(out, 10) || 0)),
    );
}

function hasFlatpakBinary() {
    return new Promise((resolve) => execFile('flatpak', ['--version'], (err) => resolve(!err)));
}

function isInstalled() {
    return new Promise((resolve) =>
        execFile('flatpak', ['info', APP_ID], { env: cleanEnv() }, (err) => resolve(!err)),
    );
}

/** True once Sober has downloaded Roblox's package (its first-run step). */
function hasRobloxPackage() {
    try {
        return fs
            .readdirSync(PACKAGES_DIR)
            .some((arch) => fs.existsSync(path.join(PACKAGES_DIR, arch, 'com.roblox.client', 'base.apk')));
    } catch {
        return false;
    }
}

async function installFlatpak(onProgress) {
    if (!(await hasFlatpakBinary())) {
        throw new Error('Flatpak bulunamadı. Dağıtımınızın paket yöneticisiyle "flatpak" kurun.');
    }
    onProgress({ percent: null, text: 'Kaynaklar hazırlanıyor…' });
    await run('flatpak', ['remote-add', '--user', '--if-not-exists', 'flathub', FLATHUB_REPO]);

    // flatpak only prints progress to a TTY, so measure the installation
    // growing on disk. Its total depends on which runtimes already exist.
    const baseline = await diskUsageMb(USER_FLATPAK_DIR);
    onProgress({ percent: null, text: 'Oyun bileşenleri indiriliyor…' });
    const timer = setInterval(async () => {
        const mb = Math.max(0, (await diskUsageMb(USER_FLATPAK_DIR)) - baseline);
        onProgress({ percent: null, text: `Oyun bileşenleri indiriliyor… ${mb} MB` });
    }, 1500);
    try {
        await run('flatpak', ['install', '--user', '--noninteractive', '-y', 'flathub', APP_ID]);
    } finally {
        clearInterval(timer);
    }
}

/**
 * Sober's first launch opens its onboarding window to download Roblox. Run it
 * with no display instead: the download still happens, the window can't
 * appear, and we stop it as soon as the log reports the install finished.
 */
function bootstrapHeadless(onProgress) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'flatpak',
            [
                'run',
                '--nosocket=wayland',
                '--nosocket=fallback-x11',
                '--nosocket=x11',
                '--unset-env=DISPLAY',
                '--unset-env=WAYLAND_DISPLAY',
                APP_ID,
            ],
            { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let tail = '';
        let finished = false;
        const finish = (err) => {
            if (finished) return;
            finished = true;
            clearInterval(timer);
            clearTimeout(timeout);
            // The headless instance idles once the download is done; stop it.
            execFile('flatpak', ['kill', APP_ID], () => {
                if (child.exitCode === null) child.kill('SIGKILL');
                err ? reject(err) : resolve();
            });
        };
        const feed = (buf) => {
            const text = buf.toString().replace(/\x1b\[[0-9;]*m/g, '');
            tail = (tail + text).slice(-3000);
            if (BOOTSTRAP_DONE.test(text)) finish();
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.once('error', finish);
        child.once('close', (code) => {
            if (hasRobloxPackage()) finish();
            else finish(new Error(`Yapılandırma tamamlanamadı (çıkış kodu ${code}).\n${tail}`));
        });

        const timer = setInterval(async () => {
            const mb = await diskUsageMb(PACKAGES_DIR);
            const percent = Math.min(99, Math.round((mb / APPROX_PACKAGE_MB) * 100));
            onProgress({ percent, text: 'Otomatik yapılandırma yapılıyor…' });
        }, 1000);
        const timeout = setTimeout(
            () => finish(new Error('Yapılandırma zaman aşımına uğradı.')),
            BOOTSTRAP_TIMEOUT_MS,
        );
    });
}

// Sober's JSON files start with "//" comment lines; JSON.parse can't read them.
function readJsonc(file) {
    const text = fs.readFileSync(file, 'utf8');
    const header = text.match(/^(?:\s*\/\/.*\n)*/)[0];
    return { header, data: JSON.parse(text.slice(header.length)) };
}

function writeJsoncAtomic(file, header, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, header + JSON.stringify(data, null, 4) + '\n');
    fs.renameSync(tmp, file); // never leave half-written JSON: it stops Sober launching
}

/** Marks Sober's onboarding as seen so it never shows its welcome screen. */
function skipOnboarding() {
    try {
        const { header, data } = readJsonc(STATE_PATH);
        if (data.v2?.has_seen_onboarding === true) return;
        data.v2 = { ...data.v2, has_seen_onboarding: true };
        writeJsoncAtomic(STATE_PATH, header, data);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('[sober] cannot update state', err);
    }
}

/**
 * Writes TUNED_CONFIG into Sober's config. Keys the user changed later are
 * respected: tuning is applied once per version (stamp file outside Sober's
 * config), except close_on_leave, which our window restore depends on.
 */
function applyTunedConfig(stampDir, prefs = {}, version = 1) {
    const stamp = path.join(stampDir, 'sober-config-version');
    let applied = 0;
    try {
        applied = Number(fs.readFileSync(stamp, 'utf8')) || 0;
    } catch {}

    let header;
    let current;
    try {
        ({ header, data: current } = readJsonc(CONFIG_PATH));
    } catch (err) {
        // Missing: Sober writes its full default file on first run (bootstrap).
        // Corrupt: it crashes Sober (vinegarhq/sober#1519); deleting makes
        // Sober regenerate defaults, per its docs.
        if (err.code !== 'ENOENT') fs.rmSync(CONFIG_PATH, { force: true });
        return;
    }

    const next = applied >= version ? { ...current, close_on_leave: true } : { ...current, ...TUNED_CONFIG };
    // The profile picked in our menu is the source of truth for these keys.
    const profile = PROFILES[prefs.profile];
    if (profile) {
        next.graphics_optimization_mode = profile.graphics_optimization_mode;
        next.fflags = { ...profile.fflags };
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) writeJsoncAtomic(CONFIG_PATH, header, next);
    fs.mkdirSync(stampDir, { recursive: true });
    fs.writeFileSync(stamp, String(version));
}

/**
 * Roblox's own settings file: frame-rate cap and graphics level. Roblox
 * rewrites it on exit, so it's only edited while the game isn't running
 * (launch time). Missing until the first game session creates it.
 */
function applyRobloxSettings(prefs = {}) {
    let xml;
    try {
        xml = fs.readFileSync(ROBLOX_SETTINGS, 'utf8');
    } catch {
        return;
    }
    const set = (tag, name, value) => {
        const re = new RegExp(`(<${tag} name="${name}">)[^<]*(</${tag}>)`);
        xml = re.test(xml) ? xml.replace(re, `$1${value}$2`) : xml;
    };
    // Never write 0 or below: on Sober 0 means "0 FPS" and the window never appears.
    if (Number.isInteger(prefs.fpsCap) && prefs.fpsCap > 0) set('int', 'FramerateCap', prefs.fpsCap);
    const profile = PROFILES[prefs.profile];
    if (profile) {
        set('token', 'SavedQualityLevel', profile.qualityLevel);
        set('int', 'GraphicsQualityLevel', Math.round((profile.qualityLevel / 10) * 21));
    }
    const tmp = `${ROBLOX_SETTINGS}.tmp`;
    fs.writeFileSync(tmp, xml);
    fs.renameSync(tmp, ROBLOX_SETTINGS);
}

/** VulkanLayer branch matching Sober's runtime (e.g. GNOME 51 -> 26.08). */
function vulkanLayerBranch() {
    return new Promise((resolve) => {
        execFile('flatpak', ['info', '-m', APP_ID], { env: cleanEnv() }, (err, meta) => {
            const runtime = !err && /^runtime=(.+)$/m.exec(meta)?.[1];
            if (!runtime) return resolve(null);
            execFile('flatpak', ['info', '-m', runtime], { env: cleanEnv() }, (err2, rtMeta) => {
                const m = !err2 && /\[Extension org\.freedesktop\.Platform\.VulkanLayer\][^[]*?version\s*=\s*(\S+)/.exec(rtMeta);
                resolve(m ? m[1] : null);
            });
        });
    });
}

/** Installs the MangoHud Vulkan layer (the in-game FPS counter) if missing. */
async function fpsOverlayInstalled() {
    const branch = await vulkanLayerBranch();
    if (!branch) return false;
    return new Promise((resolve) =>
        execFile('flatpak', ['info', `${MANGOHUD_ID}//${branch}`], { env: cleanEnv() }, (err) => resolve(!err)),
    );
}

async function ensureFpsOverlay(onProgress = () => {}) {
    const branch = await vulkanLayerBranch();
    if (!branch) throw new Error('Sober çalışma ortamı sürümü okunamadı.');
    const ref = `${MANGOHUD_ID}//${branch}`;
    if (await fpsOverlayInstalled()) return;
    onProgress({ percent: null, text: 'FPS sayacı kuruluyor…' });
    await run('flatpak', ['install', '--user', '--noninteractive', '-y', 'flathub', ref]);
}

// The FPS counter's settings live in a file MangoHud watches (inotify), so
// changes from the overlay settings window apply in-game immediately. The
// path is the same inside Sober's sandbox (~/.var/app is bind-mounted).
const MANGOHUD_CONF = path.join(APP_HOME, 'config', 'MangoHud', 'MangoHud.conf');
const OVERLAY_POSITIONS = [
    'top-left', 'top-center', 'top-right',
    'middle-left', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right',
];
const DEFAULT_OVERLAY = {
    visible: true,
    position: 'top-left',
    offsetX: 0,
    offsetY: 0,
    fontSize: 18,
    detailed: false, // false: FPS + frame time; true: also CPU/GPU load and a frame-time graph
};

function writeOverlayConfig(overlay = {}) {
    const o = { ...DEFAULT_OVERLAY, ...overlay };
    const lines = [
        '# Written by RoValra Desktop; edit from Oyun → FPS sayacı ayarları',
        'fps',
        'frametime',
        o.detailed ? 'cpu_stats' : 'cpu_stats=0',
        o.detailed ? 'gpu_stats' : 'gpu_stats=0',
        ...(o.detailed ? ['frame_timing'] : []),
        `position=${OVERLAY_POSITIONS.includes(o.position) ? o.position : 'top-left'}`,
        `offset_x=${Math.max(0, Math.round(o.offsetX))}`,
        `offset_y=${Math.max(0, Math.round(o.offsetY))}`,
        `font_size=${Math.min(48, Math.max(10, Math.round(o.fontSize)))}`,
        'background_alpha=0.35',
        'round_corners=6',
        'toggle_hud=Shift_R+F12',
        ...(o.visible ? [] : ['no_display']),
    ];
    fs.mkdirSync(path.dirname(MANGOHUD_CONF), { recursive: true });
    // Rewrite in place (no rename): MangoHud's inotify watch is on this inode.
    fs.writeFileSync(MANGOHUD_CONF, lines.join('\n') + '\n');
}

function launchArgs(url, prefs = {}) {
    const env = [
        // Low-latency presentation: newest frame wins, no queued frames, no tearing.
        'MESA_VK_WSI_PRESENT_MODE=mailbox',
    ];
    if (prefs.fpsOverlay) {
        writeOverlayConfig(prefs.overlay);
        env.push('MANGOHUD=1', `MANGOHUD_CONFIGFILE=${MANGOHUD_CONF}`);
    }
    return ['run', ...env.map((e) => `--env=${e}`), APP_ID, url];
}

/** Whether ensureReady() would have work to do (i.e. show progress UI). */
async function needsSetup(prefs = {}) {
    if (!(await isInstalled()) || !hasRobloxPackage()) return true;
    return Boolean(prefs.fpsOverlay) && !(await fpsOverlayInstalled());
}

/**
 * Brings Sober to a launchable state with no Sober UI along the way:
 * install the flatpak, download Roblox headlessly, skip onboarding, tune.
 */
async function ensureReady(stampDir, prefs = {}, onProgress = () => {}) {
    if (!(await isInstalled())) await installFlatpak(onProgress);
    if (!hasRobloxPackage()) {
        onProgress({ percent: 0, text: 'Otomatik yapılandırma yapılıyor…' });
        await bootstrapHeadless(onProgress);
    }
    if (prefs.fpsOverlay) {
        await ensureFpsOverlay(onProgress).catch((err) => console.error('[sober] FPS overlay', err));
    }
    skipOnboarding();
    applyTunedConfig(stampDir, prefs);
    onProgress({ percent: 100, text: 'Hazır' });
}

/** Starts the game. Resolves with the child process once it has spawned. */
function launch(url, prefs = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('flatpak', launchArgs(url, prefs), {
            env: cleanEnv(),
            stdio: 'ignore',
            detached: true,
        });
        child.once('error', reject);
        child.once('spawn', () => resolve(child));
    });
}

module.exports = {
    APP_ID,
    PROFILES,
    isInstalled,
    needsSetup,
    ensureReady,
    ensureFpsOverlay,
    applyTunedConfig,
    applyRobloxSettings,
    writeOverlayConfig,
    DEFAULT_OVERLAY,
    OVERLAY_POSITIONS,
    launch,
    cleanEnv,
};
