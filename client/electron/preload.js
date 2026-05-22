const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  agent: {
    start: () => ipcRenderer.invoke('agent:start'),
    stop: () => ipcRenderer.invoke('agent:stop'),
    getStatus: () => ipcRenderer.invoke('agent:status'),
    onStatus: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:status', handler);
      return () => ipcRenderer.removeListener('agent:status', handler);
    },
    onLog: (cb) => {
      const handler = (_e, line) => cb(line);
      ipcRenderer.on('agent:log', handler);
      return () => ipcRenderer.removeListener('agent:log', handler);
    },
  },
  gateway: {
    start: () => ipcRenderer.invoke('gateway:start'),
    stop: () => ipcRenderer.invoke('gateway:stop'),
    getStatus: () => ipcRenderer.invoke('gateway:status'),
    onStatus: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('gateway:status', handler);
      return () => ipcRenderer.removeListener('gateway:status', handler);
    },
    onLog: (cb) => {
      const handler = (_e, line) => cb(line);
      ipcRenderer.on('gateway:log', handler);
      return () => ipcRenderer.removeListener('gateway:log', handler);
    },
  },
  config: {
    read:  () => ipcRenderer.invoke('config:read'),
    write: (cfg) => ipcRenderer.invoke('config:write', cfg),
    scan:  () => ipcRenderer.invoke('config:scan'),
  },
  claude: {
    configure: (baseUrl, apiKey, models) => ipcRenderer.invoke('claude:configure', { baseUrl, apiKey, models }),
    status: () => ipcRenderer.invoke('claude:status'),
  },
  llm: {
    fetch: (url, options) => ipcRenderer.invoke('llm:fetch', { url, ...options }),
    stream: ({ url, method, headers, body }, onChunk, onDone, onError) => {
      const reqId = Math.random().toString(36).slice(2);
      const onChunkH = (_e, d) => { if (d.reqId === reqId) onChunk(d.data); };
      const onDoneH  = (_e, d) => { if (d.reqId === reqId) { cleanup(); onDone(); } };
      const onErrorH = (_e, d) => { if (d.reqId === reqId) { cleanup(); onError(d.error); } };
      function cleanup() {
        ipcRenderer.removeListener('llm:stream-chunk', onChunkH);
        ipcRenderer.removeListener('llm:stream-done',  onDoneH);
        ipcRenderer.removeListener('llm:stream-error', onErrorH);
      }
      ipcRenderer.on('llm:stream-chunk', onChunkH);
      ipcRenderer.on('llm:stream-done',  onDoneH);
      ipcRenderer.on('llm:stream-error', onErrorH);
      ipcRenderer.send('llm:stream', { reqId, url, method, headers, body });
      return cleanup;
    },
  },
});
