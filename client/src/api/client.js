import axios from 'axios';

const http = axios.create({ timeout: 10000 });

// Read serverUrl and token from localStorage on every request
http.interceptors.request.use((config) => {
  const base = localStorage.getItem('serverUrl') || 'http://localhost:8000';
  config.baseURL = base;
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export function login(email, password) {
  return http.post('/user/login', { email, password });
}

export function getProfile() {
  return http.get('/user/profile');
}

export function getStats() {
  return http.get('/user/stats');
}

export function getTransactions() {
  return http.get('/user/transactions');
}

export function getSettlements() {
  return http.get('/user/settlements');
}

export function getNetwork() {
  return http.get('/public/network');
}
