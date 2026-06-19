import axios from 'axios';
import { getServerUrl, normalizeServerBase, getApiBaseUrl } from '../config';

const http = axios.create({ timeout: 15000 });

// Read serverUrl and token from localStorage on every request
http.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** Electron 主进程发请求，绕过系统代理 / CORS */
async function authRequest(method, path, { body, token } = {}) {
  if (window.electronAPI?.auth?.request) {
    const base = getServerUrl();
    const r = await window.electronAPI.auth.request({
      base, method, path, body: body ?? null, token: token || null,
    });
    let data = null;
    if (r.body) {
      try { data = JSON.parse(r.body); } catch { data = { detail: r.body }; }
    }
    if (r.status >= 400) {
      const detail = data?.detail ?? data?.message ?? r.body ?? `HTTP ${r.status}`;
      const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      err.response = { status: r.status, data };
      throw err;
    }
    return { data };
  }
  const cfg = { method, url: path, baseURL: getApiBaseUrl() };
  if (body != null) cfg.data = body;
  if (token) cfg.headers = { Authorization: `Bearer ${token}` };
  return http.request(cfg);
}

function formatApiError(err, fallback) {
  if (err.response?.data?.detail) {
    const d = err.response.data.detail;
    return typeof d === 'string' ? d : JSON.stringify(d);
  }
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
    const base = getServerUrl();
    return base ? `连接超时，请检查服务地址 ${base}` : '连接超时，请先配置 Token Bank 服务地址';
  }
  if (!err.response) {
    const base = getServerUrl();
    return base
      ? `无法连接服务器 ${base}，请确认地址正确且服务已启动`
      : '请先填写 Token Bank 服务地址';
  }
  return fallback;
}

export { formatApiError };

export function login(email, password) {
  return authRequest('POST', '/user/login', { body: { email, password } });
}

export function register(email, password, nickname = '', referral_code = '') {
  return authRequest('POST', '/user/register', { body: { email, password, nickname, referral_code } });
}

export function getProfile() {
  const token = localStorage.getItem('token');
  return authRequest('GET', '/user/profile', { token });
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

// 当前在线 worker 模型（OpenAI /v1/models；需用户 API Key，非登录 JWT）
export async function getOnlineModels() {
  const { getLocalConfig } = await import('./adapter');
  const cfg = await getLocalConfig().get().catch(() => null);
  const apiKey = cfg?.cloud_config?.token;
  if (!apiKey) return { data: { object: 'list', data: [] } };

  const base = normalizeServerBase(cfg?.cloud_config?.url || getServerUrl());
  if (window.electronAPI?.auth?.request) {
    const r = await window.electronAPI.auth.request({
      base, method: 'GET', path: '/v1/models', token: apiKey,
    });
    let data = { object: 'list', data: [] };
    if (r.body) {
      try { data = JSON.parse(r.body); } catch { /* keep empty */ }
    }
    if (r.status >= 400) return { data: { object: 'list', data: [] } };
    return { data };
  }

  const res = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return { data: { object: 'list', data: [] } };
  return { data: await res.json() };
}

export function getProviderCatalog() {
  return http.get('/api/catalog');
}

export function getUserAccountsSettings() {
  return http.get('/user/accounts');
}

export function saveUserAccountsSettings(body) {
  return http.put('/user/accounts', body);
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

/** 个人页看板：各端上报盘点数据按设备维度聚合（云端） */
export function getInventoryStats(days = 1) {
  return http.get(`/user/inventory-stats?days=${days}`);
}


// ── Device management ─────────────────────────────────────────────────────────

export function getUserDevices() {
  return http.get('/user/devices');
}

export function deleteDevice(deviceId) {
  return http.delete(`/device/${deviceId}`);
}

export function registerDevice(info) {
  return http.post('/device/register', info);
}

export function heartbeatDevice(deviceId, stats) {
  return http.post('/device/heartbeat', { device_id: deviceId, online: true, stats });
}
