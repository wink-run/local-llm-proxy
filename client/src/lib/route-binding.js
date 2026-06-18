// 前端 ESM 入口（逻辑与 shared/route-binding.js 保持同步）
// 应用 route_id 绑定：场景路由 or tier:model（同模型跨层时区分 P2P / 付费 / 免费）

const TIER_ROUTE_RE = /^(free|p2p|paid):(.+)$/;

export function encodeTierModelRoute(tier, modelId) {
  if (!modelId) return '';
  if (!tier) return modelId;
  return `${tier}:${modelId}`;
}

/** 解析 route_id → { routeId, modelId, tier, isScene, scene? } */
export function parseRouteBinding(routeId, routes = []) {
  if (!routeId) {
    return { routeId: '', modelId: '', tier: null, isScene: false, scene: null };
  }
  const scene = routes.find(r => r.model_key === routeId || r.id === routeId);
  if (scene) {
    return { routeId, modelId: '', tier: null, isScene: true, scene };
  }
  const m = TIER_ROUTE_RE.exec(routeId);
  if (m) {
    return { routeId, modelId: m[2], tier: m[1], isScene: false, scene: null };
  }
  return { routeId, modelId: routeId, tier: null, isScene: false, scene: null };
}

export function modelIdFromRoute(routeId, routes = []) {
  const p = parseRouteBinding(routeId, routes);
  if (p.isScene) return '';
  return p.modelId || routeId || '';
}

/** 下拉框 value：场景路由用 model_key；单层模型用 tier:id；legacy 纯 id 尽量还原 */
export function routeSelectValue(routeId, availableModels = [], routes = []) {
  if (!routeId) return '';
  if (routes.some(r => r.model_key === routeId || r.id === routeId)) return routeId;
  if (TIER_ROUTE_RE.test(routeId)) return routeId;
  const matches = availableModels.filter(m => m.id === routeId);
  if (matches.length >= 1) {
    const order = { paid: 0, p2p: 1, free: 2 };
    const pick = [...matches].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9))[0];
    return encodeTierModelRoute(pick.tier, routeId);
  }
  return routeId;
}

export function isKnownRouteSelectValue(val, availableModels = [], routes = []) {
  if (!val) return false;
  if (routes.some(r => r.model_key === val || r.id === val)) return true;
  return availableModels.some(m => encodeTierModelRoute(m.tier, m.id) === val);
}
