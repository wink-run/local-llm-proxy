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

/** agent_id → 会话 data_source 列表（用量归属） */
const AGENT_SESSION_SOURCES = {
  'claude-code': ['session-claude', 'session-claude-desktop'],
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
 * 盘点页费用口径：仅按量 api-key + provider 刊例价（无刊例价计 0），不含订阅月费折算。
 */
export function enrichDashboardBilling(stats, paygProviders = [], days = 1) {
  const billing = enrichBillingCost(stats, [], paygProviders, days);
  return {
    ...(stats || {}),
    payg_cost: billing.payg_cost,
    subscription_cost: 0,
    total_cost: billing.payg_cost,
  };
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
