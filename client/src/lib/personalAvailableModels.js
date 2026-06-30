// 与供给源页「按模型视图」一致的可用模型列表（网关应用路由下拉复用）

const OAUTH_SUB_SOURCE_TO_PID = { claude: 'anthropic-paid', codex: 'openai', copilot: 'github-copilot' };
const PRICING_OVERRIDE_META_KEYS = new Set(['_excluded_models']);

function isValidModelName(name) {
  const n = String(name || '').trim();
  return !!n && !PRICING_OVERRIDE_META_KEYS.has(n) && n !== 'excluded_models';
}

function modelEntryName(m) {
  if (typeof m === 'string') return isValidModelName(m) ? m.trim() : '';
  const n = String(m?.name || m?.id || '').trim();
  return isValidModelName(n) ? n : '';
}

function instanceExcludedSet(inst, userPayg, userSubs) {
  if (inst?.kind === 'payg') {
    const p = userPayg.find(x => x.id === inst.id);
    return new Set((p?.excluded_models || []).filter(isValidModelName));
  }
  if (inst?.kind === 'sub') {
    const s = userSubs.find(x => x.id === inst.id);
    return new Set((s?.excluded_models || []).filter(isValidModelName));
  }
  return new Set();
}

function finalizeModelNames(names, excluded = new Set()) {
  return [...names].filter(n => isValidModelName(n) && !excluded.has(n));
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

/** 与供给源页计费表格 modelNames 一致：网关模型 + 账户模型 + 可选刊例价覆盖 */
export function resolveModelsForModelView(
  inst, providers, userPayg, userSubscriptions, pricingOverrides, directByAgent, providerPricing = {},
  { includeCatalogPricing = false } = {},
) {
  const fromArr = (arr) => (arr || []).map(modelEntryName).filter(Boolean);
  const addPricingKeys = (names, pid) => {
    if (!pid) return;
    for (const k of Object.keys(pricingOverrides?.[pid] || {})) {
      if (isValidModelName(k)) names.add(k);
    }
    if (includeCatalogPricing) {
      for (const k of Object.keys(providerPricing?.[pid] || {})) {
        if (isValidModelName(k)) names.add(k);
      }
    }
  };

  const excluded = instanceExcludedSet(inst, userPayg, userSubscriptions);

  if (inst.kind === 'payg') {
    const p = userPayg.find(x => x.id === inst.id);
    const names = new Set(fromArr(p?.models));
    const prov = providers.find(x => x.id === inst.gateway_id);
    for (const n of fromArr(prov?.models)) names.add(n);
    for (const n of fromArr(inst?.models)) names.add(n);
    addPricingKeys(names, p?.provider_id || inst.source_id);
    return finalizeModelNames(names, excluded);
  }
  if (inst.kind === 'sub') {
    if (inst.tag === 'app_sub') return [];
    const prov = providers.find(x => x.id === inst.gateway_id);
    const names = new Set(fromArr(prov?.models));
    for (const n of fromArr(inst?.models)) names.add(n);
    const subRec = userSubscriptions.find(s => s.id === inst.id);
    const pid = subRec?.plan_provider_id || OAUTH_SUB_SOURCE_TO_PID[inst.source_id] || inst.source_id;
    addPricingKeys(names, pid);
    return finalizeModelNames(names, excluded);
  }
  if (inst.kind === 'direct') {
    const d = directByAgent[inst.id];
    if (!d || d.mode !== 'api') return [];
    const fromPricing = Object.keys(d.pricing || {}).filter(isValidModelName);
    if (fromPricing.length) return finalizeModelNames(fromPricing, excluded);
    return finalizeModelNames(fromArr(d.models), excluded);
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
  const providerPricing = cfg?.provider_pricing || {};
  const { instances, userPayg, userSubs, directBilling } = buildAccountInstances(accounts);
  const out = [];
  const seen = new Set();

  for (const inst of instances) {
    const models = resolveModelsForModelView(
      inst, providers, userPayg, userSubs, pricingOverrides, directBilling, providerPricing,
    );
    const tier = tierForInstance(inst, providers);
    for (const id of models) {
      if (!isValidModelName(id)) continue;
      const k = `${tier}:${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id, tier });
    }
  }
  return out;
}

/** 合并账户模型到 provider（路由校验用；不含刊例价目录，避免下拉出现未配置模型） */
export function enrichProvidersForRouting(providers = [], accounts = {}) {
  const pricingOvr = accounts.provider_pricing_overrides || {};
  const userPayg = accounts.user_payg_providers || [];
  const userSubs = accounts.user_subscriptions || [];

  function addOverrideKeys(names, pid) {
    if (!pid) return;
    for (const k of Object.keys(pricingOvr[pid] || {})) {
      if (isValidModelName(k)) names.add(k);
    }
  }

  function extraNames(gatewayId) {
    const names = new Set();
    if (!gatewayId) return names;
    for (const p of userPayg) {
      if (paygInstGatewayId(p) !== gatewayId) continue;
      for (const m of p.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      addOverrideKeys(names, p.provider_id);
    }
    for (const s of userSubs) {
      if (subInstGatewayId(s) !== gatewayId) continue;
      const isApi = s.subscription_kind === 'api' || s.subscription_to_api;
      if (!isApi) continue;
      const pid = s.plan_provider_id || OAUTH_SUB_SOURCE_TO_PID[s.source_id] || s.source_id;
      addOverrideKeys(names, pid);
    }
    addOverrideKeys(names, gatewayId);
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
