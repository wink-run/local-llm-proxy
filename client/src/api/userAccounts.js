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

/** 拉取账户配置（始终读本机 local-config；个人页汇总走 inventory accounts_summary） */
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

/** 保存账户配置（仅写本机；摘要由设备心跳单向上报） */
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

/** 从云端同步供给源目录到本机 registry（CLI 传 serverUrl + JWT） */
export async function syncProviderCatalog() {
  if (window.electronAPI?.localConfig?.syncProviderCatalog) {
    return window.electronAPI.localConfig.syncProviderCatalog();
  }
  const serverUrl = normalizeServerBase(getServerUrl() || '');
  if (serverUrl) await syncCloudConfigUrl(serverUrl).catch(() => {});
  const res = await fetch('/api/provider-catalog/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...billingHeaders() },
    body: JSON.stringify({ serverUrl }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch {}
    throw new Error(`catalog sync HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

/** @deprecated 账户配置不再 PUT 云端；保留 API 兼容 */
export async function pushUserAccountsToCloud() {
  if (window.electronAPI?.localConfig?.pushUserAccountsToCloud) {
    return window.electronAPI.localConfig.pushUserAccountsToCloud();
  }
  return loadUserAccounts({ localOnly: true });
}
