// 与供给源页「按模型视图」一致的可用模型列表（网关应用路由下拉复用）

const OAUTH_SUB_SOURCE_TO_PID = { claude: 'anthropic-paid', codex: 'openai', copilot: 'github-copilot' };

function modelEntryName(m) {
  if (typeof m === 'string') return m.trim();
  return String(m?.name || m?.id || '').trim();
}

function paygInstGatewayId(p) {
  return (p && p.gateway_id) || p?.provider_id || null;
}

function subInstGatewayId(s) {
  if (s?.gateway_id) return s.gateway_id;
  if (s.custom) return s.source_id || s.plan_provider_id || null;
  if (s.subscription_kind === 'api') return s.plan_provider_id || s.source_id || null;
  if (!s.subscription_to_api) return null;
  return OAUTH_SUB_SOURCE_TO_PID[s.source_id] || s.plan_provider_id || s.source_id;
}

/** 与 Providers.jsx resolveModelsForModelView 保持一致 */
function resolveModelsForModelView(inst, providers, userPayg, userSubscriptions, pricingOverrides, directByAgent) {
  const fromArr = (arr) => (arr || []).map(modelEntryName).filter(Boolean);
  if (inst.kind === 'payg') {
    const p = userPayg.find(x => x.id === inst.id);
    const names = new Set(fromArr(p?.models));
    const prov = providers.find(x => x.id === inst.gateway_id);
    for (const n of fromArr(prov?.models)) names.add(n);
    const pid = p?.provider_id || inst.source_id;
    for (const k of Object.keys(pricingOverrides?.[pid] || {})) if (k) names.add(k);
    return [...names];
  }
  if (inst.kind === 'sub') {
    if (inst.tag === 'app_sub') return [];
    const prov = providers.find(x => x.id === inst.gateway_id);
    const names = new Set(fromArr(prov?.models));
    const subRec = userSubscriptions.find(s => s.id === inst.id);
    const pid = subRec?.plan_provider_id || OAUTH_SUB_SOURCE_TO_PID[inst.source_id] || inst.source_id;
    for (const k of Object.keys(pricingOverrides?.[pid] || {})) if (k) names.add(k);
    return [...names];
  }
  if (inst.kind === 'direct') {
    const d = directByAgent[inst.id];
    if (!d || d.mode !== 'api') return [];
    const fromPricing = Object.keys(d.pricing || {}).filter(Boolean);
    if (fromPricing.length) return fromPricing;
    return fromArr(d.models);
  }
  return [];
}

function subTag(s) {
  if (s.subscription_kind === 'api') return 'api_sub';
  if (s.subscription_to_api) return 'sub_to_api';
  return 'app_sub';
}

function buildAccountInstances(accounts) {
  const userPayg = accounts?.user_payg_providers || [];
  const userSubs = accounts?.user_subscriptions || [];
  const directBilling = accounts?.direct_source_billing || {};
  const instances = [
    ...userSubs.map(s => ({
      kind: 'sub',
      id: s.id,
      source_id: s.source_id,
      gateway_id: subInstGatewayId(s),
      tag: subTag(s),
    })),
    ...userPayg.map(p => ({
      kind: 'payg',
      id: p.id,
      source_id: p.provider_id,
      gateway_id: paygInstGatewayId(p),
    })),
    ...Object.entries(directBilling).map(([agentId, d]) => ({
      kind: 'direct',
      id: agentId,
      source_id: d?.source_id || agentId,
      gateway_id: null,
    })),
  ];
  return { instances, userPayg, userSubs, directBilling };
}

function tierForInstance(inst, providers) {
  const provById = Object.fromEntries((providers || []).map(p => [p.id, p]));
  const gwId = inst.gateway_id;
  if (gwId && provById[gwId]) {
    return provById[gwId].type === 'free' ? 'free' : 'paid';
  }
  // 直连或未挂 provider 的登记模型，归入付费层
  return 'paid';
}

/**
 * 收集个人源可用模型（与供给源页 PersonalSourceModelView 同源）
 * @returns {Array<{ id: string, tier: 'free'|'paid' }>}
 */
export function collectPersonalAvailableModels(cfg = {}, accounts = {}) {
  const providers = cfg?.providers || [];
  const pricingOverrides = cfg?.provider_pricing_overrides || {};
  const { instances, userPayg, userSubs, directBilling } = buildAccountInstances(accounts);
  const out = [];
  const seen = new Set();

  for (const inst of instances) {
    const models = resolveModelsForModelView(
      inst, providers, userPayg, userSubs, pricingOverrides, directBilling,
    );
    const tier = tierForInstance(inst, providers);
    for (const id of models) {
      const k = `${tier}:${id}`;
      if (!id || seen.has(k)) continue;
      seen.add(k);
      out.push({ id, tier });
    }
  }
  return out;
}

/** 合并账户/刊例价模型到 provider（与 billing-config.enrichProvidersFromAccounts 一致） */
export function enrichProvidersForRouting(providers = [], accounts = {}) {
  const pricingOvr = accounts.provider_pricing_overrides || {};
  const userPayg = accounts.user_payg_providers || [];
  const userSubs = accounts.user_subscriptions || [];

  function extraNames(gatewayId) {
    const names = new Set();
    if (!gatewayId) return names;
    for (const p of userPayg) {
      if (paygInstGatewayId(p) !== gatewayId) continue;
      for (const m of p.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      for (const k of Object.keys(pricingOvr[p.provider_id] || {})) if (k) names.add(k);
    }
    for (const s of userSubs) {
      if (subInstGatewayId(s) !== gatewayId) continue;
      const isApi = s.subscription_kind === 'api' || s.subscription_to_api;
      if (!isApi) continue;
      const pid = s.plan_provider_id || OAUTH_SUB_SOURCE_TO_PID[s.source_id] || s.source_id;
      for (const k of Object.keys(pricingOvr[pid] || {})) if (k) names.add(k);
    }
    for (const k of Object.keys(pricingOvr[gatewayId] || {})) if (k) names.add(k);
    return names;
  }

  return providers.map(p => {
    const extra = extraNames(p.id);
    if (!extra.size) return p;
    const names = new Set((p.models || []).map(modelEntryName).filter(Boolean));
    for (const n of extra) names.add(n);
    return {
      ...p,
      models: [...names].sort().map(name => {
        const prev = (p.models || []).find(m => modelEntryName(m) === name);
        return prev && typeof prev === 'object' ? prev : { name, type: 'chat' };
      }),
    };
  });
}

function providerCanServeModel(provider, modelId, gatewayIds) {
  const active = provider?.enabled || (gatewayIds && gatewayIds.has(provider?.id));
  if (!active || !provider?.base_url || provider.type === 'p2p') return false;
  const list = provider.models || [];
  if (!list.length) return true;
  return list.some(m => modelEntryName(m) === modelId);
}

/** 仅保留已启用供给源可路由的模型（避免下拉可选但请求失败） */
export function filterRoutablePersonalModels(entries, providers = [], gatewayIds = null) {
  const gwSet = gatewayIds instanceof Set ? gatewayIds : null;
  return entries.filter(({ id, tier }) =>
    providers.some(p => {
      if (tier === 'free' && p.type !== 'free') return false;
      if (tier === 'paid' && p.type !== 'free' && p.type !== 'paid') return false;
      return providerCanServeModel(p, id, gwSet);
    }),
  );
}
