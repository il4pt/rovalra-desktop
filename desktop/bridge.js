// Main-process side of the Chrome APIs Electron doesn't implement for
// extensions. RoValra's background worker reaches these through sw-shim.js
// (prepended to background.js) and sw-preload.js (the IPC channel).
const { app, Menu, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

// Electron resourceType -> Chrome declarativeNetRequest/webRequest type.
const TYPE_MAP = {
    mainFrame: 'main_frame',
    subFrame: 'sub_frame',
    stylesheet: 'stylesheet',
    script: 'script',
    image: 'image',
    font: 'font',
    object: 'object',
    xhr: 'xmlhttprequest',
    ping: 'ping',
    cspReport: 'csp_report',
    media: 'media',
    webSocket: 'websocket',
};
const chromeType = (t) => TYPE_MAP[t] || 'other';

// --- declarativeNetRequest ------------------------------------------------

const escapeRe = (s) => s.replace(/[.+?${}()|[\]\\]/g, '\\$&');

/** Compiles a DNR urlFilter (|| domain anchor, | anchors, * wildcard, ^ separator). */
function compileUrlFilter(filter, caseSensitive) {
    let src = filter;
    let prefix = '';
    let suffix = '';
    if (src.startsWith('||')) {
        prefix = '^[a-z][a-z0-9+.-]*://([^/?#]*\\.)?';
        src = src.slice(2);
    } else if (src.startsWith('|')) {
        prefix = '^';
        src = src.slice(1);
    }
    if (src.endsWith('|')) {
        suffix = '$';
        src = src.slice(0, -1);
    }
    const body = src
        .split('')
        .map((c) => (c === '*' ? '.*' : c === '^' ? '(?:[^a-zA-Z0-9_\\-.%]|$)' : escapeRe(c)))
        .join('');
    return new RegExp(prefix + body + suffix, caseSensitive ? '' : 'i');
}

function hostMatches(host, domains) {
    return domains.some((d) => host === d || host.endsWith('.' + d));
}

class DnrEngine {
    constructor(extDir, statePath) {
        this.statePath = statePath;
        this.staticRulesets = new Map(); // id -> rules[]
        this.enabled = new Set();
        this.dynamicRules = [];
        this.sessionRules = [];
        this.compiled = [];

        const metaPath = path.join(extDir, 'rovalra-desktop', 'dnr.json');
        let resources = [];
        try {
            resources = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch {}
        for (const r of resources) {
            try {
                this.staticRulesets.set(r.id, JSON.parse(fs.readFileSync(path.join(extDir, r.path), 'utf8')));
                if (r.enabled) this.enabled.add(r.id);
            } catch (err) {
                console.error(`[dnr] cannot load ruleset ${r.id}`, err);
            }
        }
        try {
            const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            this.enabled = new Set(saved.enabled.filter((id) => this.staticRulesets.has(id)));
            this.dynamicRules = saved.dynamicRules || [];
        } catch {}
        this.recompile();
    }

    save() {
        const data = { enabled: [...this.enabled], dynamicRules: this.dynamicRules };
        fs.writeFileSync(this.statePath, JSON.stringify(data));
    }

    recompile() {
        const all = [];
        for (const id of this.enabled) all.push(...(this.staticRulesets.get(id) || []));
        all.push(...this.dynamicRules, ...this.sessionRules);
        this.compiled = all
            .map((rule) => {
                const c = rule.condition || {};
                try {
                    return {
                        rule,
                        priority: rule.priority || 1,
                        url: c.regexFilter
                            ? new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i')
                            : c.urlFilter
                              ? compileUrlFilter(c.urlFilter, c.isUrlFilterCaseSensitive)
                              : null,
                    };
                } catch (err) {
                    console.error(`[dnr] bad rule ${rule.id}`, err);
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => a.priority - b.priority); // ascending: higher priority applied last, wins
    }

    match(details) {
        const type = chromeType(details.resourceType);
        let host = '';
        try {
            host = new URL(details.url).hostname;
        } catch {}
        return this.compiled.filter(({ rule, url }) => {
            const c = rule.condition || {};
            if (url && !url.test(details.url)) return false;
            if (c.resourceTypes) {
                if (!c.resourceTypes.includes(type)) return false;
            } else if (type === 'main_frame') {
                return false; // Chrome default: all types except main_frame
            }
            if (c.excludedResourceTypes?.includes(type)) return false;
            if (c.requestDomains && !hostMatches(host, c.requestDomains)) return false;
            if (c.excludedRequestDomains && hostMatches(host, c.excludedRequestDomains)) return false;
            if (c.requestMethods && !c.requestMethods.includes(details.method.toLowerCase())) return false;
            if (c.excludedRequestMethods?.includes(details.method.toLowerCase())) return false;
            return true;
        });
    }

    updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] } = {}) {
        for (const id of disableRulesetIds) this.enabled.delete(id);
        for (const id of enableRulesetIds) if (this.staticRulesets.has(id)) this.enabled.add(id);
        this.recompile();
        this.save();
    }

    static updateList(list, { removeRuleIds = [], addRules = [] } = {}) {
        const kept = list.filter((r) => !removeRuleIds.includes(r.id));
        const ids = new Set(kept.map((r) => r.id));
        for (const r of addRules) {
            if (ids.has(r.id)) throw new Error(`Rule with id ${r.id} already exists`);
            ids.add(r.id);
        }
        return [...kept, ...addRules];
    }

    updateDynamicRules(opts) {
        this.dynamicRules = DnrEngine.updateList(this.dynamicRules, opts);
        this.recompile();
        this.save();
    }

    updateSessionRules(opts) {
        this.sessionRules = DnrEngine.updateList(this.sessionRules, opts);
        this.recompile();
    }
}

function applyHeaderOps(headers, ops, isResponse) {
    for (const { header, operation, value } of ops) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === header.toLowerCase());
        if (operation === 'remove') {
            if (key) delete headers[key];
        } else if (operation === 'set') {
            if (key) delete headers[key];
            headers[header] = isResponse ? [value] : value;
        } else if (operation === 'append') {
            if (!key) headers[header] = isResponse ? [value] : value;
            else if (isResponse) headers[key] = [...[].concat(headers[key]), value];
            else headers[key] = `${headers[key]}; ${value}`;
        }
    }
}

// --- Bridge ---------------------------------------------------------------

class ExtensionBridge {
    constructor(ses, ext) {
        this.ses = ses;
        this.ext = ext;
        this.worker = null;
        this.keepAlive = null;
        this.menuItems = new Map();
        this.redirects = []; // (details) => redirect URL | null, consulted before DNR
        this.dnr = new DnrEngine(ext.path, path.join(app.getPath('userData'), 'dnr-state.json'));

        this.installNetworkHooks();
        this.watchWorkers();
        app.on('web-contents-created', (_e, wc) => {
            if (wc.session === ses) this.attachWebContents(wc);
        });
    }

    // Chrome wakes an idle worker for events; here we keep RoValra's alive
    // (startTask) and restart it if it ever stops, so nothing is missed.
    watchWorkers() {
        const sw = this.ses.serviceWorkers;
        sw.on('running-status-changed', ({ versionId, runningStatus }) => {
            const worker = sw.getWorkerFromVersionID(versionId);
            if (!worker || !worker.scope.startsWith(this.ext.url)) return;
            if (runningStatus === 'starting' || runningStatus === 'running') this.adopt(worker);
            if (runningStatus === 'stopped' && this.worker === worker) {
                this.worker = null;
                setTimeout(() => this.wake(), 500);
            }
        });
        // loadExtension() starts the worker before this bridge exists, so the
        // status event above has already fired; adopt it directly.
        let found = false;
        for (const [versionId, info] of Object.entries(sw.getAllRunning())) {
            if (!info.scope?.startsWith(this.ext.url)) continue;
            const worker = sw.getWorkerFromVersionID(Number(versionId));
            if (worker) {
                this.adopt(worker);
                found = true;
            }
        }
        if (!found) this.wake();
    }

    adopt(worker) {
        if (this.worker === worker) return;
        this.worker = worker;
        const h = (name, fn) => {
            worker.ipc.removeHandler?.(`rovalra:${name}`);
            worker.ipc.handle(`rovalra:${name}`, (_e, ...args) => fn(...args));
        };
        h('dnr.updateEnabledRulesets', (o) => this.dnr.updateEnabledRulesets(o));
        h('dnr.getEnabledRulesets', () => [...this.dnr.enabled]);
        h('dnr.updateDynamicRules', (o) => this.dnr.updateDynamicRules(o));
        h('dnr.getDynamicRules', () => this.dnr.dynamicRules);
        h('dnr.updateSessionRules', (o) => this.dnr.updateSessionRules(o));
        h('dnr.getSessionRules', () => this.dnr.sessionRules);
        h('menus.create', (props) => {
            this.menuItems.set(props.id, props);
        });
        h('menus.update', (id, props) => {
            if (this.menuItems.has(id)) this.menuItems.set(id, { ...this.menuItems.get(id), ...props });
        });
        h('menus.remove', (id) => this.menuItems.delete(id));
        h('menus.removeAll', () => this.menuItems.clear());
        try {
            this.keepAlive?.end();
        } catch {}
        try {
            this.keepAlive = worker.startTask();
        } catch {}
    }

    async wake() {
        try {
            this.adopt(await this.ses.serviceWorkers.startWorkerForScope(this.ext.url));
        } catch (err) {
            console.error('[bridge] cannot start RoValra worker', err);
        }
    }

    emit(name, ...args) {
        if (this.worker && !this.worker.isDestroyed()) {
            this.worker.send('rovalra:event', name, args);
        } else {
            this.wake().then(() => this.worker?.send('rovalra:event', name, args));
        }
    }

    installNetworkHooks() {
        const wr = this.ses.webRequest;
        const filter = { urls: ['<all_urls>'] };

        // Electron allows one listener per webRequest event, so other features
        // that need redirects register them here (addRedirect).
        wr.onBeforeRequest(filter, (details, cb) => {
            for (const redirect of this.redirects) {
                const target = redirect(details);
                if (target) return cb({ redirectURL: target });
            }
            const blocked = this.dnr.match(details).some(({ rule }) => rule.action?.type === 'block');
            cb({ cancel: blocked });
        });

        wr.onBeforeSendHeaders(filter, (details, cb) => {
            const headers = details.requestHeaders;
            for (const { rule } of this.dnr.match(details)) {
                if (rule.action?.type === 'modifyHeaders' && rule.action.requestHeaders) {
                    applyHeaderOps(headers, rule.action.requestHeaders, false);
                }
            }
            cb({ requestHeaders: headers });
        });

        wr.onHeadersReceived(filter, (details, cb) => {
            const matches = this.dnr
                .match(details)
                .filter(({ rule }) => rule.action?.type === 'modifyHeaders' && rule.action.responseHeaders);
            if (!matches.length) return cb({});
            const headers = { ...details.responseHeaders };
            for (const { rule } of matches) applyHeaderOps(headers, rule.action.responseHeaders, true);
            cb({ responseHeaders: headers });
        });

        wr.onBeforeRedirect({ urls: ['*://*.roblox.com/*'] }, (d) => {
            this.emit('webRequest.onBeforeRedirect', {
                requestId: String(d.id),
                url: d.url,
                redirectUrl: d.redirectURL,
                statusCode: d.statusCode,
                method: d.method,
                tabId: d.webContentsId ?? -1,
                frameId: d.resourceType === 'mainFrame' ? 0 : -1,
                parentFrameId: -1,
                type: chromeType(d.resourceType),
                fromCache: d.fromCache,
                ip: d.ip,
                timeStamp: d.timestamp,
            });
        });
    }

    addRedirect(fn) {
        this.redirects.push(fn);
    }

    attachWebContents(wc) {
        wc.on('did-start-navigation', (details) => {
            if (!details.isMainFrame || details.isSameDocument) return;
            this.emit('webNavigation.onBeforeNavigate', {
                tabId: wc.id,
                url: details.url,
                frameId: 0,
                parentFrameId: -1,
                processId: -1,
                frameType: 'outermost_frame',
                documentLifecycle: 'active',
                timeStamp: Date.now(),
            });
        });
        wc.on('context-menu', (_e, params) => this.showContextMenu(wc, params));
    }

    // Extension items (Chrome semantics) plus the basic browser actions a
    // desktop app needs, since Electron shows no context menu by default.
    showContextMenu(wc, params) {
        const template = [];
        const pageUrl = wc.getURL();
        const patternOk = (patterns, url) =>
            !patterns || patterns.some((p) => matchPattern(p, url));

        const contexts = new Set(['all', 'page']);
        if (params.linkURL) contexts.add('link');
        if (params.selectionText) contexts.add('selection');
        if (params.isEditable) contexts.add('editable');
        if (params.mediaType && params.mediaType !== 'none') contexts.add(params.mediaType);
        if (params.frameURL) contexts.add('frame');

        const extItems = [...this.menuItems.values()].filter((item) => {
            const want = item.contexts || ['page'];
            if (!want.some((c) => contexts.has(c))) return false;
            if (!patternOk(item.documentUrlPatterns, pageUrl)) return false;
            if (item.targetUrlPatterns && !patternOk(item.targetUrlPatterns, params.linkURL || params.srcURL)) return false;
            return item.visible !== false;
        });
        for (const item of extItems) {
            template.push({
                label: item.title.replace('%s', params.selectionText || ''),
                enabled: item.enabled !== false,
                click: () =>
                    this.emit(
                        'contextMenus.onClicked',
                        {
                            menuItemId: item.id,
                            parentMenuItemId: item.parentId,
                            linkUrl: params.linkURL || undefined,
                            srcUrl: params.srcURL || undefined,
                            pageUrl,
                            frameUrl: params.frameURL || undefined,
                            selectionText: params.selectionText || undefined,
                            editable: params.isEditable,
                            mediaType: params.mediaType !== 'none' ? params.mediaType : undefined,
                        },
                        { id: wc.id, url: pageUrl, active: true, windowId: 1, index: 0 },
                    ),
            });
        }
        if (template.length) template.push({ type: 'separator' });

        if (params.linkURL) {
            template.push({ label: 'Bağlantıyı kopyala', click: () => clipboard.writeText(params.linkURL) });
        }
        if (params.isEditable) {
            template.push(
                { role: 'cut', label: 'Kes' },
                { role: 'copy', label: 'Kopyala' },
                { role: 'paste', label: 'Yapıştır' },
                { role: 'selectAll', label: 'Tümünü seç' },
            );
        } else if (params.selectionText) {
            template.push({ role: 'copy', label: 'Kopyala' });
        }
        if (template.length && template[template.length - 1].type !== 'separator') {
            template.push({ type: 'separator' });
        }
        template.push(
            { label: 'Geri', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
            { label: 'Yenile', click: () => wc.reload() },
            { type: 'separator' },
            { label: 'İncele', click: () => wc.inspectElement(params.x, params.y) },
        );
        Menu.buildFromTemplate(template).popup();
    }
}

function matchPattern(pattern, url) {
    if (!url) return false;
    if (pattern === '<all_urls>') return /^(https?|wss?|file|ftp):/.test(url);
    const m = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
    if (!m) return false;
    const [, scheme, host, pathPart = '/*'] = m;
    const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const schemeRe = scheme === '*' ? 'https?' : esc(scheme);
    const hostRe = host === '*' ? '[^/]*' : host.startsWith('*.') ? `([^/]*\\.)?${esc(host.slice(2))}` : esc(host);
    const pathRe = pathPart.split('*').map(esc).join('.*');
    return new RegExp(`^${schemeRe}://${hostRe}(:\\d+)?${pathRe}$`).test(url);
}

module.exports = { ExtensionBridge, DnrEngine, compileUrlFilter, matchPattern };
