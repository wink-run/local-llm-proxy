import React, { useEffect, useState, useCallback } from 'react';
import { MemoryRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import { ThemeProvider } from './store/theme';
import { LangProvider, useLang } from './store/lang';
import { CurrencyProvider } from './store/currency';
import { isElectron } from './api/adapter';
import Sidebar from './components/Sidebar';
import TokenDashboard from './pages/TokenDashboard';
import Gateway    from './pages/Gateway';
import Providers  from './pages/Providers';
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

/** 个人页：仅登录用户可访问；未登录直接跳转登录页 */
function AccountRoute() {
  const { user } = useAuth();
  if (user) return <TokenDashboard />;
  return <Navigate to="/login" replace />;
}

/** 需登录的页面：未登录跳转登录页，登录后回到原路径 */
function RequireLogin({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user) return children;
  return <Navigate to="/login" replace state={{ from: location.pathname }} />;
}

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
      <main className="relative flex-1 overflow-y-auto min-w-0 bg-zinc-100 dark:bg-zinc-900">
        {authed && cliMode && sidebarCollapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            title={t('sidebar.expand')}
            aria-label={t('sidebar.expand')}
            className="fixed top-3 left-3 z-50 flex items-center justify-center w-9 h-9 rounded-lg border border-zinc-900/10 dark:border-white/10 bg-white/90 dark:bg-zinc-800/90 text-zinc-600 dark:text-zinc-300 shadow-sm hover:bg-white dark:hover:bg-zinc-800 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <Routes>
          <Route path="/"          element={<Navigate to={authed ? '/gateway' : '/login'} replace />} />
          <Route path="/account"   element={<AccountRoute />} />
          <Route path="/login"     element={<Login />} />
          <Route path="/gateway"   element={authed ? <Gateway />        : <Navigate to="/login" replace />} />
          <Route path="/providers" element={authed ? <Providers />      : <Navigate to="/login" replace />} />
          <Route path="/contribute" element={<RequireLogin><Contribute /></RequireLogin>} />
          <Route path="/circles/browse" element={<RequireLogin><CircleBrowse /></RequireLogin>} />
          <Route path="/circles"   element={<RequireLogin><Circles /></RequireLogin>} />
          <Route path="/circles/:circleId" element={<RequireLogin><CircleDetail /></RequireLogin>} />
          <Route path="/dashboard" element={authed ? <Dashboard />      : <Navigate to="/login" replace />} />
          <Route path="/network"   element={<Network />} />
          <Route path="/config"    element={<Config />} />
          <Route path="/debug"     element={<Debug />} />
          <Route path="*"          element={<Navigate to={authed ? '/gateway' : '/login'} replace />} />
        </Routes>
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
