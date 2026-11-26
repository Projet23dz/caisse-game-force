// Pont minimal et sûr entre la page et l'application (aucun accès Node à la page).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cashproDesktop', {
  testServer: (p) => ipcRenderer.invoke('cashpro:test-server', typeof p === 'string' ? p : JSON.parse(JSON.stringify(p))),
  saveServer: (p) => ipcRenderer.invoke('cashpro:save-server', typeof p === 'string' ? p : JSON.parse(JSON.stringify(p))),
  setupInfo: () => ipcRenderer.invoke('cashpro:setup-info'),
  onStatus: (cb) => ipcRenderer.on('cashpro:status', (_e, text) => cb(String(text))),
  changeServer: () => ipcRenderer.invoke('cashpro:change-server'),
  version: () => ipcRenderer.invoke('cashpro:version'),
  checkUpdate: () => ipcRenderer.invoke('cashpro:check-update'),
  // « تذكّرني » : stockage chiffré par Windows (seulement pour la page du serveur configuré)
  secretAvailable: () => ipcRenderer.invoke('cashpro:secret-available'),
  getSecret: (key) => ipcRenderer.invoke('cashpro:secret-get', String(key)),
  setSecret: (key, value) => ipcRenderer.invoke('cashpro:secret-set', String(key), value ? String(value) : ''),
});
