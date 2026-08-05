'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayAPI', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('tray-popover:getState'),
  action: (name, payload) => ipcRenderer.invoke('tray-popover:action', { name, ...(payload || {}) }),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('tray-popover:state', handler);
    return () => ipcRenderer.removeListener('tray-popover:state', handler);
  },
});
