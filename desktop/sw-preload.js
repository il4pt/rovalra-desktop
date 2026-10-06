// Service-worker preload: gives RoValra's background worker a channel to the
// Electron main process, where the Chrome APIs Electron lacks are implemented
// (see bridge.js). The API shim prepended to background.js uses it.
const { contextBridge, ipcRenderer } = require('electron');

// The preload realm has no `self`; read the worker's location defensively.
// (Handlers live only on RoValra's worker in main, so other workers that get
// this object can't reach anything anyway.)
let scopeProtocol = 'chrome-extension:';
try {
    scopeProtocol = globalThis.location?.protocol ?? scopeProtocol;
} catch {}

if (scopeProtocol === 'chrome-extension:') {
    const listeners = new Map(); // event name -> Set<fn>

    ipcRenderer.on('rovalra:event', (_event, name, args) => {
        for (const fn of listeners.get(name) || []) {
            try {
                fn(...args);
            } catch (err) {
                console.error(`[RoValra Desktop] ${name} listener failed`, err);
            }
        }
    });

    // The main process registers its handlers when it sees this worker start,
    // which can race the worker's first calls; retry briefly until it's ready.
    async function invoke(method, ...args) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await ipcRenderer.invoke(`rovalra:${method}`, ...args);
            } catch (err) {
                if (attempt >= 50 || !/No handler registered/i.test(String(err))) throw err;
                await new Promise((r) => setTimeout(r, 100));
            }
        }
    }

    contextBridge.exposeInMainWorld('__rovalraDesktop', {
        invoke,
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
    });
}
