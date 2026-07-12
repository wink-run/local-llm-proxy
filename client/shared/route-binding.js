// 应用 route_id 绑定：场景路由 or tier:model（同模型跨层时区分 P2P / 付费 / 免费）
// Node/Electron/CLI 用本文件；Vite 前端见 src/lib/route-binding.js（逻辑需同步）
'use strict';

const TIER_ROUTE_RE = /^(free|p2p|paid):(.+)$/;

// ── 分层路由 codec：strategy:scope:tier:sharer:provider:model（各层可省，靠取值域判定归属）──
// 详见记忆 routing-codec-design。encode 恒按此固定顺序输出；parse「最后一段=model」+
// 前缀按取值域分类（strategy 集 / scope 集 / tier 集 / sharer 的 s_ 前缀 / 其余=provider）。
// scope=来源（personal 个人源 / community 社区），与 tier=价格（free/paid）正交、可组合。
const STRATEGY_NAMES = ['auto', 'cost', 'speed', 'round-robin', 'weighted', 'fallback', 'direct'];
const SCOPE_NAMES    = ['personal', 'community'];   // 来源维度（与 tier 价格维度正交）
const TIER_NAMES     = ['free', 'p2p', 'paid'];     // p2p 保留兼容旧数据；新数据社区走 scope
const SHARER_RE      = /^s_[a-z0-9]+$/i;   // 分享者化名句柄（服务端 user_id 带盐哈希）

const _STRAT_SET = new Set(STRATEGY_NAMES);
const _SCOPE_SET = new Set(SCOPE_NAMES);
const _TIER_SET  = new Set(TIER_NAMES);

/** 规范化编码：固定顺序 strategy:scope:tier:sharer:provider:model，空层跳过。 */
function encodeRoute(parts = {}) {
  const { strategy, scope, tier, sharer, provider, model } = parts;
  return [strategy, scope, tier, sharer, provider, model].filter(Boolean).join(':');
}

/**
 * 解析规范串 → { strategy, scope, tier, sharer, provider, model }（缺省为 null）。
 * 规则：最后一段永远是 model（单段时若命中 strategy/scope/tier/sharer 取值域则为纯前缀、无 model）；
 * 前导段按取值域分类，剩下未识别的单段作 provider。model 名不得含 ':'（见设计文档限制）。
 */
function parseRoute(str) {
  const out = { strategy: null, scope: null, tier: null, sharer: null, provider: null, model: null };
  const s = String(str == null ? '' : str).trim();
  if (!s) return out;
  const segs = s.split(':');
  if (segs.length === 1) {
    const seg = segs[0];
    if (_STRAT_SET.has(seg))      out.strategy = seg;
    else if (_SCOPE_SET.has(seg)) out.scope = seg;
    else if (_TIER_SET.has(seg))  out.tier = seg;
    else if (SHARER_RE.test(seg)) out.sharer = seg;
    else                          out.model = seg;
    return out;
  }
  out.model = segs[segs.length - 1];
  for (const seg of segs.slice(0, -1)) {
    if (_STRAT_SET.has(seg) && !out.strategy)      out.strategy = seg;
    else if (_SCOPE_SET.has(seg) && !out.scope)    out.scope = seg;
    else if (_TIER_SET.has(seg) && !out.tier)      out.tier = seg;
    else if (SHARER_RE.test(seg) && !out.sharer)   out.sharer = seg;
    else if (!out.provider)                        out.provider = seg;
  }
  return out;
}

function encodeTierModelRoute(tier, modelId) {
  if (!modelId) return '';
  if (!tier) return modelId;
  return `${tier}:${modelId}`;
}

/** 解析 route_id → { routeId, modelId, tier, isScene, scene? } */
function parseRouteBinding(routeId, routes = []) {
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

function modelIdFromRoute(routeId, routes = []) {
  const p = parseRouteBinding(routeId, routes);
  if (p.isScene) return '';
  return p.modelId || routeId || '';
}

/** 下拉框 value：场景路由用 model_key；单层模型用 tier:id；legacy 纯 id 尽量还原 */
function routeSelectValue(routeId, availableModels = [], routes = []) {
  if (!routeId) return '';
  const scene = routes.find(r => r.model_key === routeId || r.id === routeId);
  if (scene) return scene.model_key || routeId;
  if (TIER_ROUTE_RE.test(routeId)) return routeId;
  const matches = availableModels.filter(m => m.id === routeId);
  if (matches.length >= 1) {
    // 与网关 defaultRouteId 一致：同名模型优先社区 P2P，避免 legacy 纯 id 误显示为付费层
    const order = { p2p: 0, paid: 1, free: 2 };
    const pick = [...matches].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9))[0];
    return encodeTierModelRoute(pick.tier, routeId);
  }
  return routeId;
}

function isKnownRouteSelectValue(val, availableModels = [], routes = []) {
  if (!val) return false;
  if (routes.some(r => r.model_key === val || r.id === val)) return true;
  return availableModels.some(m => encodeTierModelRoute(m.tier, m.id) === val);
}

/** 按索引从 claude_models 列表取 Claude Desktop inferenceModels.name */
function claudeNameAtIndex(index, claudeModels = [], fallback = 'claude-sonnet-4-5') {
  if (!claudeModels.length) return fallback;
  return claudeModels[index % claudeModels.length] || fallback;
}

/** Claude Desktop 多路由：每个 claude-* 名 → 对应 route（与写入 inferenceModels 顺序一致） */
// keyScene 结构：{ [callerKey]: { [claude模型名]: scene } } —— 按「调用方 app key」分桶，
// 使多个 claude 应用（Desktop / 多个 CLI 实例）能各绑各的路由，互不覆盖。
function bindClaudeRoutesToKeyScene(keyScene, callerKey, routeIds, routes = [], claudeModels = []) {
  if (!callerKey || !Array.isArray(routeIds) || !routeIds.length) return;
  const sub = keyScene[callerKey] || (keyScene[callerKey] = {});
  routeIds.forEach((routeId, i) => {
    const claudeName = claudeNameAtIndex(i, claudeModels);
    bindRouteToKeyScene(sub, claudeName, routeId, routes);
  });
}

/** Claude Code CLI（shim 注入 api_key → 成 api-key 调用方）：客户端会发任意 claude-* 名
 * （claude-sonnet-4-5 / claude-haiku-4-5 …，且这些名字不受我们控制），把选中的单条 route
 * 绑到【所有】claude 客户端模型名上 —— 任何 claude-* 请求都命中该 route。
 * 与 Desktop（bindClaudeRoutesToKeyScene 按 inferenceModels.name 顺序 1:1 绑）不同：
 * Desktop 的名字列表由我们写入、与 route 一一对应；CLI 的名字由客户端决定，必须全绑。 */
function bindClaudeCliRouteToKeyScene(keyScene, callerKey, routeId, routes = [], claudeModels = []) {
  if (!callerKey || !routeId) return;
  const sub = keyScene[callerKey] || (keyScene[callerKey] = {});
  for (const name of claudeModels) bindRouteToKeyScene(sub, name, routeId, routes);
  // 通配兜底：Claude Code 会发列表外的后台/快速模型名（写死在客户端、随版本变，如
  // claude-3-5-haiku-20241022），全部映射到该 route，避免落到直连 404。网关对「claude-* 且无
  // 精确命中」的 api-key 调用方查 keyScene[key]['*']。Desktop 的绑定不写 '*'，故不受影响。
  bindRouteToKeyScene(sub, '*', routeId, routes);
}

/** 写入 keyScene（Electron main + CLI admin-api 共用） */
function bindRouteToKeyScene(keyScene, callerKey, routeId, routes = []) {
  const parsed = parseRouteBinding(routeId, routes);
  if (parsed.isScene && parsed.scene) {
    const route = parsed.scene;
    // 策略路由统一表示为单步 steps:[{strategy}]；兼容旧的 route-level strategy（无 steps）。
    const steps = route.steps?.length
      ? route.steps
      : (route.strategy ? [{ strategy: route.strategy }] : []);
    keyScene[callerKey] = {
      steps,
      scene_name: route.scene_name,
      rules: route.rules || null,
      classifier: route.classifier || null,
      flow: route.flow || null,
      // 路由级过滤（收费源/免费源/个人源/社区源）——不带上 scope/tier，网关就丢了过滤，
      // 策略/过滤路由（steps 为空）会退化成无差别扫全部候选。与 routerMap 分支保持一致。
      ...(route.scope ? { scope: route.scope } : {}),
      ...(route.tier ? { tier: route.tier } : {}),
    };
    return;
  }
  const modelId = parsed.modelId || routeId;
  keyScene[callerKey] = {
    steps: [{ model: modelId, ...(parsed.tier ? { tier: parsed.tier } : {}) }],
    scene_name: modelId,
    rules: null,
    classifier: null,
  };
}

module.exports = {
  TIER_ROUTE_RE,
  STRATEGY_NAMES,
  SCOPE_NAMES,
  TIER_NAMES,
  SHARER_RE,
  encodeRoute,
  parseRoute,
  encodeTierModelRoute,
  parseRouteBinding,
  modelIdFromRoute,
  routeSelectValue,
  isKnownRouteSelectValue,
  claudeNameAtIndex,
  bindClaudeRoutesToKeyScene,
  bindClaudeCliRouteToKeyScene,
  bindRouteToKeyScene,
};
