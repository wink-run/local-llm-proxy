import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { getProfile } from '../api/client';

const AuthContext = createContext(null);

const POLL_INTERVAL = 30_000;

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
      })
      .catch(() => { localStorage.removeItem('token'); })
      .finally(() => setLoading(false));
    return () => stopPolling();
  }, []);

  function loginSuccess(token, userData) {
    localStorage.setItem('token', token);
    setUser(userData);
    startPolling();
  }

  function logout() {
    localStorage.removeItem('token');
    setUser(null);
    stopPolling();
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
