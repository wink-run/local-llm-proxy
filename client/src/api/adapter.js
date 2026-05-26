// client/src/api/adapter.js
// Abstracts window.electronAPI (Electron mode) vs HTTP admin API (CLI mode).

export function isElectron() {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

const ADMIN_BASE = 'http://localhost:11431';

// Low-level fetch helper for admin API
async function adminFetch(path, options = {}) {
  const res = await fetch(ADMIN_BASE + path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) throw new Error(`Admin API ${options.method || 'GET'} ${path} → ${res.status}`);
  return res.json();
}

// ── Electron adapter ──────────────────────────────────────────────────────────

const electronAdapter = {
  gateway: {
    status:        ()  => window.electronAPI.gateway.status(),
    getDailyStats: ()  => window.electronAPI.gateway.getDailyStats(),
    getLog:        ()  => window.electronAPI.gateway.getLog(),
    restart:       ()  => window.electronAPI.gateway.restart(),
    testProvider:  (p) => window.electronAPI.gateway.testProvider(p),
  },
  localConfig: {
    get:               ()  => window.electronAPI.localConfig.get(),
    createSceneRoute:  (d) => window.electronAPI.localConfig.createSceneRoute(d),
    updateSceneRoute:  (d) => window.electronAPI.localConfig.updateSceneRoute(d),
    deleteSceneRoute:  (id) => window.electronAPI.localConfig.deleteSceneRoute(id),
    createKey:         (d) => window.electronAPI.localConfig.createKey(d),
    deleteKey:         (id) => window.electronAPI.localConfig.deleteKey(id),
    bindKey:           (d) => window.electronAPI.localConfig.bindKey(d),
    setCloudConfig:    (d) => window.electronAPI.localConfig.setCloudConfig(d),
  },
  config: {
    read:  ()    => window.electronAPI.config.read(),
    write: (cfg) => window.electronAPI.config.write(cfg),
    scan:  ()    => window.electronAPI.config.scan(),
  },
};

// ── HTTP adapter ──────────────────────────────────────────────────────────────

const httpAdapter = {
  gateway: {
    status:        ()  => adminFetch('/api/gateway/status'),
    getDailyStats: ()  => adminFetch('/api/gateway/stats'),
    // admin-api returns { log: [...] }, but callers expect the array directly
    getLog:        ()  => adminFetch('/api/gateway/log').then(r => r.log || []),
    restart:       ()  => adminFetch('/api/gateway/restart', { method: 'POST' }),
    testProvider:  (p) => adminFetch('/api/gateway/test-provider', { method: 'POST', body: JSON.stringify(p) }),
  },
  localConfig: {
    get:               ()        => adminFetch('/api/local-config'),
    createSceneRoute:  (d)       => adminFetch('/api/local-config/routes', { method: 'POST', body: JSON.stringify(d) }),
    updateSceneRoute:  ({ id, ...d }) => adminFetch(`/api/local-config/routes/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
    deleteSceneRoute:  (id)      => adminFetch(`/api/local-config/routes/${id}`, { method: 'DELETE' }),
    createKey:         (d)       => adminFetch('/api/local-config/keys', { method: 'POST', body: JSON.stringify(d) }),
    deleteKey:         (id)      => adminFetch(`/api/local-config/keys/${id}`, { method: 'DELETE' }),
    bindKey:           ({ id, ...d }) => adminFetch(`/api/local-config/keys/${id}/bind`, { method: 'POST', body: JSON.stringify(d) }),
    setCloudConfig:    (d)       => adminFetch('/api/local-config/cloud-config', { method: 'POST', body: JSON.stringify(d) }),
  },
  config: {
    read:  ()    => adminFetch('/api/config'),
    write: (cfg) => adminFetch('/api/config', { method: 'POST', body: JSON.stringify(cfg) }),
    scan:  ()    => Promise.resolve([]), // no HTTP equivalent — server-side scan not available remotely
  },
};

// ── Exports ───────────────────────────────────────────────────────────────────

// Returns the right adapter at call time (safe even if called before React mounts)
export function getGateway()     { return isElectron() ? electronAdapter.gateway     : httpAdapter.gateway;     }
export function getLocalConfig() { return isElectron() ? electronAdapter.localConfig : httpAdapter.localConfig; }
export function getConfig()      { return isElectron() ? electronAdapter.config      : httpAdapter.config;      }
