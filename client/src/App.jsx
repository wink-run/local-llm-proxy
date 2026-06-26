import React, { useEffect } from 'react';
import { MemoryRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import { ThemeProvider } from './store/theme';
import { LangProvider, useLang } from './store/lang';
import { CurrencyProvider } from './store/currency';
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
import UpdateNotification from './components/UpdateNotification';
import { useDeviceReporter } from './hooks/useDeviceReporter';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

/** 个人页：仅登录用户可访问；未登录直接跳转登录页 */
function AccountRoute() {
  const { user } = useAuth();
  if (user) return <TokenDashboard />;
  return <Navigate to="/login" replace />;
}

function Layout() {
  const { user, guest, loading } = useAuth();
  const { t } = useLang();
  const authed = user || guest;   // 登录用户 或 游客模式：可进入「中心」
  const navigate = useNavigate();
  useDeviceReporter(user);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.app?.onNavigate) return;
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
      {isElectron && !authed && (
        <div className="electron-drag fixed inset-x-0 top-0 h-11 z-50" aria-hidden />
      )}
      {isElectron && authed && (
        <div className="electron-drag fixed top-0 left-44 right-0 h-9 z-40" aria-hidden />
      )}
      {authed && <Sidebar />}
      <main className="flex-1 overflow-y-auto min-w-0 bg-zinc-100 dark:bg-zinc-900">
        <Routes>
          <Route path="/"          element={<Navigate to={authed ? '/gateway' : '/login'} replace />} />
          <Route path="/account"   element={<AccountRoute />} />
          <Route path="/login"     element={<Login />} />
          <Route path="/gateway"   element={authed ? <Gateway />        : <Navigate to="/login" replace />} />
          <Route path="/providers" element={authed ? <Providers />      : <Navigate to="/login" replace />} />
          <Route path="/contribute"element={user   ? <Contribute />     : <Navigate to="/login" replace />} />
          <Route path="/circles"   element={authed ? <Circles />        : <Navigate to="/login" replace />} />
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
              <Layout />
            </AuthProvider>
          </CurrencyProvider>
        </LangProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}
