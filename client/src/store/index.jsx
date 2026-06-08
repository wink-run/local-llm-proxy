import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { getProfile, listKeys } from '../api/client';
import { getServerUrl } from '../config';

const AuthContext = createContext(null);

const POLL_INTERVAL = 30_000;

// Push the user's first active cloud key + backend URL into the local gateway
// so it can forward P2P model requests to the backend.
async function syncCloudKey() {
  if (!window.electronAPI?.localConfig?.setCloudConfig) return;
  try {
    const r = await listKeys();
    const keys = r.data?.keys || r.data || [];
    const active = (Array.isArray(keys) ? keys : []).find(k => k.is_active);
    if (active) {
      await window.electronAPI.localConfig.setCloudConfig({
        url:   getServerUrl(),
        token: active.key,
      });
    }
  } catch {}
}

// 启动/登录时静默在线同步一次：从服务器拉取「工具/应用」+「场景路由」配置并合并。
// applyConfigDoc 本地优先——只追加新增项，不覆盖用户已有的应用/路由。鉴权用登录 JWT。
async function syncRemoteConfig() {
  if (!window.electronAPI?.toolsConfig?.importUrl) return;
  const token = localStorage.getItem('token');
  if (!token) return;
  const base = getServerUrl().replace(/\/$/, '');
  for (const ep of ['/api/config/apps', '/api/config/scenes']) {
    try { await window.electronAPI.toolsConfig.importUrl(base + ep, token); } catch {}
  }
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
    if (!token) { setLoading(false); return; }
    getProfile()
      .then((r) => {
        setUser(r.data);
        startPolling();
        syncCloudKey();
        syncRemoteConfig();   // 每次程序启动自动在线同步一次配置
      })
      .catch(() => { localStorage.removeItem('token'); })
      .finally(() => setLoading(false));
    return () => stopPolling();
  }, []);

  function loginSuccess(token, userData) {
    localStorage.setItem('token', token);
    setUser(userData);
    startPolling();
    syncCloudKey();
    syncRemoteConfig();
  }

  function logout() {
    localStorage.removeItem('token');
    setUser(null);
    stopPolling();
    // Clear cloud config so gateway stops forwarding to backend
    if (window.electronAPI?.localConfig?.setCloudConfig) {
      window.electronAPI.localConfig.setCloudConfig({ url: null, token: null }).catch(() => {});
    }
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

export function useAuth() {
  return useContext(AuthContext);
}
