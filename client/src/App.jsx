import React from 'react';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import { ThemeProvider } from './store/theme';
import Sidebar from './components/Sidebar';
import Profile from './pages/Profile';
import Agent from './pages/Agent';
import Network from './pages/Network';
import Config from './pages/Config';
import Debug from './pages/Debug';

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
          <Route path="/" element={user ? <Profile /> : <Navigate to="/config" replace />} />
          <Route path="/agent" element={user ? <Agent /> : <Navigate to="/config" replace />} />
          <Route path="/network" element={<Network />} />
          <Route path="/config" element={<Config />} />
          <Route path="/debug" element={<Debug />} />
          <Route path="*" element={<Navigate to={user ? '/' : '/config'} replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <Layout />
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}
