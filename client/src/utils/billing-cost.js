/** 订阅月费按日折算（统一按 30 天/月） */
export const DAYS_PER_MONTH = 30;

export function subscriptionProrateUsd(monthlyUsd, days = 1) {
  const m = Number(monthlyUsd);
  if (!Number.isFinite(m) || m <= 0) return 0;
  const d = Math.max(1, Number(days) || 1);
  return (m / DAYS_PER_MONTH) * d;
}

/** 格式化 USD 估算 */
export function fmtCostUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** 格式化紧凑数字 */
export function fmtCompactNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(Math.round(v));
}

/** agent_id → 会话 data_source 列表（用量归属；CLI 与 Desktop 分开） */
const AGENT_SESSION_SOURCES = {
  'claude-code': ['session-claude'],
  'claude-desktop': ['session-claude-desktop'],
  codex: ['session-codex'],
  'gemini-cli': ['session-gemini'],
  cursor: ['session-cursor'],
  copilot: ['session-copilot', 'session-copilot-cli'],
  'qwen-code': ['session-qwen'],
  antigravity: ['session-antigravity'],
  'opencode-cli': ['session-opencode'],
  grok: ['session-grok'],
};

export function resolveSubSessionSources(sub, catalog = []) {
  const cat = catalog.find(c => c.source_id === sub?.source_id);
  const agentId = sub?.agent_id || cat?.agent_id;
  if (agentId && AGENT_SESSION_SOURCES[agentId]) return AGENT_SESSION_SOURCES[agentId];
  if (sub?.source_id) return [`session-${sub.source_id}`];
  return [];
}

/** 订阅对应的 agent_id（登记 / 目录） */
export function resolveSubAgentId(sub, catalog = []) {
  const cat = catalog.find(c => c.source_id === sub?.source_id);
  return sub?.agent_id || cat?.agent_id || sub?.source_id || null;
}

/** 应用可能写入的会话 data_source 列表（与 agent_id 一一对应） */
export function sessionSourcesForApp(app) {
  const appAgent = app?.agent_id || app?.preset_id;
  if (!appAgent) return [];
  if (AGENT_SESSION_SOURCES[appAgent]) return AGENT_SESSION_SOURCES[appAgent];
  const sources = [];
  for (const keys of Object.values(AGENT_SESSION_SOURCES)) {
    for (const k of keys) {
      if (k === `session-${appAgent}` || k.endsWith(`-${appAgent}`)) sources.push(k);
    }
  }
  if (sources.length) return sources;
  return [`session-${appAgent}`];
}

/** 应用是否归属某 App 直连订阅（agent_id 或会话来源精确匹配） */
export function appMatchesSubscription(app, sub, catalog = [], apiCatalog = []) {
  if (isApiSubscription(sub)) return false;
  if (isProviderBasedSubscription(sub, catalog)) return false;
  const subAgent = resolveSubAgentId(sub, catalog);
  const appAgent = app?.agent_id || app?.preset_id;
  if (subAgent && appAgent && subAgent === appAgent) return true;
  const subSources = new Set(resolveSubSessionSources(sub, catalog));
  const appSources = sessionSourcesForApp(app);
  if (appSources.some(s => subSources.has(s))) return true;
  return false;
}

/** API 订阅关联的 provider / source id */
export function resolveSubProviderIds(sub, catalog = [], apiCatalog = []) {
  const ids = new Set();
  for (const k of [sub?.plan_provider_id, sub?.gateway_id, sub?.source_id, sub?.agent_id]) {
    if (k) ids.add(k);
  }
  const cat = catalog.find(c => c.source_id === sub?.source_id);
  if (cat?.plan_provider_id) ids.add(cat.plan_provider_id);
  const apiCat = apiCatalog.find(c => c.source_id === sub?.source_id);
  if (apiCat?.plan_provider_id) ids.add(apiCat.plan_provider_id);
  return ids;
}

/** API 订阅（厂商月付，非 App 直连） */
export function isApiSubscription(sub) {
  return sub?.subscription_kind === 'api';
}

/** 有月费的订阅（App / API / 订阅转 API 均计入按日折算） */
export function isBillableSubscription(sub) {
  return Number(sub?.monthly_usd) > 0;
}

/** @deprecated 使用 isBillableSubscription */
export function isAppSubscription(sub) {
  return isBillableSubscription(sub);
}

/** API 订阅或 App 转 API（经 provider 网关计费，按用量摊薄） */
export function isProviderBasedSubscription(sub, catalog = []) {
  if (!isBillableSubscription(sub)) return false;
  if (isApiSubscription(sub)) return true;
  if (sub?.subscription_to_api === true) return true;
  const cat = catalog.find(c => c.source_id === sub?.source_id);
  return cat?.subscription_to_api === true;
}

/** 纯 App 直连订阅（Cursor 等，全额挂应用） */
export function isAppDirectSubscription(sub, catalog = []) {
  return isBillableSubscription(sub) && !isProviderBasedSubscription(sub, catalog);
}

/** 解析模型条目名称（与 Providers 页一致） */
export function modelEntryName(m) {
  if (typeof m === 'string') return m.trim();
  return String(m?.name || m?.id || '').trim();
}

/** 订阅登记的模型列表（API 订阅 / App 转 API） */
export function resolveSubscriptionModels(sub, catalog = [], apiCatalog = [], accounts = {}) {
  const names = new Set();
  const add = (m) => {
    const n = modelEntryName(m);
    if (n) names.add(n);
  };
  for (const m of sub?.models || []) add(m);
  const userSub = (accounts.user_subscriptions || []).find(s =>
    s.id === sub?.id
    || (sub?.source_id && s.source_id === sub.source_id)
    || (sub?.gateway_id && s.gateway_id === sub.gateway_id)
    || (sub?.plan_provider_id && (s.plan_provider_id === sub.plan_provider_id || s.gateway_id === sub.plan_provider_id)),
  );
  if (userSub) {
    for (const m of userSub.models || []) add(m);
    if (userSub.pricing) for (const k of Object.keys(userSub.pricing)) add(k);
  }
  if (sub?.pricing && typeof sub.pricing === 'object') {
    for (const k of Object.keys(sub.pricing)) {
      if (!k.startsWith('_') && k !== 'excluded_models') add(k);
    }
  }
  const apiCat = apiCatalog.find(
    c => c.source_id === sub?.source_id || c.plan_provider_id === sub?.plan_provider_id,
  );
  for (const m of apiCat?.models || []) add(m);
  const cat = catalog.find(c => c.source_id === sub?.source_id);
  for (const m of cat?.models || []) add(m);
  const agentId = sub?.agent_id || sub?.source_id || sub?.plan_provider_id;
  const billing = accounts.direct_source_billing || {};
  const b = billing[agentId] || billing[sub?.source_id] || {};
  for (const m of b.models || []) add(m);
  if (b.pricing) for (const k of Object.keys(b.pricing)) add(k);
  const inst = (accounts.direct_source_instances || []).find(
    i => i.agent_id === agentId || i.source_id === sub?.source_id,
  );
  for (const m of inst?.models || []) add(m);
  if (inst?.pricing) for (const k of Object.keys(inst.pricing)) add(k);
  return names;
}

/** provider 维度权重（按请求次数） */
function providerUsageWeightByCalls(providers = {}, providerIds) {
  let calls = 0;
  for (const pid of providerIds) calls += providers[pid]?.calls || 0;
  return calls;
}

/** 将订阅月费摊到模型行：仅限登记模型，按该 provider 请求次数占比 */
function allocateSubscriptionToModels(out, sub, catalog, apiCatalog, accounts, days) {
  const subCost = subscriptionProrateUsd(sub.monthly_usd, days);
  if (subCost <= 0) return;
  const subModels = resolveSubscriptionModels(sub, catalog, apiCatalog, accounts);
  if (!subModels.size) return;

  const providerIds = resolveSubProviderIds(sub, catalog, apiCatalog);
  const weights = out.map(row => {
    if (!subModels.has(row.model)) return 0;
    return providerUsageWeightByCalls(row.providers || {}, providerIds);
  });
  const totalW = weights.reduce((s, w) => s + w, 0);

  if (totalW > 0) {
    for (let i = 0; i < out.length; i++) {
      if (weights[i] <= 0) continue;
      const share = subCost * (weights[i] / totalW);
      out[i].subscription_cost = (out[i].subscription_cost || 0) + share;
      out[i].cost_usd = out[i].payg_cost + out[i].subscription_cost;
    }
    return;
  }
  // 无调用：均摊到已登记且出现在统计中的模型
  const indices = out.map((_, i) => i).filter(i => subModels.has(out[i].model));
  if (!indices.length) return;
  const each = subCost / indices.length;
  for (const i of indices) {
    out[i].subscription_cost = (out[i].subscription_cost || 0) + each;
    out[i].cost_usd = out[i].payg_cost + out[i].subscription_cost;
  }
}

/** 将 API / 订阅转 API 月费按日折算后摊到各行（按 provider 用量占比） */
function allocateProviderSubscription(rows, getProviders, sub, catalog, apiCatalog, days, fallbackFilter) {
  if (!rows.length) return;
  const subCost = subscriptionProrateUsd(sub.monthly_usd, days);
  if (subCost <= 0) return;
  const providerIds = resolveSubProviderIds(sub, catalog, apiCatalog);
  const weights = rows.map(r => providerUsageWeightByCalls(getProviders(r), providerIds));
  const totalW = weights.reduce((s, w) => s + w, 0);

  if (totalW > 0) {
    for (let i = 0; i < rows.length; i++) {
      if (weights[i] <= 0) continue;
      const share = subCost * (weights[i] / totalW);
      rows[i].subscription_cost = (rows[i].subscription_cost || 0) + share;
      rows[i].cost = (rows[i].payg_cost ?? rows[i].cost ?? 0) + rows[i].subscription_cost;
      if (rows[i].cost_usd != null) rows[i].cost_usd = rows[i].cost;
    }
    return;
  }
  const indices = rows.map((_, i) => i).filter(fallbackFilter);
  const targets = indices.length ? indices : rows.map((_, i) => i);
  const each = subCost / targets.length;
  for (const i of targets) {
    rows[i].subscription_cost = (rows[i].subscription_cost || 0) + each;
    rows[i].cost = (rows[i].payg_cost ?? rows[i].cost ?? 0) + rows[i].subscription_cost;
    if (rows[i].cost_usd != null) rows[i].cost_usd = rows[i].cost;
  }
}

/**
 * 应用用量表费用 = 网关按量（payg）+ 订阅按日折算（App 全额；API 按 provider 用量摊薄）。
 */
export function enrichAppsUsageBilling(rows = [], subscriptions = [], days = 1, catalog = [], accounts = {}) {
  const apiCatalog = accounts.api_subscription_catalog || [];
  const out = (rows || []).map(r => {
    const payg = Number(r.cost) || 0;
    return { ...r, payg_cost: payg, subscription_cost: 0, cost: payg, providers: r.providers || {} };
  });

  const billable = (subscriptions || []).filter(isBillableSubscription);

  for (const sub of billable) {
    if (isProviderBasedSubscription(sub, catalog)) continue;
    const subCost = subscriptionProrateUsd(sub.monthly_usd, days);
    if (subCost <= 0) continue;

    for (let i = 0; i < out.length; i++) {
      if (!appMatchesSubscription(out[i], sub, catalog, apiCatalog)) continue;
      out[i].subscription_cost += subCost;
      out[i].cost = out[i].payg_cost + out[i].subscription_cost;
    }
  }

  for (const sub of billable) {
    if (!isProviderBasedSubscription(sub, catalog)) continue;
    allocateProviderSubscription(
      out, r => r.providers || {}, sub, catalog, apiCatalog, days,
      i => (out[i].proxyCalls || 0) > 0,
    );
  }

  // 已登记 App 直连订阅但统计期内无请求：仍展示按日折算
  const instances = accounts.direct_source_instances || [];
  const billing = accounts.direct_source_billing || {};
  for (const sub of billable) {
    if (isProviderBasedSubscription(sub, catalog)) continue;
    if (out.some(r => appMatchesSubscription(r, sub, catalog, apiCatalog))) continue;
    const agentId = sub.agent_id || sub.source_id;
    if (!agentId) continue;
    const subCost = subscriptionProrateUsd(sub.monthly_usd, days);
    if (subCost <= 0) continue;
    const inst = instances.find(i => i.agent_id === agentId || i.source_id === agentId);
    const b = billing[agentId] || billing[sub.source_id] || {};
    out.push({
      id: `billing-${agentId}`,
      name: sub.app_name || sub.name || inst?.name || inst?.label || b.name || agentId,
      icon: sub.app_icon || inst?.icon || '🖱',
      link_method: 'direct',
      agent_id: agentId,
      calls: 0,
      tokens: 0,
      proxyCalls: 0,
      sessionCalls: 0,
      proxyTokens: 0,
      sessionTokens: 0,
      payg_cost: 0,
      subscription_cost: subCost,
      cost: subCost,
    });
  }

  return out.sort((a, b) => (b.cost || 0) - (a.cost || 0) || (b.calls || 0) - (a.calls || 0));
}

/**
 * 模型费用排行：按量刊例价 + API / 订阅转 API 摊薄（仅限登记模型，按供给源请求次数）。
 */
export function enrichModelCostBilling(models = [], subscriptions = [], days = 1, catalog = [], accounts = {}) {
  const apiCatalog = accounts.api_subscription_catalog || [];
  const out = (models || []).map(m => ({
    ...m,
    payg_cost: Number(m.cost_usd) || 0,
    subscription_cost: 0,
    cost_usd: Number(m.cost_usd) || 0,
    providers: m.providers || {},
    provider_id: m.provider_id || null,
    provider_ids: m.provider_ids || Object.keys(m.providers || {}),
  }));

  const billable = (subscriptions || []).filter(s => isProviderBasedSubscription(s, catalog));
  for (const sub of billable) {
    allocateSubscriptionToModels(out, sub, catalog, apiCatalog, accounts, days);
  }

  return out
    .filter(m => (m.cost_usd || 0) > 0)
    .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));
}

/**
 * 合并个人页订阅 + 供给源直连计费（含 App / API 订阅月费）。
 */
export function resolveBillableSubscriptions(accounts = {}) {
  const {
    user_subscriptions = [],
    direct_source_billing = {},
    direct_source_instances = [],
  } = accounts;
  const out = [];
  const seen = new Set();

  const push = (entry) => {
    const key = entry.agent_id || entry.plan_provider_id || entry.gateway_id || entry.source_id || entry.id;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(entry);
  };

  for (const sub of user_subscriptions) {
    if (!isBillableSubscription(sub)) continue;
    push({
      ...sub,
      agent_id: sub.agent_id || sub.source_id,
    });
  }

  for (const inst of direct_source_instances) {
    if (!(Number(inst?.monthly_usd) > 0)) continue;
    push({
      id: inst.id || `direct-${inst.agent_id}`,
      agent_id: inst.agent_id,
      source_id: inst.source_id || inst.agent_id,
      plan_provider_id: inst.source_id || inst.agent_id,
      monthly_usd: inst.monthly_usd,
      subscription_kind: inst.mode === 'api' ? 'api' : 'app',
    });
  }

  for (const [agentId, b] of Object.entries(direct_source_billing)) {
    if (!b || typeof b !== 'object') continue;
    if (!(Number(b.monthly_usd) > 0)) continue;
    const mode = b.mode === 'api' ? 'api' : 'app';
    push({
      id: `direct-${agentId}`,
      agent_id: agentId,
      source_id: b.source_id || agentId,
      plan_provider_id: b.source_id || agentId,
      monthly_usd: b.monthly_usd,
      subscription_kind: mode === 'api' ? 'api' : 'app',
    });
  }

  return out;
}

function buildAgentSourceMap(agentSources = []) {
  const m = {};
  for (const a of agentSources) {
    if (!a?.source) continue;
    m[a.source] = {
      calls: (m[a.source]?.calls || 0) + (a.calls || 0),
      tokens: (m[a.source]?.tokens || 0) + (a.tokens || 0),
    };
  }
  return m;
}

function buildProviderStatsMap(providers = []) {
  const m = {};
  for (const p of providers) {
    const id = p.id || p.provider_id;
    if (!id) continue;
    if (!m[id]) m[id] = { calls: 0, tokens: 0, cost_usd: 0 };
    m[id].calls += p.calls || 0;
    m[id].tokens += p.tokens || 0;
    m[id].cost_usd += Number(p.cost_usd || p.cost || 0);
  }
  return m;
}

/** 从盘点 providers 列表汇总各 provider 的按量费用 */
export function buildProviderCostMap(providers = []) {
  return Object.fromEntries(
    Object.entries(buildProviderStatsMap(providers)).map(([id, s]) => [id, s.cost_usd]),
  );
}

/**
 * 盘点页费用：订阅月费按日折算 + 按量 API 刊例价（与个人页口径一致）。
 */
export function enrichDashboardBilling(stats, paygProviders = [], days = 1, subscriptions = [], catalog = []) {
  return enrichBillingCost(stats, subscriptions, paygProviders, days, catalog);
}

/** 汇总登记订阅的月费（USD） */
export function totalSubscriptionMonthlyUsd(subscriptions = []) {
  return (subscriptions || []).reduce((sum, s) => {
    const m = Number(s?.monthly_usd);
    return sum + (Number.isFinite(m) && m > 0 ? m : 0);
  }, 0);
}

/**
 * 趋势图费用叠加订阅：按所选时间窗均摊已折算的 subscription_cost。
 * - 今日 hourly：按 24 小时均摊
 * - 7/30 天 daily：按天数均摊到每个日历日
 */
export function enrichTrendWithSubscriptionCost(buckets, mode, subscriptionCost, days = 1) {
  if (!Array.isArray(buckets) || !buckets.length) return buckets;
  const subTotal = Number(subscriptionCost) || 0;
  if (subTotal <= 0) return buckets;
  const d = Math.max(1, Number(days) || 1);
  const perBucket = mode === 'hourly' ? subTotal / 24 : subTotal / d;
  return buckets.map(b => ({ ...b, cost_usd: (b.cost_usd || 0) + perBucket }));
}

/**
 * 费用估算 = 订阅月费按日折算 + 按量 API 刊例价用量。
 * @returns 带 subscription_cost / payg_cost / total_cost 及各行费用映射
 */
export function enrichBillingCost(stats, subscriptions = [], paygProviders = [], days = 1, catalog = []) {
  const providerStats = buildProviderStatsMap(stats?.providers || []);
  const providerCosts = Object.fromEntries(
    Object.entries(providerStats).map(([id, s]) => [id, s.cost_usd]),
  );
  const agentMap = buildAgentSourceMap(stats?.agent_sources || []);
  let subscriptionCost = 0;
  const subCostById = {};
  const subUsageById = {};
  for (const s of subscriptions || []) {
    if (!isBillableSubscription(s)) continue;
    const cost = subscriptionProrateUsd(s.monthly_usd, days);
    subCostById[s.id] = cost;
    subscriptionCost += cost;
    let calls = 0;
    let tokens = 0;
    for (const key of resolveSubSessionSources(s, catalog)) {
      calls += agentMap[key]?.calls || 0;
      tokens += agentMap[key]?.tokens || 0;
    }
    subUsageById[s.id] = { calls, tokens, cost };
  }

  let paygCost = 0;
  const paygCostById = {};
  const paygUsageById = {};
  for (const p of paygProviders || []) {
    const st = providerStats[p.provider_id] || { calls: 0, tokens: 0, cost_usd: 0 };
    const cost = st.cost_usd || 0;
    paygCostById[p.id] = cost;
    paygCost += cost;
    paygUsageById[p.id] = { calls: st.calls, tokens: st.tokens, cost };
  }

  // 兜底：未登记 payg 但 billing_type=api-key 的用量（若盘点有分项）
  const apiKeyExtra = Number(stats?.payg_usage_cost);
  if (apiKeyExtra > paygCost) paygCost = apiKeyExtra;

  const totalCost = subscriptionCost + paygCost;

  return {
    ...(stats || {}),
    subscription_cost: subscriptionCost,
    payg_cost: paygCost,
    total_cost: totalCost,
    usage_cost_legacy: Number(stats?.total_cost) || 0,
    sub_cost_by_id: subCostById,
    payg_cost_by_id: paygCostById,
    sub_usage_by_id: subUsageById,
    payg_usage_by_id: paygUsageById,
    provider_costs: providerCosts,
  };
}
