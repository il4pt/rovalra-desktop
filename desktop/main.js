// RoValra Desktop — a Roblox website client with the RoValra extension preloaded.
const {
    app,
    BrowserWindow,
    ipcMain,
    screen,
    protocol,
    net,
    Menu,
    session,
    shell,
    dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { launchRobloxUrl, isRobloxProtocol, ClientMissingError } = require('./launcher');
const sober = require('./sober');
const { ExtensionBridge } = require('./bridge');
const gamemode = require('./gamemode');

const HOME_URL = 'https://www.roblox.com/home';
const SETTINGS_URL = 'https://www.roblox.com/my/account?rovalra=info#!/info';
const PARTITION = 'persist:roblox';
const ROBLOX_HOST = /(^|\.)roblox\.com$/i;

// Roblox serves a degraded site to unknown browsers; present as plain Chrome.
// Drop every product token a stock Chrome UA wouldn't have (Electron/x, app name/x).
const CHROME_UA = app.userAgentFallback.replace(
    /\s(?!(?:Mozilla|AppleWebKit|Chrome|Safari)\/)[\w.-]+\/\S+/g,
    '',
);
app.userAgentFallback = CHROME_UA;

if (process.platform === 'linux') {
    // Chromium's Vulkan backend can't present on Wayland and falls back noisily;
    // GL + VA-API hardware video decode is the fast path on Mesa (Intel/AMD).
    app.commandLine.appendSwitch('disable-features', 'Vulkan');
    app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecodeLinuxGL,VaapiVideoDecoder');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
}

// Local background images. RoValra only accepts https:// image URLs, so a
// chosen file gets a URL on a reserved host (.invalid never resolves) that the
// bridge redirects to this app-only scheme, which serves the file. The
// extension stays unmodified. Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
    { scheme: 'rovalra-file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
const BG_URL_PREFIX = 'https://rovalra-desktop.invalid/bg/';
const BG_NAME = /^[a-f0-9]{16}\.(png|jpe?g|webp|gif|avif|svg)$/;
const bgDir = () => path.join(app.getPath('userData'), 'backgrounds');

if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

let mainWindow = null;
let bridge = null;

function extensionPath() {
    const packaged = path.join(process.resourcesPath, 'extension');
    if (app.isPackaged && fs.existsSync(packaged)) return packaged;
    return path.join(__dirname, 'extension');
}

function isRobloxUrl(url) {
    try {
        const { protocol, hostname } = new URL(url);
        return protocol === 'https:' && ROBLOX_HOST.test(hostname);
    } catch {
        return false;
    }
}

// Electron keeps the extension's service worker script cached in the session
// and won't pick up a changed background.js on its own, so an updated
// RoValra would keep running old code. Clear the cache when the file changes.
async function refreshWorkerCacheIfChanged(ses, dir) {
    const hash = require('crypto')
        .createHash('sha256')
        .update(fs.readFileSync(path.join(dir, 'background.js')))
        .digest('hex');
    const stamp = path.join(app.getPath('userData'), 'background-hash');
    let previous = '';
    try {
        previous = fs.readFileSync(stamp, 'utf8');
    } catch {}
    if (previous === hash) return;
    await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    fs.writeFileSync(stamp, hash);
    console.log('[RoValra] background.js changed; cleared service worker cache');
}

async function loadRoValra(ses) {
    const dir = extensionPath();
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        dialog.showErrorBox(
            'RoValra bulunamadı',
            `Eklenti derlenmemiş: ${dir}\n\nÖnce "npm run build:ext" çalıştırın.`,
        );
        return null;
    }
    try {
        await refreshWorkerCacheIfChanged(ses, dir);
        const ext = await ses.extensions.loadExtension(dir, {
            allowFileAccess: true,
        });
        console.log(`[RoValra] loaded ${ext.name} v${ext.version} (${ext.id})`);
        return ext;
    } catch (err) {
        console.error('[RoValra] failed to load extension:', err);
        return null;
    }
}

// ---- Game launching -------------------------------------------------------

let installing = null; // shared promise so duplicate launch requests don't double-install

// ---- Game preferences (Oyun menu) ----------------------------------------

const PREFS_PATH = () => path.join(app.getPath('userData'), 'game-settings.json');
const DEFAULT_PREFS = {
    profile: 'performance', // see sober.PROFILES
    // Roblox FramerateCap. On Sober's Android build 0 means "0 FPS" (the game
    // never draws a frame), so "unlimited" is 360, the highest in-game option.
    fpsCap: 360,
    fpsOverlay: true,
    gamemodePrompted: false, // asked once; never nag again
    overlay: {}, // FPS counter layout, merged over sober.DEFAULT_OVERLAY
};

function loadPrefs() {
    try {
        const prefs = { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_PATH(), 'utf8')) };
        if (!(prefs.fpsCap > 0)) prefs.fpsCap = DEFAULT_PREFS.fpsCap; // migrate old "0 = unlimited"
        return prefs;
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

// ---- Background theme ------------------------------------------------------

function openBackgroundEditor() {
    // RoValra's own editor (opacity, blur, overlay colour, position...).
    mainWindow?.webContents
        .executeJavaScript(`document.dispatchEvent(new CustomEvent('rovalra:openCustomThemeBackground'))`)
        .catch(() => {});
}

// Built-in themes: generated SVG gradients, nothing downloaded.
const svgGradient = (stops, glow) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>
<radialGradient id="r" cx="0.75" cy="0.2" r="0.6"><stop offset="0" stop-color="${glow}" stop-opacity="0.55"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1920" height="1080" fill="url(#g)"/><rect width="1920" height="1080" fill="url(#r)"/>
</svg>`;

const PRESET_THEMES = [
    ['Gece mavisi', ['#0b1026', '#14214d', '#1e3c72'], '#4f7cff'],
    ['Mor bulutsu', ['#140b26', '#3a1259', '#6a1b9a'], '#d05cff'],
    ['Gün batımı', ['#1a0b16', '#5b1a33', '#c2410c'], '#ffb347'],
    ['Orman', ['#06140d', '#0f2e1d', '#1f5130'], '#5ee38f'],
    ['Okyanus', ['#031622', '#073b4c', '#0e7490'], '#38e1ff'],
    ['Koyu grafit', ['#0d0f12', '#16191e', '#22262d'], '#5b6475'],
];

function saveBackgroundFile(data, ext) {
    const name = `${require('crypto').createHash('sha256').update(data).digest('hex').slice(0, 16)}.${ext}`;
    fs.mkdirSync(bgDir(), { recursive: true });
    for (const old of fs.readdirSync(bgDir())) if (old !== name) fs.rmSync(path.join(bgDir(), old), { force: true });
    fs.writeFileSync(path.join(bgDir(), name), data);
    bridge?.emit('desktop.background', { source: BG_URL_PREFIX + name });
}

function applyPresetTheme(stops, glow) {
    saveBackgroundFile(Buffer.from(svgGradient(stops, glow)), 'svg');
}

async function chooseBackground() {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Arka plan resmi seç',
        properties: ['openFile'],
        filters: [{ name: 'Resimler', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }],
    });
    if (canceled || !filePaths[0]) return;

    saveBackgroundFile(fs.readFileSync(filePaths[0]), path.extname(filePaths[0]).slice(1).toLowerCase());
    setTimeout(openBackgroundEditor, 600); // let the setting land, then offer fine-tuning
}

function clearBackground() {
    bridge?.emit('desktop.background', { source: null });
}

// ---- FPS counter settings window ------------------------------------------

let overlayWindow = null;

function openOverlaySettings() {
    if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow.focus();
    overlayWindow = new BrowserWindow({
        width: 560,
        height: 540,
        parent: mainWindow,
        title: 'FPS sayacı',
        autoHideMenuBar: true,
        resizable: false,
        backgroundColor: '#111216',
        webPreferences: {
            preload: path.join(__dirname, 'overlay-preload.js'),
            contextIsolation: true,
            sandbox: true,
        },
    });
    overlayWindow.setMenu(null);
    overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
}

const overlayState = () => ({
    overlay: { ...sober.DEFAULT_OVERLAY, ...loadPrefs().overlay },
    screen: screen.getPrimaryDisplay().size,
    loaded: loadPrefs().fpsOverlay,
});

ipcMain.handle('overlay:get', () => overlayState());
ipcMain.handle('overlay:defaults', () => ({ ...sober.DEFAULT_OVERLAY }));
ipcMain.handle('overlay:set', (_e, overlay) => {
    const prefs = savePrefs({ overlay });
    // MangoHud watches this file, so a running game picks it up immediately.
    if (process.platform === 'linux') sober.writeOverlayConfig(prefs.overlay);
    buildMenu(currentExt);
    return true;
});

function setOverlayVisible(visible) {
    const prefs = savePrefs({ overlay: { ...sober.DEFAULT_OVERLAY, ...loadPrefs().overlay, visible } });
    sober.writeOverlayConfig(prefs.overlay);
    buildMenu(currentExt);
}

function savePrefs(patch) {
    const next = { ...loadPrefs(), ...patch };
    fs.writeFileSync(PREFS_PATH(), JSON.stringify(next, null, 2));
    return next;
}
let game = null; // { child, returnUrl, unloaded }

function showError(title, detail) {
    const parent = BrowserWindow.getFocusedWindow() || mainWindow;
    return dialog.showMessageBox(parent, { type: 'error', title, message: title, detail });
}

async function installRuntimeWithProgress() {
    const win = new BrowserWindow({
        width: 440,
        height: 180,
        parent: mainWindow,
        modal: true,
        frame: false,
        resizable: false,
        show: false,
        backgroundColor: '#111216',
        webPreferences: { sandbox: true, contextIsolation: true },
    });
    await win.loadFile(path.join(__dirname, 'progress.html'));
    win.show();

    const update = ({ percent, text }) => {
        if (win.isDestroyed()) return;
        win.webContents
            .executeJavaScript(
                `(() => {
                    const p = ${JSON.stringify(percent)};
                    document.getElementById('text').textContent = ${JSON.stringify(text)};
                    document.getElementById('bar').classList.toggle('indeterminate', p === null);
                    document.getElementById('fill').style.width = p === null ? '' : p + '%';
                    document.getElementById('pct').textContent = p === null ? '' : p + '%';
                })()`,
            )
            .catch(() => {});
    };
    try {
        await sober.ensureReady(app.getPath('userData'), loadPrefs(), update);
    } finally {
        if (!win.isDestroyed()) win.destroy();
    }
}

// While the game runs, the Roblox page (~700 MB with RoValra) is swapped for
// about:blank so the game gets that memory. It comes back when the game exits
// or when the user restores the window.
const UNLOAD_DELAY_MS = 5000;

function restorePage() {
    if (!game?.unloaded || !mainWindow) return;
    game.unloaded = false;
    mainWindow.webContents.loadURL(game.returnUrl || HOME_URL);
}

function enterGameMode(child) {
    if (!mainWindow) return;
    game = { child, returnUrl: mainWindow.webContents.getURL(), unloaded: false };
    const startedAt = Date.now();

    // Wait a moment: a launch that fails instantly shouldn't blank the page.
    const timer = setTimeout(() => {
        if (game?.child !== child || child.exitCode !== null) return;
        mainWindow.minimize();
        mainWindow.webContents.loadURL('about:blank');
        game.unloaded = true;
    }, UNLOAD_DELAY_MS);

    child.once('exit', (code) => {
        clearTimeout(timer);
        const quick = Date.now() - startedAt < UNLOAD_DELAY_MS;
        restorePage();
        game = null;
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (quick && code) showError('Oyun başlatılamadı', `Oyun hemen kapandı (çıkış kodu ${code}).`);
    });
    child.unref();
}

// Roblox's page fires the same launch URL through more than one path (iframe
// and navigation); a launch already in flight absorbs the duplicates.
let launching = null;

function launchGame(url) {
    if (game && game.child.exitCode === null && !/^roblox-studio:/i.test(url)) {
        console.log('[launcher] game already running, ignoring launch');
        return;
    }
    if (launching) {
        console.log('[launcher] launch in progress, ignoring duplicate');
        return;
    }
    launching = doLaunch(url).finally(() => {
        // Keep the gate shut briefly so a late duplicate can't open a second
        // Sober (which would show Roblox's home screen instead of the game).
        setTimeout(() => (launching = null), 3000);
    });
}

// Offers to install GameMode once. Never blocks the launch: whatever the
// answer or outcome, the game starts afterwards.
async function offerGamemode() {
    if (process.platform !== 'linux' || loadPrefs().gamemodePrompted) return;
    if (await gamemode.isReady()) return;
    if (!(await gamemode.installCommand())) return;
    savePrefs({ gamemodePrompted: true });

    const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Oyun performansı',
        message: (await gamemode.isInstalled()) ? 'GameMode ayarı tamamlansın mı?' : 'GameMode kurulsun mu?',
        detail:
            'GameMode, oyun açıkken işlemciyi performans moduna alır ve oyuna öncelik verir. ' +
            'Kurulum için sistem şifrenizi soran bir pencere açılacak; şifre bu uygulamaya iletilmez.\n\n' +
            'Daha sonra RoValra → GameMode\'u kur menüsünden de kurabilirsiniz.',
        buttons: ['Kur', 'Şimdi değil'],
        defaultId: 0,
        cancelId: 1,
    });
    if (response === 0) await installGamemodeInteractive();
}

async function installGamemodeInteractive() {
    try {
        const ok = await gamemode.install();
        if (ok) {
            gamemodeReady = true;
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'GameMode',
                message: 'GameMode kuruldu',
                detail:
                    'Tam olarak devreye girmesi için oturumu kapatıp yeniden açın ' +
                    '(grup üyeliği ancak yeni oturumda geçerli olur).',
            });
        }
        buildMenu(currentExt);
    } catch (err) {
        showError('GameMode kurulamadı', String(err.message || err));
    }
}

async function doLaunch(url) {
    if (!/^roblox-studio:/i.test(url)) await offerGamemode();
    try {
        const prefs = loadPrefs();
        if (process.platform === 'linux') sober.applyTunedConfig(app.getPath('userData'), prefs);
        const child = await launchRobloxUrl(url, prefs);
        if (child) enterGameMode(child);
    } catch (err) {
        if (err instanceof ClientMissingError && err.kind === 'player') {
            try {
                installing ??= installRuntimeWithProgress().finally(() => (installing = null));
                await installing;
                const child = await launchRobloxUrl(url, loadPrefs());
                if (child) enterGameMode(child);
            } catch (installErr) {
                console.error('[launcher] setup failed', installErr);
                showError('Kurulum başarısız', String(installErr.message || installErr));
            }
            return;
        }
        console.error('[launcher]', err);
        showError('Başlatılamadı', String(err.message || err));
    }
}

function registerProtocolHandlers(ses) {
    // Roblox launches games via iframes/location changes to roblox-player: etc.
    // Intercepting the scheme on the session catches every variant.
    for (const scheme of ['roblox-player', 'roblox', 'roblox-studio']) {
        ses.protocol.handle(scheme, (request) => {
            launchGame(request.url);
            return new Response(null, { status: 204 });
        });
    }
}

function attachNavigationGuards(win) {
    const wc = win.webContents;

    wc.on('will-navigate', (event, url) => {
        if (isRobloxProtocol(url)) {
            event.preventDefault();
            launchGame(url);
        }
    });

    wc.setWindowOpenHandler(({ url }) => {
        if (isRobloxProtocol(url)) {
            launchGame(url);
            return { action: 'deny' };
        }
        if (isRobloxUrl(url) || url.startsWith('chrome-extension://')) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 1100,
                    height: 760,
                    autoHideMenuBar: true,
                    webPreferences: { partition: PARTITION },
                },
            };
        }
        // Discord, docs, etc. belong in the user's real browser.
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    wc.on('did-create-window', (child) => attachNavigationGuards(child));
}

// Linux only: these settings drive Sober. On Windows the official client has
// its own in-game settings (and its own FPS counter, Shift+F5).
function gameMenu(ext) {
    const prefs = loadPrefs();
    const pick = (patch) => () => {
        savePrefs(patch);
        buildMenu(ext); // refresh radio/checkbox state
    };
    const caps = [
        [60, '60 FPS'],
        [144, '144 FPS'],
        [240, '240 FPS'],
        [360, 'Sınırsız (360)'],
    ];
    return {
        label: 'Oyun',
        submenu: [
            { label: 'Performans profili', enabled: false },
            ...Object.entries(sober.PROFILES).map(([id, p]) => ({
                label: p.label,
                type: 'radio',
                checked: prefs.profile === id,
                click: pick({ profile: id }),
            })),
            { type: 'separator' },
            { label: 'FPS sınırı', enabled: false },
            ...caps.map(([value, label]) => ({
                label,
                type: 'radio',
                checked: prefs.fpsCap === value,
                click: pick({ fpsCap: value }),
            })),
            { type: 'separator' },
            { label: 'FPS sayacı', enabled: false },
            {
                label: 'Göster',
                type: 'checkbox',
                accelerator: 'CmdOrCtrl+Shift+F',
                checked: prefs.fpsOverlay && { ...sober.DEFAULT_OVERLAY, ...prefs.overlay }.visible,
                enabled: prefs.fpsOverlay,
                click: (item) => setOverlayVisible(item.checked), // live, no restart
            },
            {
                label: 'Konum ve görünüm…',
                click: () => openOverlaySettings(),
            },
            {
                label: 'Yükle (kapatmak performansı biraz artırır)',
                type: 'checkbox',
                checked: prefs.fpsOverlay,
                click: (item) => pick({ fpsOverlay: item.checked })(),
            },
            { type: 'separator' },
            {
                label: 'GameMode\'u kur…',
                id: 'install-gamemode',
                visible: !gamemodeReady,
                click: () => installGamemodeInteractive(),
            },
            { type: 'separator' },
            { label: 'Değişiklikler bir sonraki oyunda uygulanır', enabled: false },
        ],
    };
}

let currentExt = null;
let gamemodeReady = true; // refreshed async at startup; hides the menu item until known

function buildMenu(ext) {
    currentExt = ext;
    const nav = (fn) => () => {
        const wc = BrowserWindow.getFocusedWindow()?.webContents;
        if (wc) fn(wc);
    };
    const template = [
        {
            label: 'Roblox',
            submenu: [
                { label: 'Ana Sayfa', accelerator: 'CmdOrCtrl+H', click: nav((wc) => wc.loadURL(HOME_URL)) },
                { label: 'Oyunlar', click: nav((wc) => wc.loadURL('https://www.roblox.com/charts')) },
                { label: 'Avatar', click: nav((wc) => wc.loadURL('https://www.roblox.com/my/avatar')) },
                { label: 'Arkadaşlar', click: nav((wc) => wc.loadURL('https://www.roblox.com/users/friends')) },
                { type: 'separator' },
                { role: 'quit', label: 'Çıkış' },
            ],
        },
        {
            label: 'Gezinti',
            submenu: [
                { label: 'Geri', accelerator: 'Alt+Left', click: nav((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
                { label: 'İleri', accelerator: 'Alt+Right', click: nav((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
                { label: 'Yenile', accelerator: 'F5', click: nav((wc) => wc.reload()) },
                { label: 'Yenile', accelerator: 'CmdOrCtrl+R', visible: false, click: nav((wc) => wc.reload()) },
                { type: 'separator' },
                { role: 'zoomIn', label: 'Yakınlaştır' },
                { role: 'zoomOut', label: 'Uzaklaştır' },
                { role: 'resetZoom', label: 'Varsayılan boyut' },
                { role: 'togglefullscreen', label: 'Tam ekran' },
            ],
        },
        ...(process.platform === 'linux' ? [gameMenu(ext)] : []),
        {
            label: 'RoValra',
            submenu: [
                { label: 'RoValra Ayarları', accelerator: 'CmdOrCtrl+,', click: nav((wc) => wc.loadURL(SETTINGS_URL)) },
                {
                    label: 'Eklenti Paneli',
                    enabled: Boolean(ext),
                    click: () => openPopup(ext),
                },
                {
                    label: 'Arka plan',
                    enabled: Boolean(ext),
                    submenu: [
                        { label: 'Hazır temalar', enabled: false },
                        ...PRESET_THEMES.map(([label, stops, glow]) => ({
                            label,
                            click: () => applyPresetTheme(stops, glow),
                        })),
                        { type: 'separator' },
                        { label: 'Bilgisayardan resim seç…', click: () => chooseBackground() },
                        { label: 'Görünümü ayarla…', click: () => openBackgroundEditor() },
                        { label: 'Arka planı kaldır', click: () => clearBackground() },
                    ],
                },
                { type: 'separator' },
                { label: 'Geliştirici Araçları', accelerator: 'CmdOrCtrl+Shift+I', click: nav((wc) => wc.toggleDevTools()) },
                { label: 'rovalra.com', click: () => shell.openExternal('https://www.rovalra.com') },
                {
                    label: 'Hakkında',
                    click: () =>
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'Hakkında',
                            message: `RoValra Desktop ${app.getVersion()}`,
                            detail:
                                'RoValra eklentisi (GPL-3.0) — github.com/NotValra/RoValra\n' +
                                'Linux oyun çalışma ortamı: Sober (VinegarHQ) — sober.vinegarhq.org\n\n' +
                                'Bu uygulama Roblox Corporation ile bağlantılı değildir.',
                        }),
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openPopup(ext) {
    const popup = new BrowserWindow({
        width: 420,
        height: 620,
        parent: mainWindow,
        autoHideMenuBar: true,
        title: 'RoValra',
        webPreferences: { partition: PARTITION },
    });
    popup.loadURL(`${ext.url}public/Assets/popup/popup.html`);
    attachNavigationGuards(popup);
}

async function createWindow() {
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(CHROME_UA);
    registerProtocolHandlers(ses);
    // Must be registered before the extension's worker first starts.
    ses.registerPreloadScript({
        type: 'service-worker',
        id: 'rovalra-desktop-bridge',
        filePath: path.join(__dirname, 'sw-preload.js'),
    });
    const ext = await loadRoValra(ses);
    ses.protocol.handle('rovalra-file', (request) => {
        const name = path.basename(new URL(request.url).pathname);
        const file = path.join(bgDir(), name);
        if (!BG_NAME.test(name) || !fs.existsSync(file)) return new Response(null, { status: 404 });
        return net.fetch(require('url').pathToFileURL(file).href);
    });
    if (ext) {
        bridge = new ExtensionBridge(ses, ext);
        bridge.addRedirect((d) =>
            d.url.startsWith(BG_URL_PREFIX) ? `rovalra-file://bg/${path.basename(new URL(d.url).pathname)}` : null,
        );
    }
    buildMenu(ext);
    if (process.platform === 'linux') {
        gamemode.isReady().then((ready) => {
            gamemodeReady = ready;
            buildMenu(ext);
        });
    }

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'RoValra Desktop',
        icon: path.join(__dirname, 'icon.png'),
        backgroundColor: '#111216',
        show: false,
        webPreferences: {
            partition: PARTITION,
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
        },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('restore', restorePage);
    attachNavigationGuards(mainWindow);
    mainWindow.loadURL(HOME_URL);
}

app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
