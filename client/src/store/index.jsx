import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { getProfile, listKeys } from '../api/client';
import { loadUserAccounts } from '../api/userAccounts';
import { getLocalConfig, getConfig } from '../api/adapter';
import { getServerUrl, normalizeServerBase, getSyncServerBase, syncCloudConfigUrl, bootstrapServerUrl } from '../config';

const AuthContext = createContext(null);

const POLL_INTERVAL = 30_000;

// Docker / CLI：登录后将 worker_key 写入 config.json，供贡献 Agent 注册
async function syncAgentCredentials(userData) {
  if (window.electronAPI?.config?.write) return;
  const base = normalizeServerBase(getServerUrl());
  const wk = userData?.worker_key;
  if (!base || !wk) return;
  try {
    const current = (await getConfig().read().catch(() => null)) || {};
    const wsUrl = base.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws')) + '/ws/worker';
    await getConfig().write({ ...current, server_url: wsUrl, worker_key: wk });
  } catch {}
}

// Push the user's first active cloud key + backend URL into the local gateway
// so it can forward P2P model requests to the backend.
async function syncCloudKey() {
  try {
    const r = await listKeys();
    const keys = r.data?.keys || r.data || [];
    const active = (Array.isArray(keys) ? keys : []).find(k => k.is_active);
    if (active) {
      await getLocalConfig().setCloudConfig({
        url:   normalizeServerBase(getServerUrl()),
        token: active.key,
      });
    }
  } catch {}
}

// 启动/登录时静默在线同步一次：从服务器拉取「工具/应用」+「场景路由」配置并合并。
async function syncRemoteConfig() {
  if (!window.electronAPI?.toolsConfig?.importUrl) return;
  const token = localStorage.getItem('token');
  if (!token) return;
  const base = await getSyncServerBase();
  if (!base) return;
  for (const ep of ['/api/config/apps', '/api/config/scenes']) {
    try { await window.electronAPI.toolsConfig.importUrl(base + ep, token); } catch {}
  }
}

// 从云端拉取个人页订阅 / 按量 provider / 刊例价覆盖（跨终端）
async function syncUserBilling() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try { await loadUserAccounts(); } catch {}
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  function startPolling() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      getProfile().then((r) => setUser(r.data)).catch(() => {});
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    const token = localStorage.getItem('token');
    bootstrapServerUrl().then(() => {
      if (!token) { setLoading(false); return; }
      getProfile()
        .then((r) => {
          setUser(r.data);
          startPolling();
          syncAgentCredentials(r.data);
          syncCloudKey();
          syncCloudConfigUrl();
          syncRemoteConfig();
          syncUserBilling();
        })
        .catch(() => { localStorage.removeItem('token'); })
        .finally(() => setLoading(false));
    });
    return () => stopPolling();
  }, []);

  function loginSuccess(token, userData) {
    localStorage.setItem('token', token);
    setUser(userData);
    startPolling();
    syncAgentCredentials(userData);
    syncCloudKey();
    syncCloudConfigUrl();
    syncRemoteConfig();
    syncUserBilling();
  }

  function logout() {
    localStorage.removeItem('token');
    setUser(null);
    stopPolling();
    getLocalConfig().setCloudConfig({ url: null, token: null }).catch(() => {});
  }

  function refreshUser() {
    return getProfile().then((r) => setUser(r.data));
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginSuccess, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

const defaultAuth = {
  user: null,
  loading: false,
  loginSuccess: () => {},
  logout: () => {},
  refreshUser: () => Promise.resolve(),
};

export function useAuth() {
  return useContext(AuthContext) ?? defaultAuth;
}
