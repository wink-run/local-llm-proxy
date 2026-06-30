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

/** 拉取账户配置（与 Electron localConfig:getUserAccounts 同结构）
 *  @param {{ localOnly?: boolean }} opts localOnly=true 时仅读本机配置（供给源个人源） */
export async function loadUserAccounts({ localOnly = false } = {}) {
  if (window.electronAPI?.localConfig?.getUserAccounts) {
    return window.electronAPI.localConfig.getUserAccounts({ localOnly });
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

/** 登录后上传本机账户到云端，不拉取覆盖本地（个人源登录/游客共享同一份本机数据） */
export async function pushUserAccountsToCloud() {
  if (window.electronAPI?.localConfig?.pushUserAccountsToCloud) {
    return window.electronAPI.localConfig.pushUserAccountsToCloud();
  }
  const token = localStorage.getItem('token');
  if (!token) return null;
  const serverUrl = normalizeServerBase(getServerUrl() || '');
  if (!serverUrl) return null;
  await syncCloudConfigUrl(serverUrl).catch(() => {});
  const res = await fetch('/api/user-accounts', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...billingHeaders() },
    body: JSON.stringify(await loadUserAccounts({ localOnly: true })),
  });
  if (!res.ok) throw new Error(`user-accounts HTTP ${res.status}`);
  return res.json();
}
