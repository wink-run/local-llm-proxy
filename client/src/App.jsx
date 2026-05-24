import React from 'react';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import { ThemeProvider } from './store/theme';
import { LangProvider } from './store/lang';
import Sidebar from './components/Sidebar';
import Profile    from './pages/Profile';
import TokenDashboard from './pages/TokenDashboard';
import Gateway    from './pages/Gateway';
import Providers  from './pages/Providers';
import Contribute from './pages/Contribute';
import Dashboard  from './pages/Dashboard';
import Network    from './pages/Network';
import Config     from './pages/Config';
import Debug      from './pages/Debug';
import UpdateNotification from './components/UpdateNotification';

function Layout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-500 dark:text-gray-400">
        加载中…
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {user && <Sidebar />}
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/"          element={user ? <TokenDashboard /> : <Navigate to="/config" replace />} />
          <Route path="/gateway"   element={user ? <Gateway />        : <Navigate to="/config" replace />} />
          <Route path="/providers" element={user ? <Providers />      : <Navigate to="/config" replace />} />
          <Route path="/contribute"element={user ? <Contribute />     : <Navigate to="/config" replace />} />
          <Route path="/dashboard" element={user ? <Dashboard />      : <Navigate to="/config" replace />} />
          <Route path="/profile"   element={user ? <Profile />        : <Navigate to="/config" replace />} />
          <Route path="/network"   element={<Network />} />
          <Route path="/config"    element={<Config />} />
          <Route path="/debug"     element={<Debug />} />
          <Route path="*"          element={<Navigate to={user ? '/' : '/config'} replace />} />
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
          <AuthProvider>
            <Layout />
          </AuthProvider>
        </LangProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}
