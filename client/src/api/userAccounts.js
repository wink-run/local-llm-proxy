// 个人页订阅 / 按量：统一从云端 /user/accounts 读写（跨端一致）

import { getUserAccountsSettings, saveUserAccountsSettings } from './client';
import { getServerUrl, normalizeServerBase } from '../config';

/** 仅同步到网关 local-config 的计费字段（供离线估价，非 UI 数据源） */
function pickBillingFields(obj = {}) {
  return {
    user_subscriptions: Array.isArray(obj.user_subscriptions) ? obj.user_subscriptions : [],
    user_payg_providers: Array.isArray(obj.user_payg_providers) ? obj.user_payg_providers : [],
    provider_pricing_overrides: obj.provider_pricing_overrides && typeof obj.provider_pricing_overrides === 'object'
      ? obj.provider_pricing_overrides : {},
    subscription_plans: obj.subscription_plans && typeof obj.subscription_plans === 'object'
      ? obj.subscription_plans : {},
  };
}

/** 将云端计费配置写入本地网关缓存（静默，不影响 UI 数据源） */
async function syncBillingCacheToGateway(billing) {
  const patch = pickBillingFields(billing);
  try {
    if (window.electronAPI?.localConfig?.syncBillingCache) {
      await window.electronAPI.localConfig.syncBillingCache(patch);
      return;
    }
    if (window.electronAPI) return;
    const token = localStorage.getItem('token') || '';
    const serverUrl = normalizeServerBase(getServerUrl() || '');
    await fetch('/api/local-config/billing-cache', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(serverUrl ? { 'X-TokenBank-Server': serverUrl } : {}),
      },
      body: JSON.stringify(patch),
    });
  } catch { /* 网关离线时忽略 */ }
}

/** 拉取云端账户视图（含目录合并）；本地有旧数据且云端为空时自动迁移一次 */
export async function loadUserAccounts() {
  const token = localStorage.getItem('token');
  if (!token) throw new Error('未登录');
  let r = await getUserAccountsSettings();
  let data = r.data;

  // 桌面版 legacy：云端空、本地有数据 → 上传迁移
  if (window.electronAPI?.localConfig?.getBillingLegacy) {
    const local = await window.electronAPI.localConfig.getBillingLegacy();
    const cloudEmpty = !(data.user_subscriptions?.length) && !(data.user_payg_providers?.length);
    const localHas = (local.user_subscriptions?.length || local.user_payg_providers?.length);
    if (cloudEmpty && localHas) {
      r = await saveUserAccountsSettings(pickBillingFields(local));
      data = r.data;
    }
  }

  syncBillingCacheToGateway(data);
  return data;
}

/** 保存账户配置到云端并刷新本地网关缓存 */
export async function saveUserAccounts(patch) {
  const token = localStorage.getItem('token');
  if (!token) throw new Error('未登录');
  const r = await saveUserAccountsSettings(patch);
  const data = r.data;
  syncBillingCacheToGateway(data);
  return data;
}
