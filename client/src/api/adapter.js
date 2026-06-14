// client/src/api/adapter.js
// Abstracts window.electronAPI (Electron mode) vs HTTP admin API (CLI mode).

export function isElectron() {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

// In CLI/browser mode the frontend is served by the same admin-api server,
// so use relative URLs (empty base) — requests go to whatever host:port the
// page was loaded from, which works correctly for both localhost and remote VMs.
// Override with VITE_ADMIN_BASE env var at build time for custom setups.
const ADMIN_BASE = import.meta.env?.VITE_ADMIN_BASE ?? '';

// Low-level fetch helper for admin API
async function adminFetch(path, options = {}) {
  const method = options.method || 'GET';
  const hasBody = !!options.body;
  const headers = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };
  let res;
  try {
    res = await fetch(ADMIN_BASE + path, { ...options, method, headers });
  } catch (err) {
    throw new Error(`Admin API ${method} ${path}: network error — ${err.message}`);
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j?.error || JSON.stringify(j); } catch {}
    throw new Error(`Admin API ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

// ── Electron adapter ──────────────────────────────────────────────────────────

const electronAdapter = {
  gateway: {
    status:        ()  => window.electronAPI.gateway.status(),
    getDailyStats: (days) => window.electronAPI.localStats.query(days || 1),
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
    importKeys: () => window.electronAPI.config.importKeys(),
  },
  oauth: {
    start:        (provider, opts) => window.electronAPI.oauth.start(provider, opts),
    exchange:     (sessionId, code) => window.electronAPI.oauth.exchange(sessionId, code),
    poll:         (sessionId) => window.electronAPI.oauth.poll(sessionId),
    openExternal: (url) => window.electronAPI.oauth.openExternal(url),
  },
};

// ── HTTP adapter ──────────────────────────────────────────────────────────────

const httpAdapter = {
  gateway: {
    status:        ()  => adminFetch('/api/gateway/status'),
    getDailyStats: (days) => adminFetch('/api/local-stats?days=' + (days || 1)),
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
    importKeys: () => Promise.resolve([]), // 本机扫描仅桌面端，HTTP 模式无等价
  },
  oauth: {
    // OAuth 订阅登录依赖桌面端本地流程，HTTP/远程模式不支持
    start:        () => Promise.reject(new Error('OAuth 登录仅桌面客户端支持')),
    exchange:     () => Promise.reject(new Error('OAuth 登录仅桌面客户端支持')),
    poll:         () => Promise.reject(new Error('OAuth 登录仅桌面客户端支持')),
    openExternal: (url) => { try { window.open(url, '_blank'); } catch {} return Promise.resolve({ ok: true }); },
  },
};

// ── Exports ───────────────────────────────────────────────────────────────────

// Returns the right adapter at call time (safe even if called before React mounts).
// Falls back to httpAdapter if the specific sub-namespace is missing from the preload.
export function getGateway()     { return (isElectron() && window.electronAPI.gateway)     ? electronAdapter.gateway     : httpAdapter.gateway;     }
export function getLocalConfig() { return (isElectron() && window.electronAPI.localConfig) ? electronAdapter.localConfig : httpAdapter.localConfig; }
export function getConfig()      { return (isElectron() && window.electronAPI.config)      ? electronAdapter.config      : httpAdapter.config;      }
export function getOauth()       { return (isElectron() && window.electronAPI.oauth)       ? electronAdapter.oauth       : httpAdapter.oauth;       }
