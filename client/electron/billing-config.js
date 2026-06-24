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
  cursor: [
    { id: 'cursor-pro', label: 'Cursor Pro', monthly_usd: 20 },
    { id: 'cursor-ultra', label: 'Cursor Ultra', monthly_usd: 200 },
  ],
  volcengine: [
    { id: 'coding-lite', label: 'Coding Plan Lite · 40元/月', monthly_usd: 5.71 },
    { id: 'coding-pro', label: 'Coding Plan Pro · 200元/月', monthly_usd: 28.57 },
  ],
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
      // 订阅是否可转为 API 供给源（yaml subscription_to_api，默认 false）
      subscription_to_api: a.subscription_to_api === true,
      app_name: a.app_name || a.name || a.agent_id,
      app_icon: a.app_icon || a.icon || '🔧',
      plans: appPlans,
    };
  });
}

/** 预置 API 订阅目录（ChatGPT、Claude 等；与供给源页 provider 列表分离） */
function apiSubscriptionCatalog(cfg = {}) {
  const plans = getSubscriptionPlans(cfg);
  return configLoader.apiSubscriptionApps().map(a => {
    const planKey = a.plan_provider_id || null;
    const appPlans = Array.isArray(a.plans) && a.plans.length
      ? a.plans.map(normPlan).filter(Boolean)
      : (planKey && plans[planKey] ? plans[planKey] : []);
    return {
      source_id: a.source_id || a.id,
      plan_provider_id: planKey,
      app_name: a.app_name || a.name || a.source_id,
      app_icon: a.app_icon || a.icon || '🔑',
      plans: appPlans,
    };
  });
}

function paygProviderCatalog() {
  return configLoader.paygProviders().map(normPaygEntry);
}

/**
 * 个人页已登记的付费供给源 id（订阅 + 按量，含仅统计类）：
 * - 订阅账户 → subscription_catalog.plan_provider_id
 * - 按量账户 → user_payg_providers.provider_id
 */
function resolveUserPaidProviderIds(cfg = {}) {
  const ids = new Set();
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  for (const sub of cfg.user_subscriptions || []) {
    if (sub.subscription_kind === 'api' && sub.plan_provider_id) {
      ids.add(sub.plan_provider_id);
      continue;
    }
    const pid = catalogBySource[sub.source_id]?.plan_provider_id;
    if (pid) ids.add(pid);
  }
  for (const p of cfg.user_payg_providers || []) {
    if (p.provider_id) ids.add(p.provider_id);
  }
  return [...ids];
}

/** 单条订阅是否启用「订阅转 API」：用户登记优先，否则 yaml 目录默认 */
function resolveSubUseApi(sub, catalogBySource) {
  if (sub?.subscription_kind === 'api') return true;
  if (sub?.subscription_to_api != null) return sub.subscription_to_api === true;
  const cat = catalogBySource[sub?.source_id];
  return cat?.subscription_to_api === true;
}

/** 订阅转 API 时对应的供给源 id（自定义订阅固定用 source_id） */
function subscriptionGatewayProviderId(sub, catalogBySource) {
  if (!sub) return null;
  if (sub.custom) return sub.source_id || sub.plan_provider_id || null;
  if (sub.subscription_kind === 'api') return sub.plan_provider_id || null;
  const cat = catalogBySource[sub.source_id];
  return cat?.plan_provider_id || null;
}

/** 订阅转 API 的验证方式：APP 目录 OAuth；API 订阅与自定义均 API Key */
function subscriptionGatewayAuthMode(sub, catalogBySource) {
  if (!resolveSubUseApi(sub, catalogBySource)) return null;
  if (sub.subscription_kind === 'api') return 'api_key';
  if (sub.custom) return 'api_key';
  const cat = catalogBySource[sub.source_id];
  return cat?.plan_provider_id ? 'oauth' : 'api_key';
}

/** 订阅登记且 subscription_to_api=true 的供给源 id */
function resolveSubscriptionGatewayProviderIds(cfg = {}) {
  const ids = new Set();
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  for (const sub of cfg.user_subscriptions || []) {
    const pid = subscriptionGatewayProviderId(sub, catalogBySource);
    if (pid && resolveSubUseApi(sub, catalogBySource)) ids.add(pid);
  }
  return [...ids];
}

/** 个人页按量账户对应的供给源 id */
function resolveGatewayPaygProviderIds(cfg = {}) {
  const ids = new Set();
  for (const p of cfg.user_payg_providers || []) {
    if (p.provider_id) ids.add(p.provider_id);
  }
  return [...ids];
}

/** 各 provider 在供给源页的验证方式：oauth（订阅转 API）/ api_key（按量）/ both */
function resolveProviderGatewayAuthMap(cfg = {}) {
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  const modes = {};

  for (const sub of cfg.user_subscriptions || []) {
    const pid = subscriptionGatewayProviderId(sub, catalogBySource);
    const auth = subscriptionGatewayAuthMode(sub, catalogBySource);
    if (!pid || !auth) continue;
    if (modes[pid] && modes[pid] !== auth) modes[pid] = 'both';
    else modes[pid] = auth;
  }

  for (const p of cfg.user_payg_providers || []) {
    const id = p.provider_id;
    if (!id) continue;
    if (modes[id] === 'oauth') modes[id] = 'both';
    else modes[id] = 'api_key';
  }
  return modes;
}

/** 供给源选择器条目（与 Providers 页展示一致） */
function buildGatewayPickerEntries(cfg = {}) {
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  const entries = [];

  for (const sub of cfg.user_subscriptions || []) {
    if (!resolveSubUseApi(sub, catalogBySource)) continue;
    if (sub.custom) {
      entries.push({
        providerId: sub.source_id,
        pickerKey: `sub:${sub.source_id}`,
        label: sub.app_name || sub.source_id,
        icon: sub.app_icon || '🔧',
        authMode: 'api_key',
        source: 'subscription',
        custom: true,
        personalTag: sub.subscription_kind === 'api' ? 'api_sub' : 'sub_to_api',
      });
      continue;
    }
    if (sub.subscription_kind === 'api') {
      const pid = sub.plan_provider_id || sub.source_id;
      if (!pid) continue;
      entries.push({
        providerId: pid,
        pickerKey: `sub:${sub.source_id || `api-${pid}`}`,
        label: sub.app_name || pid,
        icon: sub.app_icon || '🔑',
        authMode: 'api_key',
        source: 'subscription',
        custom: true,
        personalTag: 'api_sub',
      });
      continue;
    }
    const cat = catalogBySource[sub.source_id];
    const pid = cat?.plan_provider_id;
    if (!pid) continue;
    entries.push({
      providerId: pid,
      pickerKey: `sub:${sub.source_id}`,
      label: sub.app_name || cat?.app_name || pid,
      icon: sub.app_icon || cat?.app_icon || '🔷',
      authMode: 'oauth',
      source: 'subscription',
      personalTag: 'sub_to_api',
    });
  }

  for (const payg of cfg.user_payg_providers || []) {
    const pid = payg.provider_id;
    if (!pid) continue;
    entries.push({
      providerId: pid,
      pickerKey: `payg:${pid}`,
      label: payg.label || pid,
      icon: payg.icon || '🔧',
      authMode: 'api_key',
      source: 'payg',
      personalTag: 'payg',
    });
  }
  return entries;
}

/** 可在供给源页接入的 id：订阅转 API + 按量账户 */
function resolveUserGatewayProviderIds(cfg = {}) {
  return [...new Set([
    ...resolveSubscriptionGatewayProviderIds(cfg),
    ...resolveGatewayPaygProviderIds(cfg),
  ])];
}

/** 仅用量统计、不能在供给源页接入的 provider（订阅未开启 subscription_to_api） */
function resolveStatsOnlyProviderIds(cfg = {}) {
  const gateway = new Set(resolveUserGatewayProviderIds(cfg));
  const paygIds = new Set(
    (cfg.user_payg_providers || []).map(p => p.provider_id).filter(Boolean),
  );
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  const statsOnly = new Set();
  for (const sub of cfg.user_subscriptions || []) {
    const cat = catalogBySource[sub.source_id];
    const pid = cat?.plan_provider_id;
    // 有订阅映射但未开 subscription_to_api，且未单独登记按量 → 仅统计
    if (pid && !gateway.has(pid) && !paygIds.has(pid)) statsOnly.add(pid);
  }
  return [...statsOnly];
}

/** 提取 provider.models 条目中的模型名 */
function modelEntryId(m) {
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object') return String(m.name || m.id || m.model || '');
  return '';
}

/**
 * 清理旧逻辑遗留的供给源配置：
 * - 移除未在个人页登记的 custom-* 供给源
 * - 未启用的付费源清空 models（去掉 yaml 预填）
 * - 已启用但不在个人页登记列表的付费源强制禁用
 */
function migrateAgentProviders(cfg = {}) {
  const gatewayIds = new Set(resolveUserGatewayProviderIds(cfg));
  if (!Array.isArray(cfg.providers)) return { cfg, changed: false };
  let changed = false;
  const next = [];
  for (const raw of cfg.providers) {
    const p = { ...raw };
    if (p.type === 'paid') {
      if (String(p.id || '').startsWith('custom-') && !gatewayIds.has(p.id)) {
        changed = true;
        continue;
      }
      if (!p.enabled) {
        if (Array.isArray(p.models) && p.models.length) {
          p.models = [];
          changed = true;
        }
      } else if (!gatewayIds.has(p.id)) {
        p.enabled = false;
        p.models = [];
        changed = true;
      }
    }
    next.push(p);
  }
  if (changed) cfg.providers = next;
  return { cfg, changed };
}

function getUserAccounts(cfg = {}) {
  const billing = getBillingSettings(cfg);
  const paidIds = resolveUserPaidProviderIds(cfg);
  const gatewaySubIds = resolveSubscriptionGatewayProviderIds(cfg);
  const gatewayPaygIds = resolveGatewayPaygProviderIds(cfg);
  return {
    subscription_catalog: subscriptionAppCatalog(cfg),
    api_subscription_catalog: apiSubscriptionCatalog(cfg),
    payg_provider_catalog: paygProviderCatalog(),
    user_subscriptions: Array.isArray(cfg.user_subscriptions) ? cfg.user_subscriptions : [],
    user_payg_providers: Array.isArray(cfg.user_payg_providers) ? cfg.user_payg_providers : [],
    paid_provider_ids: paidIds,
    gateway_provider_ids: resolveUserGatewayProviderIds(cfg),
    gateway_subscription_provider_ids: gatewaySubIds,
    gateway_payg_provider_ids: gatewayPaygIds,
    provider_gateway_auth: resolveProviderGatewayAuthMap(cfg),
    gateway_picker_entries: buildGatewayPickerEntries(cfg),
    stats_only_provider_ids: resolveStatsOnlyProviderIds(cfg),
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
  apiSubscriptionCatalog,
  paygProviderCatalog,
  resolveUserPaidProviderIds,
  resolveUserGatewayProviderIds,
  resolveSubscriptionGatewayProviderIds,
  resolveGatewayPaygProviderIds,
  resolveProviderGatewayAuthMap,
  buildGatewayPickerEntries,
  subscriptionGatewayProviderId,
  resolveSubUseApi,
  migrateAgentProviders,
  modelEntryId,
  resolveStatsOnlyProviderIds,
  resolvePricingProviderId,
  applyPricingOverrides,
  normPlan,
  normPaygEntry,
};
