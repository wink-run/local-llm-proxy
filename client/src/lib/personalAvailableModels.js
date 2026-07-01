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

function configuredModelsFromOverrides(pricingPid, pricingOverrides) {
  const names = [];
  if (!pricingPid || !pricingOverrides) return names;
  for (const k of Object.keys(pricingOverrides[pricingPid] || {})) {
    if (isValidModelName(k)) names.push(k);
  }
  return names;
}

/**
 * 模型视图：仅展示用户在账户/供给源卡片上显式添加的模型。
 * 来源 = 账户实例 models + 用户自定义刊例价（provider_pricing_overrides），不含 catalog 全量。
 */
export function resolveModelsForModelView(
  inst, providers, userPayg, userSubscriptions, pricingOverrides, directByAgent,
) {
  const fromArr = (arr) => (arr || []).map(modelEntryName).filter(Boolean);
  const excluded = instanceExcludedSet(inst, userPayg, userSubscriptions);

  if (inst.kind === 'payg') {
    const p = userPayg.find(x => x.id === inst.id);
    const pricingPid = p?.provider_id || inst.source_id;
    const names = new Set([
      ...fromArr(p?.models),
      ...configuredModelsFromOverrides(pricingPid, pricingOverrides),
    ]);
    return finalizeModelNames(names, excluded);
  }
  if (inst.kind === 'sub') {
    if (inst.tag === 'app_sub') return [];
    const s = userSubscriptions.find(x => x.id === inst.id);
    const pricingPid = s?.plan_provider_id
      || OAUTH_SUB_SOURCE_TO_PID[s?.source_id]
      || s?.source_id
      || inst.source_id;
    const names = new Set([
      ...fromArr(s?.models),
      ...configuredModelsFromOverrides(pricingPid, pricingOverrides),
    ]);
    return finalizeModelNames(names, excluded);
  }
  if (inst.kind === 'direct') {
    const d = directByAgent[inst.id];
    if (!d || d.mode !== 'api') return [];
    return finalizeModelNames(new Set(fromArr(d.models)), excluded);
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
  return 'paid';
}

/** 账户登记的全部 gateway provider id（含未写 gateway_id 的订阅回退逻辑） */
export function buildGatewayIdsFromAccounts(accounts = {}) {
  const ids = new Set(accounts.gateway_provider_ids || []);
  for (const p of accounts.user_payg_providers || []) {
    const gid = paygInstGatewayId(p);
    if (gid) ids.add(gid);
  }
  for (const s of accounts.user_subscriptions || []) {
    const gid = subInstGatewayId(s);
    if (gid) ids.add(gid);
  }
  return ids;
}

/**
 * 合并 cfg + accounts 为网关路由用的账户快照（刊例价覆盖以 local-config 为准）
 */
export function mergeAccountsForGateway(cfg = {}, accounts = {}) {
  return {
    ...(accounts || {}),
    provider_pricing_overrides: {
      ...(accounts?.provider_pricing_overrides || {}),
      ...(cfg?.provider_pricing_overrides || {}),
    },
  };
}

/**
 * 收集个人源可用模型（与供给源页 PersonalSourceModelView 同源）
 * @returns {Array<{ id: string, tier: 'free'|'paid' }>}
 */
export function collectPersonalAvailableModels(cfg = {}, accounts = {}) {
  const providers = cfg?.providers || [];
  // 刊例价覆盖存于 local-config（accounts），agent config 可能未同步
  const pricingOverrides = {
    ...(accounts?.provider_pricing_overrides || {}),
    ...(cfg?.provider_pricing_overrides || {}),
  };
  const { instances, userPayg, userSubs, directBilling } = buildAccountInstances(accounts);
  const out = [];
  const seen = new Set();

  for (const inst of instances) {
    const models = resolveModelsForModelView(
      inst, providers, userPayg, userSubs, pricingOverrides, directBilling,
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
  const userPayg = accounts.user_payg_providers || [];
  const userSubs = accounts.user_subscriptions || [];
  const pricingOverrides = accounts.provider_pricing_overrides || {};

  function extraNames(gatewayId) {
    const names = new Set();
    if (!gatewayId) return names;
    for (const p of userPayg) {
      if (paygInstGatewayId(p) !== gatewayId) continue;
      for (const m of p.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      for (const k of configuredModelsFromOverrides(p.provider_id, pricingOverrides)) names.add(k);
    }
    for (const s of userSubs) {
      if (subInstGatewayId(s) !== gatewayId) continue;
      const isApi = s.subscription_kind === 'api' || s.subscription_to_api;
      if (!isApi) continue;
      for (const m of s.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      const pid = s.plan_provider_id || OAUTH_SUB_SOURCE_TO_PID[s.source_id] || s.source_id;
      for (const k of configuredModelsFromOverrides(pid, pricingOverrides)) names.add(k);
    }
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
