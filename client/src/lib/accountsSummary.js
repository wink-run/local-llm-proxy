// 浏览器端：账户登记摘要（无凭证），与 shared/accounts-summary.js 逻辑一致

import {
  fingerprintSubscription,
  fingerprintPayg,
  fingerprintDirect,
  dedupeByConfigFp,
} from './account-config-fingerprint.js';

const SENSITIVE_KEYS = new Set([
  'token', 'credentials', 'api_key', 'password', 'secret', 'refresh_token', 'access_token',
]);

function pickSafe(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && !SENSITIVE_KEYS.has(k)) out[k] = obj[k];
  }
  return out;
}

/** 从 getUserAccounts 快照提取可跨端汇总的上报结构 */
export function buildAccountsSummary(accounts = {}) {
  const subs = (accounts.user_subscriptions || []).map(s => ({
    ...pickSafe(s, [
      'id', 'source_id', 'name', 'app_name', 'app_icon', 'plan_label', 'plan_id',
      'subscription_kind', 'subscription_to_api', 'monthly_usd',
    ]),
    name: s.name || s.app_name,
    kind: s.subscription_kind === 'api' ? 'api_sub' : (s.subscription_to_api ? 'sub_to_api' : 'app_sub'),
    config_fp: fingerprintSubscription(s),
  }));

  const payg = (accounts.user_payg_providers || []).map(p => ({
    ...pickSafe(p, ['id', 'provider_id', 'name', 'label', 'icon']),
    models_count: Array.isArray(p.models) ? p.models.length : 0,
    config_fp: fingerprintPayg(p),
  }));

  const direct = [];
  const billing = accounts.direct_source_billing || {};
  for (const [agentId, b] of Object.entries(billing)) {
    if (!b || typeof b !== 'object') continue;
    direct.push({
      agent_id: agentId,
      source_id: b.source_id || agentId,
      name: b.name || agentId,
      mode: b.mode === 'api' ? 'api' : 'subscription',
      monthly_usd: b.monthly_usd,
      config_fp: fingerprintDirect(agentId, b),
    });
  }

  return { subscriptions: subs, payg, direct };
}

/** 从云端 inventory 各设备的 accounts_summary 展平（个人页只读，带 device 标记） */
export function collectDeviceAccounts(devices, formatTitle = (d) => d?.name || d?.device_id || '') {
  const out = { subs: [], payg: [], direct: [] };
  for (const d of devices || []) {
    const device_id = d.device_id || d.id;
    const device_label = formatTitle(d);
    const a = d.accounts_summary || {};
    for (const s of a.subscriptions || []) {
      out.subs.push({ ...s, device_id, device_label });
    }
    for (const p of a.payg || []) {
      out.payg.push({ ...p, device_id, device_label });
    }
    for (const dr of a.direct || []) {
      out.direct.push({ ...dr, device_id, device_label });
    }
  }
  return out;
}

/** 按 config_fp 去重并合并设备标签（同配置跨设备只计一份） */
export function dedupeDeviceAccounts(collected) {
  return {
    subs: dedupeByConfigFp(collected?.subs),
    payg: dedupeByConfigFp(collected?.payg),
    direct: dedupeByConfigFp(collected?.direct),
  };
}

/** 云端多设备摘要 → 计费用 accounts 结构（已按 config_fp 去重） */
export function billingAccountsFromDevices(devices, formatTitle) {
  const deduped = dedupeDeviceAccounts(collectDeviceAccounts(devices, formatTitle));
  const user_subscriptions = deduped.subs.map(s => ({
    ...s,
    subscription_kind: s.kind === 'api_sub' ? 'api' : 'app',
    agent_id: s.agent_id || s.source_id,
  }));
  const user_payg_providers = deduped.payg.map(p => ({
    id: p.id || p.provider_id,
    provider_id: p.provider_id,
    label: p.label,
    name: p.name,
  }));
  const direct_source_billing = {};
  for (const d of deduped.direct) {
    const aid = d.agent_id || d.source_id;
    if (!aid) continue;
    direct_source_billing[aid] = {
      source_id: d.source_id || aid,
      name: d.name,
      mode: d.mode,
      monthly_usd: d.monthly_usd,
    };
  }
  return { user_subscriptions, user_payg_providers, direct_source_billing };
}
