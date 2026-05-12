const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  agent: {
    start: () => ipcRenderer.invoke('agent:start'),
    stop: () => ipcRenderer.invoke('agent:stop'),
    getStatus: () => ipcRenderer.invoke('agent:status'),
    onStatus: (cb) => ipcRenderer.on('agent:status', (_e, data) => cb(data)),
    onLog: (cb) => ipcRenderer.on('agent:log', (_e, line) => cb(line)),
  },
  config: {
    read: () => ipcRenderer.invoke('config:read'),
    write: (cfg) => ipcRenderer.invoke('config:write', cfg),
  },
});
