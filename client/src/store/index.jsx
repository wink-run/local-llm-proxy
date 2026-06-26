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
  const [guest, setGuest] = useState(false);  // 游客模式：不登录浏览（记忆在 localStorage，直到主动登录）
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
    // 无 token 时默认游客模式，打开 app 无需登录
    const enterGuestMode = () => {
      localStorage.setItem('guest', '1');
      setGuest(true);
    };
    bootstrapServerUrl().then(() => {
      if (!token) { enterGuestMode(); setLoading(false); return; }
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
        .catch(() => {
          localStorage.removeItem('token');
          enterGuestMode();  // token 失效时也回退到游客模式
        })
        .finally(() => setLoading(false));
    }).catch(() => {
      // bootstrapServerUrl 失败（如 electronAPI 同步抛错）也必须解除 loading，
      // 否则 App 会永远卡在「加载中…」spinner、登录框无法出现。
      enterGuestMode();
      setLoading(false);
    });
    return () => stopPolling();
  }, []);

  function loginSuccess(token, userData) {
    localStorage.removeItem('guest');   // 登录后退出游客模式
    setGuest(false);
    localStorage.setItem('token', token);
    setUser(userData);
    startPolling();
    syncAgentCredentials(userData);
    syncCloudKey();
    syncCloudConfigUrl();
    syncRemoteConfig();
    syncUserBilling();
  }

  function enterGuest() {
    localStorage.setItem('guest', '1');
    setGuest(true);
  }

  function logout() {
    localStorage.removeItem('token');
    setUser(null);
    stopPolling();
    // 退出后恢复为未登录浏览态，可继续使用网关/设置等，无需跳转登录页
    localStorage.setItem('guest', '1');
    setGuest(true);
    getLocalConfig().setCloudConfig({ url: null, token: null }).catch(() => {});
  }

  function refreshUser() {
    return getProfile().then((r) => setUser(r.data));
  }

  return (
    <AuthContext.Provider value={{ user, loading, guest, enterGuest, loginSuccess, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

const defaultAuth = {
  user: null,
  loading: false,
  guest: false,
  enterGuest: () => {},
  loginSuccess: () => {},
  logout: () => {},
  refreshUser: () => Promise.resolve(),
};

export function useAuth() {
  return useContext(AuthContext) ?? defaultAuth;
}
