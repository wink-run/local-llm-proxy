import React from 'react';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import { ThemeProvider } from './store/theme';
import { LangProvider } from './store/lang';
import Sidebar from './components/Sidebar';
import Profile from './pages/Profile';
import Agent from './pages/Agent';
import Network from './pages/Network';
import Config from './pages/Config';
import Debug from './pages/Debug';
import Onboarding from './pages/Onboarding';
import Apps from './pages/Apps';
import Contribute from './pages/Contribute';
import Dashboard from './pages/Dashboard';
import Quickstart from './pages/Quickstart';
import Gateway from './pages/Gateway';
import Sources from './pages/Sources';

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
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/gateway" replace />} />
          <Route path="/gateway" element={<Gateway />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/contribute" element={<Contribute />} />
          {/* 老页面保留路由（手动 URL 仍可访问） */}
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/quickstart" element={<Quickstart />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/apps" element={<Apps />} />
          <Route path="/profile" element={user ? <Profile /> : <Navigate to="/config" replace />} />
          <Route path="/agent" element={user ? <Agent /> : <Navigate to="/config" replace />} />
          <Route path="/network" element={<Network />} />
          <Route path="/config" element={<Config />} />
          <Route path="/debug" element={<Debug />} />
          <Route path="*" element={<Navigate to="/gateway" replace />} />
        </Routes>
      </main>
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
