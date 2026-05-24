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
  updater: {
    onAvailable: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:available', h);
      return () => ipcRenderer.removeListener('update:available', h);
    },
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:progress', h);
      return () => ipcRenderer.removeListener('update:progress', h);
    },
    onDownloaded: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:downloaded', h);
      return () => ipcRenderer.removeListener('update:downloaded', h);
    },
    onError: (cb) => {
      const h = () => cb();
      ipcRenderer.on('update:error', h);
      return () => ipcRenderer.removeListener('update:error', h);
    },
    install: () => ipcRenderer.invoke('update:install'),
  },
  gateway: {
    status:          () => ipcRenderer.invoke('gateway:status'),
    getLog:          () => ipcRenderer.invoke('gateway:getLog'),
    getDailyStats:   () => ipcRenderer.invoke('gateway:getDailyStats'),
    setStrategy:     (s) => ipcRenderer.invoke('gateway:setStrategy', s),
    testProvider:    (p) => ipcRenderer.invoke('gateway:testProvider', p),
  },
  localConfig: {
    get:               ()  => ipcRenderer.invoke('localConfig:get'),
    createSceneRoute:  (d) => ipcRenderer.invoke('localConfig:createSceneRoute', d),
    updateSceneRoute:  (d) => ipcRenderer.invoke('localConfig:updateSceneRoute', d),
    deleteSceneRoute:  (id) => ipcRenderer.invoke('localConfig:deleteSceneRoute', id),
    createKey:         (d) => ipcRenderer.invoke('localConfig:createKey', d),
    deleteKey:         (id) => ipcRenderer.invoke('localConfig:deleteKey', id),
    bindKey:           (d) => ipcRenderer.invoke('localConfig:bindKey', d),
    setCloudConfig:    (d) => ipcRenderer.invoke('localConfig:setCloudConfig', d),
  },
});
