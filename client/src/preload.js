/**
 * Aion Electron Client — Preload Script
 *
 * Exposes a safe `window.aionAPI` bridge to the renderer process.
 * No Node.js APIs are exposed directly — all calls go through contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aionAPI', {
  connect: (opts) => ipcRenderer.invoke('connect', opts),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  getProxyUrl: () => ipcRenderer.invoke('get-proxy-url'),
  sendPing: () => ipcRenderer.invoke('send-ping'),

  onConnectionStatus: (callback) => {
    ipcRenderer.on('connection-status', (_, status) => callback(status));
  },
});
