/* RoValra Desktop: Chrome API layer for Electron.
 * Prepended to RoValra's background.js by prepare-extension.js. Electron lacks
 * permissions, contextMenus, webNavigation, webRequest and
 * declarativeNetRequest; these forward to the main process (bridge.js) over
 * the channel that sw-preload.js exposes as globalThis.__rovalraDesktop.
 */
(() => {
    const bridge = globalThis.__rovalraDesktop;
    if (!bridge) {
        console.error('[RoValra Desktop] bridge missing; extension APIs will be inert');
    }
    const call = (method, ...args) =>
        bridge ? bridge.invoke(method, ...args) : Promise.resolve(undefined);

    // Chrome APIs accept either a trailing callback or return a promise.
    const api = (fn) =>
        function (...args) {
            const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
            const p = Promise.resolve().then(() => fn(...args));
            if (!cb) return p;
            p.then(
                (v) => cb(v),
                (err) => {
                    console.error('[RoValra Desktop]', err);
                    cb(undefined);
                },
            );
            return undefined;
        };

    // Events arriving before a listener exists (e.g. right after the worker
    // starts) are held briefly and replayed, mimicking Chrome waking a worker.
    function makeEvent(name, matches = () => true) {
        const entries = [];
        const pending = [];
        const dispatch = (args) => {
            for (const { fn, filter } of entries.slice()) {
                if (matches(filter, ...args)) fn(...args);
            }
        };
        if (bridge) {
            bridge.on(name, (...args) => {
                if (entries.length) dispatch(args);
                else {
                    pending.push(args);
                    setTimeout(() => pending.splice(0, pending.indexOf(args) + 1), 3000);
                }
            });
        }
        return {
            addListener(fn, filter) {
                if (entries.some((e) => e.fn === fn)) return;
                entries.push({ fn, filter });
                for (const args of pending.splice(0)) dispatch(args);
            },
            removeListener(fn) {
                const i = entries.findIndex((e) => e.fn === fn);
                if (i >= 0) entries.splice(i, 1);
            },
            hasListener: (fn) => entries.some((e) => e.fn === fn),
            hasListeners: () => entries.length > 0,
        };
    }

    // chrome.* namespaces are accessor properties; plain assignment is ignored.
    function install(name, value) {
        try {
            Object.defineProperty(chrome, name, { value, writable: true, configurable: true, enumerable: true });
        } catch {
            // Non-configurable: patch members onto the existing object instead.
            Object.assign(chrome[name] || {}, value);
        }
        const probe = Object.keys(value)[0];
        if (chrome[name]?.[probe] !== value[probe]) {
            console.error(`[RoValra Desktop] could not install chrome.${name}`);
        }
    }

    // --- URL matching (match patterns and webNavigation UrlFilter) ---
    const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    function matchPattern(pattern, url) {
        if (pattern === '<all_urls>') return /^(https?|wss?|file|ftp):/.test(url);
        const m = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
        if (!m) return pattern.endsWith('*') ? url.startsWith(pattern.slice(0, -1)) : url === pattern;
        const [, scheme, host, pathPart = '/*'] = m;
        const schemeRe = scheme === '*' ? 'https?' : escape(scheme);
        const hostRe =
            host === '*' ? '[^/]*' : host.startsWith('*.') ? `([^/]*\\.)?${escape(host.slice(2))}` : escape(host);
        const pathRe = pathPart.split('*').map(escape).join('.*');
        return new RegExp(`^${schemeRe}://${hostRe}(:\\d+)?${pathRe}$`).test(url);
    }
    function urlFilterMatches(f, url) {
        let u;
        try {
            u = new URL(url);
        } catch {
            return false;
        }
        const host = u.hostname;
        // Chrome prepends an implicit dot, so '.roblox.com' matches roblox.com too.
        if (f.hostContains !== undefined && !('.' + host).includes(f.hostContains)) return false;
        if (f.hostEquals !== undefined && host !== f.hostEquals) return false;
        if (f.hostPrefix !== undefined && !host.startsWith(f.hostPrefix)) return false;
        if (f.hostSuffix !== undefined && !host.endsWith(f.hostSuffix)) return false;
        if (f.urlContains !== undefined && !url.includes(f.urlContains)) return false;
        if (f.urlPrefix !== undefined && !url.startsWith(f.urlPrefix)) return false;
        if (f.urlSuffix !== undefined && !url.endsWith(f.urlSuffix)) return false;
        if (f.urlMatches !== undefined && !new RegExp(f.urlMatches).test(url)) return false;
        if (f.schemes && !f.schemes.includes(u.protocol.slice(0, -1))) return false;
        return true;
    }

    // --- permissions: everything RoValra asks for is implemented below ---
    const permAdded = makeEvent('permissions.onAdded');
    const permRemoved = makeEvent('permissions.onRemoved');
    install('permissions', {
        contains: api(() => true),
        getAll: api(() => ({
            permissions: [...chrome.runtime.getManifest().permissions, 'webNavigation', 'contextMenus', 'webRequest'],
            origins: chrome.runtime.getManifest().host_permissions || [],
        })),
        request: api(() => true),
        remove: api(() => false),
        onAdded: permAdded,
        onRemoved: permRemoved,
    });

    // --- declarativeNetRequest ---
    install('declarativeNetRequest', {
        updateEnabledRulesets: api((opts) => call('dnr.updateEnabledRulesets', opts)),
        getEnabledRulesets: api(() => call('dnr.getEnabledRulesets')),
        updateDynamicRules: api((opts) => call('dnr.updateDynamicRules', opts)),
        getDynamicRules: api(() => call('dnr.getDynamicRules')),
        updateSessionRules: api((opts) => call('dnr.updateSessionRules', opts)),
        getSessionRules: api(() => call('dnr.getSessionRules')),
    });

    // --- webRequest (onBeforeRedirect is the only event RoValra uses) ---
    install('webRequest', {
        onBeforeRedirect: makeEvent('webRequest.onBeforeRedirect', (filter, details) => {
            if (!filter) return true;
            if (filter.urls && !filter.urls.some((p) => matchPattern(p, details.url))) return false;
            if (filter.types && !filter.types.includes(details.type)) return false;
            if (filter.tabId !== undefined && filter.tabId !== details.tabId) return false;
            return true;
        }),
    });

    // --- webNavigation ---
    install('webNavigation', {
        onBeforeNavigate: makeEvent('webNavigation.onBeforeNavigate', (filter, details) => {
            if (!filter?.url) return true;
            return filter.url.some((f) => urlFilterMatches(f, details.url));
        }),
    });

    // --- contextMenus ---
    install('contextMenus', {
        create(props, cb) {
            const { onclick, ...rest } = props;
            call('menus.create', rest).then(() => cb && cb());
            return props.id;
        },
        update: api((id, props) => call('menus.update', id, props)),
        remove: api((id) => call('menus.remove', id)),
        removeAll: api(() => call('menus.removeAll')),
        onClicked: makeEvent('contextMenus.onClicked'),
    });

    // --- runtime.onInstalled / onStartup ---
    // Electron never fires these for loadExtension(), but RoValra writes its
    // default settings in them; without them most features read `undefined`.
    // Fire them the way Chrome would: install/update when the version changes,
    // startup once per app launch (storage.session is cleared on restart).
    const captured = { onInstalled: [], onStartup: [] };
    for (const name of Object.keys(captured)) {
        const evt = chrome.runtime[name];
        const add = evt.addListener.bind(evt);
        try {
            evt.addListener = (fn) => {
                captured[name].push(fn);
                return add(fn);
            };
        } catch (err) {
            console.error(`[RoValra Desktop] cannot hook runtime.${name}`, err);
        }
    }
    setTimeout(async () => {
        const fire = (name, ...args) =>
            captured[name].forEach((fn) => {
                try {
                    fn(...args);
                } catch (err) {
                    console.error(`[RoValra Desktop] runtime.${name} listener failed`, err);
                }
            });
        const KEY = 'rovalraDesktopInstalledVersion';
        const version = chrome.runtime.getManifest().version;
        const { [KEY]: previous } = await chrome.storage.local.get(KEY);
        if (previous !== version) {
            await chrome.storage.local.set({ [KEY]: version });
            fire('onInstalled', previous ? { reason: 'update', previousVersion: previous } : { reason: 'install' });
        }
        const session = await chrome.storage.session.get(KEY).catch(() => ({}));
        if (!session[KEY]) {
            await chrome.storage.session.set({ [KEY]: true }).catch(() => {});
            fire('onStartup');
        }
    }, 0);

    // --- Desktop menu → RoValra's own background setting ---
    // Writes the same keys RoValra's background editor saves; its sitewide
    // storage listener then repaints every open page without a reload.
    if (bridge) {
        bridge.on('desktop.background', async ({ source }) => {
            if (!source) {
                await chrome.storage.local.set({ CustomThemeBackgroundEnabled: false });
                return;
            }
            const { customBackgroundImage: current = {} } = await chrome.storage.local.get('customBackgroundImage');
            await chrome.storage.local.set({
                customBackgroundImage: { ...current, source },
                CustomThemeBackgroundEnabled: true,
            });
        });
    }

    if (chrome.storage?.session && !chrome.storage.session.setAccessLevel) {
        chrome.storage.session.setAccessLevel = api(() => undefined);
    }
})();
