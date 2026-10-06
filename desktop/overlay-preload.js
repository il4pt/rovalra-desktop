// Bridge for the FPS counter settings window (overlay.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rovalraOverlay', {
    get: () => ipcRenderer.invoke('overlay:get'),
    set: (overlay) => ipcRenderer.invoke('overlay:set', overlay),
    defaults: () => ipcRenderer.invoke('overlay:defaults'),
});
