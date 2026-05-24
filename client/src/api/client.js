import axios from 'axios';
import { getServerUrl } from '../config';

const http = axios.create({ timeout: 10000 });

// Read serverUrl and token from localStorage on every request
http.interceptors.request.use((config) => {
  const base = getServerUrl();
  config.baseURL = base;
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export function login(email, password) {
  return http.post('/user/login', { email, password });
}

export function register(email, password, nickname = '', referral_code = '') {
  return http.post('/user/register', { email, password, nickname, referral_code });
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

export function listKeys() {
  return http.get('/user/keys');
}

export function createKey(note = '') {
  return http.post('/user/keys', { note });
}

export function toggleKey(keyId, isActive) {
  return http.patch(`/user/keys/${keyId}`, { is_active: isActive });
}

export function deleteKey(keyId) {
  return http.delete(`/user/keys/${keyId}`);
}

export function checkin() {
  return http.post('/user/checkin');
}

export function getCheckinStatus() {
  return http.get('/user/checkin/status');
}

/** 购买记录 + contact_info（管理员配置的付款方式） */
export function getPurchaseOrders() {
  return http.get('/user/purchase-orders');
}

export function createPurchaseOrder(amount_credits, note = '') {
  return http.post('/user/purchase-order', { amount_credits, note });
}

export function spin() {
  return http.post('/user/spin');
}

export function getSpinStatus() {
  return http.get('/user/spin/status');
}

export function getRates() {
  return http.get('/api/rates');
}

// ── Scene Routes ──────────────────────────────────────────────────────────────

export function getSceneRoutes() {
  return http.get('/user/scene-routes');
}

export function createSceneRoute(body) {
  return http.post('/user/scene-routes', body);
}

export function updateSceneRoute(id, body) {
  return http.put(`/user/scene-routes/${id}`, body);
}

export function deleteSceneRoute(id) {
  return http.delete(`/user/scene-routes/${id}`);
}

export function getKeysWithScene() {
  return http.get('/user/keys-with-scene');
}

export function bindKeyToScene(keyId, body) {
  return http.put(`/user/keys/${keyId}/bind-scene`, body);
}

// ── Dashboard Stats ───────────────────────────────────────────────────────────

export function getDashboardStats(days = 30) {
  return http.get(`/user/dashboard-stats?days=${days}`);
}

export function getModelStats(days = 30) {
  return http.get(`/user/model-stats?days=${days}`);
}
