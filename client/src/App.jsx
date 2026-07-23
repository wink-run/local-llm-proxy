import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { MemoryRouter, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import KeepAliveRoutes, { findRouteConfig } from './components/KeepAliveRoutes';
import { ThemeProvider } from './store/theme';
import { LangProvider, useLang } from './store/lang';
import { CurrencyProvider } from './store/currency';
import { isElectron } from './api/adapter';
import Sidebar from './components/Sidebar';
import TokenDashboard from './pages/TokenDashboard';
import Gateway    from './pages/Gateway';
import Providers  from './pages/Providers';
import Resources  from './pages/Resources';
import Contribute from './pages/Contribute';
import Dashboard  from './pages/Dashboard';
import Network    from './pages/Network';
import Config     from './pages/Config';
import Login      from './pages/Login';
import Debug      from './pages/Debug';
import Circles    from './pages/Circles';
import CircleBrowse from './pages/CircleBrowse';
import CircleDetail from './pages/CircleDetail';
import UpdateNotification from './components/UpdateNotification';
import { UpdaterProvider } from './store/updater';
import { useDeviceReporter } from './hooks/useDeviceReporter';

const SIDEBAR_COLLAPSED_KEY = 'tokenbank.sidebarCollapsed';

function readSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
}

/** 侧边栏主页面：切换时保持挂载以保留 state（如 Debug Agent 会话） */
const KEEP_ALIVE_ROUTE_CONFIGS = [
  { path: '/circles/browse', Component: CircleBrowse, requireLogin: true },
  { path: '/circles/:circleId', Component: CircleDetail, requireLogin: true },
  { path: '/circles', Component: Circles, end: true, requireLogin: true },
  { path: '/gateway', Component: Gateway, requireAuthed: true },
  { path: '/providers', Component: Providers, requireAuthed: true },
  { path: '/resources', Component: Resources, requireAuthed: true },
  { path: '/contribute', Component: Contribute, requireLogin: true },
  { path: '/dashboard', Component: Dashboard, requireAuthed: true },
  { path: '/network', Component: Network },
  { path: '/config', Component: Config },
  { path: '/debug', Component: Debug },
  { path: '/account', Component: TokenDashboard, requireUser: true },
];

function Layout() {
  const { user, guest, loading } = useAuth();
  const { t } = useLang();
  const authed = user || guest;   // 登录用户 或 游客模式：可进入「中心」
  const navigate = useNavigate();
  const cliMode = !isElectron();
  // CLI / Docker Web：侧边栏可收起，偏好写入 localStorage
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (cliMode ? readSidebarCollapsed() : false));
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      if (cliMode) {
        try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0'); } catch {}
      }
      return next;
    });
  }, [cliMode]);
  useDeviceReporter(user);

  const location = useLocation();
  const keepAliveMatch = useMemo(
    () => findRouteConfig(KEEP_ALIVE_ROUTE_CONFIGS, location.pathname),
    [location.pathname],
  );

  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.app?.onNavigate) return;
    return window.electronAPI.app.onNavigate((path) => navigate(path));
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="flex h-screen text-zinc-700 dark:text-zinc-200">
      {isElectron() && !authed && (
        <div className="electron-drag fixed inset-x-0 top-0 h-11 z-50" aria-hidden />
      )}
      {isElectron() && authed && (
        <div className="electron-drag fixed top-0 left-44 right-0 h-9 z-40" aria-hidden />
      )}
      {authed && !sidebarCollapsed && (
        <Sidebar onToggleCollapse={cliMode ? toggleSidebar : undefined} />
      )}
      <main className="relative flex-1 min-h-0 overflow-y-auto min-w-0 bg-zinc-100 dark:bg-zinc-900">
        {authed && cliMode && sidebarCollapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            title={t('sidebar.expand')}
            aria-label={t('sidebar.expand')}
            className="tb-press tb-material fixed top-3 left-3 z-50 flex items-center justify-center w-9 h-9 rounded-lg border border-zinc-900/10 dark:border-white/10 text-zinc-600 dark:text-zinc-300 shadow-sm hover:bg-white dark:hover:bg-zinc-800"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        {/* 缓存层始终挂载，切换菜单 / 登录页时仅 hidden，保留 Debug 等页面 state */}
        <KeepAliveRoutes configs={KEEP_ALIVE_ROUTE_CONFIGS} user={user} guest={guest} />

        {location.pathname === '/' && (
          <Navigate to={authed ? '/gateway' : '/login'} replace />
        )}
        {location.pathname === '/login' && (
          <div className="relative z-10 min-h-full bg-zinc-100 dark:bg-zinc-900">
            <Login />
          </div>
        )}
        {!keepAliveMatch && location.pathname !== '/login' && location.pathname !== '/' && (
          <Navigate to={authed ? '/gateway' : '/login'} replace />
        )}
      </main>
      <UpdateNotification />
    </div>
  );
}

export default function App() {
  return (
    <MemoryRouter>
      <ThemeProvider>
        <LangProvider>
          <CurrencyProvider>
            <AuthProvider>
              <UpdaterProvider>
                <Layout />
              </UpdaterProvider>
            </AuthProvider>
          </CurrencyProvider>
        </LangProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}
