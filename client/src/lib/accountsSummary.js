// 浏览器端：账户登记摘要（无凭证），与 shared/accounts-summary.js 逻辑一致

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
  const subs = (accounts.user_subscriptions || []).map(s => pickSafe(s, [
    'id', 'source_id', 'name', 'app_name', 'app_icon', 'plan_label', 'plan_id',
    'subscription_kind', 'subscription_to_api', 'monthly_usd',
  ])).map(s => ({
    ...s,
    name: s.name || s.app_name,
    kind: s.subscription_kind === 'api' ? 'api_sub' : (s.subscription_to_api ? 'sub_to_api' : 'app_sub'),
  }));

  const payg = (accounts.user_payg_providers || []).map(p => ({
    ...pickSafe(p, ['id', 'provider_id', 'name', 'label', 'icon']),
    models_count: Array.isArray(p.models) ? p.models.length : 0,
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
    });
  }

  return { subscriptions: subs, payg, direct };
}
