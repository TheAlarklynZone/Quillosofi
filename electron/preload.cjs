/*
 * Quillosofi Desktop — preload bridge
 * Exposes a safe API on window.quillosofi for the renderer (React app).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quillosofi', {
  isDesktop: true,
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  quit: () => ipcRenderer.send('app:quit'),

  // Native spellchecker bridge — lets the custom dictionary (localStorage,
  // renderer-side) suppress Chromium's built-in squiggly-underline spellcheck
  // for words the user has added/pinned.
  spellchecker: {
    addWord: (word) => ipcRenderer.invoke('spellchecker:add-word', word),
    removeWord: (word) => ipcRenderer.invoke('spellchecker:remove-word', word),
  },

  // Auto-updater bridge
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    setSettings: (partial) => ipcRenderer.invoke('updates:setSettings', partial),
    openReleasePage: () => ipcRenderer.invoke('updates:openReleasePage'),
    onState: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('updates:state', listener);
      return () => ipcRenderer.removeListener('updates:state', listener);
    },
    // v0.4.51 — main process pings this 3s after launch when a pending
    // install was staged last session. Renderer responds by showing the
    // 10s countdown modal and calling updates:install when it expires.
    onPendingInstall: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('updates:pending-install', listener);
      return () => ipcRenderer.removeListener('updates:pending-install', listener);
    },
  },
});
