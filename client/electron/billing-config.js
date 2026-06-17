// client/electron/billing-config.js
// 订阅/按量目录来自 tokenbank.tools.yaml；刊例价按 provider 独立配置。
'use strict';

const configLoader = require('./config-loader');

const FALLBACK_SUBSCRIPTION_PLANS = {
  'anthropic-paid': [
    { id: 'claude-pro', label: 'Claude Pro', monthly_usd: 20 },
    { id: 'max5x', label: 'Claude Max (5×)', monthly_usd: 100 },
    { id: 'max20x', label: 'Claude Max (20×)', monthly_usd: 200 },
  ],
  openai: [
    { id: 'chatgpt-plus', label: 'ChatGPT Plus', monthly_usd: 20 },
    { id: 'chatgpt-team', label: 'ChatGPT Team', monthly_usd: 25 },
    { id: 'chatgpt-pro', label: 'ChatGPT Pro', monthly_usd: 200 },
  ],
  gemini: [
    { id: 'gemini-advanced', label: 'Gemini Advanced', monthly_usd: 20 },
    { id: 'google-one-ai', label: 'Google One AI', monthly_usd: 20 },
  ],
  'github-copilot': [
    { id: 'copilot-pro', label: 'GitHub Copilot Pro', monthly_usd: 10 },
    { id: 'copilot-business', label: 'Copilot Business', monthly_usd: 19 },
  ],
  cursor: [{ id: 'cursor-pro', label: 'Cursor Pro', monthly_usd: 20 }],
};

function normPlan(p) {
  if (Array.isArray(p)) return { id: p[0], label: p[1], monthly_usd: null };
  if (!p || typeof p !== 'object') return null;
  return {
    id: String(p.id || ''),
    label: String(p.label || p.id || ''),
    monthly_usd: p.monthly_usd != null && p.monthly_usd !== '' ? Number(p.monthly_usd) : null,
  };
}

/** 归一化 payg_providers 条目：models 列表 + 该 provider 独立 pricing */
function normPaygEntry(p) {
  const id = String(p.id || p.provider_id || '');
  const models = [];
  const pricing = {};
  // pricing 段：model → rates
  if (p.pricing && typeof p.pricing === 'object') {
    for (const [m, rates] of Object.entries(p.pricing)) {
      if (rates && typeof rates === 'object') pricing[m] = { ...rates };
    }
  }
  // models 可为字符串或带 inline 报价的对象
  if (Array.isArray(p.models)) {
    for (const m of p.models) {
      if (typeof m === 'string') {
        models.push(m);
      } else if (m && typeof m === 'object') {
        const mid = m.id || m.model;
        if (!mid) continue;
        models.push(mid);
        const { id: _i, model: _m, ...rates } = m;
        if (rates.in != null || rates.out != null || rates.cacheRead != null) {
          pricing[mid] = { ...(pricing[mid] || {}), ...rates };
        }
      }
    }
  }
  return {
    id,
    provider_id: id,
    label: p.label || p.name || id,
    icon: p.icon || '🔧',
    aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
    models,
    pricing,
  };
}

function getSubscriptionPlans(cfg = {}) {
  const yamlDefaults = configLoader.subscriptionPlansDefaults();
  const user = cfg.subscription_plans || {};
  const ids = new Set([...Object.keys(FALLBACK_SUBSCRIPTION_PLANS), ...Object.keys(yamlDefaults), ...Object.keys(user)]);
  const out = {};
  for (const pid of ids) {
    const raw = user[pid] ?? yamlDefaults[pid] ?? FALLBACK_SUBSCRIPTION_PLANS[pid] ?? [];
    out[pid] = (Array.isArray(raw) ? raw : []).map(normPlan).filter(pl => pl && pl.id);
  }
  return out;
}

/** yaml 下发的按 provider 刊例价 */
function getYamlProviderPricing() {
  const out = {};
  for (const p of configLoader.paygProviders()) {
    const norm = normPaygEntry(p);
    if (norm.provider_id && Object.keys(norm.pricing).length) {
      out[norm.provider_id] = norm.pricing;
    }
  }
  return out;
}

/** 合并 yaml 下发 + 用户 provider_pricing_overrides */
function getProviderPricing(cfg = {}) {
  const yaml = getYamlProviderPricing();
  const overrides = cfg.provider_pricing_overrides || {};
  const ids = new Set([...Object.keys(yaml), ...Object.keys(overrides)]);
  const merged = {};
  for (const pid of ids) {
    merged[pid] = { ...(yaml[pid] || {}) };
    for (const [model, rates] of Object.entries(overrides[pid] || {})) {
      merged[pid][model] = { ...(merged[pid][model] || {}), ...rates };
    }
  }
  return merged;
}

/** 将用量记录里的 provider_id 解析为 payg 定价键（支持 aliases） */
function resolvePricingProviderId(providerId) {
  if (!providerId) return null;
  const pid = String(providerId).toLowerCase();
  for (const p of paygProviderCatalog()) {
    const key = String(p.provider_id || p.id || '').toLowerCase();
    if (key === pid) return p.provider_id;
    if ((p.aliases || []).some(a => String(a).toLowerCase() === pid)) return p.provider_id;
  }
  return providerId;
}

function getBillingSettings(cfg = {}) {
  const yamlPlans = configLoader.subscriptionPlansDefaults();
  return {
    subscription_plans: getSubscriptionPlans(cfg),
    provider_pricing: getProviderPricing(cfg),
    provider_pricing_overrides: cfg.provider_pricing_overrides || {},
    provider_labels: buildProviderLabels(),
    defaults: {
      subscription_plans: { ...FALLBACK_SUBSCRIPTION_PLANS, ...yamlPlans },
      provider_pricing: getProviderPricing({}),
    },
  };
}

function buildProviderLabels() {
  const labels = {};
  for (const p of paygProviderCatalog()) {
    const id = p.provider_id || p.id;
    if (id) labels[id] = p.label || id;
  }
  return labels;
}

/** 同步运行时定价表 */
function applyPricingOverrides(overrides = {}) {
  const pricing = require('./pricing');
  const merged = getProviderPricing({ provider_pricing_overrides: overrides });
  if (typeof pricing.applyProviderPricing === 'function') {
    pricing.applyProviderPricing(merged);
  }
}

function subscriptionAppCatalog(cfg = {}) {
  const plans = getSubscriptionPlans(cfg);
  return configLoader.subscriptionApps().map(a => {
    const planKey = a.plan_provider_id || a.provider_id || null;
    const appPlans = Array.isArray(a.plans) && a.plans.length
      ? a.plans.map(normPlan).filter(Boolean)
      : (planKey && plans[planKey] ? plans[planKey] : []);
    return {
      source_id: a.source_id || a.id || a.agent_id,
      agent_id: a.agent_id,
      provider_id: a.provider_id,
      plan_provider_id: planKey,
      app_name: a.app_name || a.name || a.agent_id,
      app_icon: a.app_icon || a.icon || '🔧',
      plans: appPlans,
    };
  });
}

function paygProviderCatalog() {
  return configLoader.paygProviders().map(normPaygEntry);
}

function getUserAccounts(cfg = {}) {
  const billing = getBillingSettings(cfg);
  return {
    subscription_catalog: subscriptionAppCatalog(cfg),
    payg_provider_catalog: paygProviderCatalog(),
    user_subscriptions: Array.isArray(cfg.user_subscriptions) ? cfg.user_subscriptions : [],
    user_payg_providers: Array.isArray(cfg.user_payg_providers) ? cfg.user_payg_providers : [],
    ...billing,
  };
}

module.exports = {
  FALLBACK_SUBSCRIPTION_PLANS,
  getSubscriptionPlans,
  getProviderPricing,
  getBillingSettings,
  getUserAccounts,
  subscriptionAppCatalog,
  paygProviderCatalog,
  resolvePricingProviderId,
  applyPricingOverrides,
  normPlan,
  normPaygEntry,
};
