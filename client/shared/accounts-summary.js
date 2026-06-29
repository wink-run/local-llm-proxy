// 各端心跳上报：仅登记项摘要（名称/类型/源 id），不含 Key、密码等凭证。

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
function buildAccountsSummary(accounts = {}) {
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

/** 云端同步前剔除凭证字段（防御性） */
function stripBillingSecrets(billing = {}) {
  const scrub = (row) => {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const k of SENSITIVE_KEYS) delete out[k];
    return out;
  };
  return {
    ...billing,
    user_subscriptions: Array.isArray(billing.user_subscriptions)
      ? billing.user_subscriptions.map(scrub) : billing.user_subscriptions,
    user_payg_providers: Array.isArray(billing.user_payg_providers)
      ? billing.user_payg_providers.map(scrub) : billing.user_payg_providers,
  };
}

module.exports = { buildAccountsSummary, stripBillingSecrets };
