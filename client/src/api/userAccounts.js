// 个人页订阅 / 按量：桌面 IPC 与 Docker admin-api 统一入口

import { getServerUrl, normalizeServerBase, syncCloudConfigUrl } from '../config';

function billingHeaders() {
  const token = localStorage.getItem('token') || '';
  const serverUrl = normalizeServerBase(getServerUrl() || '');
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(serverUrl ? { 'X-TokenBank-Server': serverUrl } : {}),
  };
}

/** 拉取并合并云端账户配置（与 Electron localConfig:getUserAccounts 同结构） */
export async function loadUserAccounts() {
  if (window.electronAPI?.localConfig?.getUserAccounts) {
    return window.electronAPI.localConfig.getUserAccounts();
  }
  const serverUrl = normalizeServerBase(getServerUrl() || '');
  if (serverUrl) await syncCloudConfigUrl(serverUrl).catch(() => {});
  const res = await fetch('/api/user-accounts', { headers: billingHeaders() });
  if (!res.ok) throw new Error(`user-accounts HTTP ${res.status}`);
  return res.json();
}

/** 保存账户配置并同步云端 */
export async function saveUserAccounts(patch) {
  if (window.electronAPI?.localConfig?.setUserAccounts) {
    return window.electronAPI.localConfig.setUserAccounts(patch);
  }
  const serverUrl = normalizeServerBase(getServerUrl() || '');
  if (serverUrl) await syncCloudConfigUrl(serverUrl).catch(() => {});
  const res = await fetch('/api/user-accounts', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...billingHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`user-accounts HTTP ${res.status}`);
  return res.json();
}
