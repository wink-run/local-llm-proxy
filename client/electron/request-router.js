// client/electron/request-router.js
// 三层特征提取 + 规则匹配 + 策略组调度。
// 从 config-loader 读 routing.rules + feature_extraction（yaml 控制），
// 从 local-config 读 policies[]（UI 控制）。
// 返回 "本次请求应该用哪些 provider + 什么 strategy"，供 route() 执行。
'use strict';

const configLoader = require('./config-loader');

// ── 圆状态（latency 策略用，内存，重启清零）──────────────────────────────────
const _latencyMap  = new Map();   // providerId → 平均延迟 ms
const _rrIndex     = new Map();   // policyId → 当前轮询下标

// ── 第一层：请求元数据特征提取（零开销）──────────────────────────────────────
function extractMetadata(body, callerKey, reqPath) {
  const model       = body.model || '';
  const modelFamily = model.split(/[-/]/)[0].toLowerCase();
  return {
    // 第一层
    protocol:    reqPath === '/v1/messages' ? 'anthropic'
               : (reqPath === '/v1/responses' || reqPath === '/responses') ? 'responses'
               : 'openai',
    agent_id:    callerKey || null,
    model,
    model_family: modelFamily,
    stream:      !!body.stream,
    path:        reqPath,
  };
}

// ── 第二层：请求结构特征（读 body，极低开销）─────────────────────────────────
function extractStructure(body, featureCfg) {
  if (!featureCfg.structure) return {};
  const messages = body.messages || body.input || [];
  const msgs     = Array.isArray(messages) ? messages : [];
  const lastUser = [...msgs].reverse().find(m => m.role === 'user' || m.type === 'message');

  // context_length
  let contextLength = 0;
  if (featureCfg.context_length_mode === 'chars') {
    const text = msgs.map(m => typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : '').join('');
    contextLength = Math.floor(text.length / 4);
  }

  return {
    // 第二层
    has_tools:        !!(body.tools && body.tools.length > 0),
    has_system:       !!(body.system || msgs.some(m => m.role === 'system' || m.role === 'developer')),
    message_count:    msgs.length,
    context_length:   contextLength,
    last_message_type: lastUser ? (lastUser.role || lastUser.type || 'user') : null,
  };
}

// ── 第三层：内容语义（关键词 pattern，低开销）────────────────────────────────
function extractSemantic(body, featureCfg) {
  if (!featureCfg.semantic) return {};
  const messages = body.messages || body.input || [];
  const msgs     = Array.isArray(messages) ? messages : [];

  // 只看 last_user_message（不扫全量历史）
  const scope = featureCfg.semantic_scope || 'last_user_message';
  let text = '';
  if (scope === 'last_user_message') {
    const last = [...msgs].reverse().find(m => m.role === 'user' || m.type === 'message');
    text = last ? (typeof last.content === 'string' ? last.content
      : Array.isArray(last.content) ? last.content.map(p => p.text || '').join('') : '') : '';
    if (body.input && typeof body.input === 'string') text = text || body.input;
  } else {
    text = msgs.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
  }

  const keywords = featureCfg.code_keywords || [];
  const hasCode  = keywords.some(kw => text.includes(kw));

  return {
    // 第三层
    task_type: hasCode ? 'code' : 'chat',
    has_code:  hasCode,
    language:  /[一-鿿]/.test(text) ? 'zh' : 'en',
  };
}

// ── 特征合并 ──────────────────────────────────────────────────────────────────
function extractFeatures(body, callerKey, reqPath) {
  const routing    = configLoader.routing() || {};
  const featureCfg = routing.feature_extraction || { metadata: true, structure: true, semantic: true };
  return {
    ...extractMetadata(body, callerKey, reqPath),
    ...extractStructure(body, featureCfg),
    ...extractSemantic(body, featureCfg),
  };
}

// ── 规则匹配（按优先级从上到下，第一个命中生效）─────────────────────────────
function matchValue(feat, key, expected) {
  const actual = feat[key];
  if (expected === null || expected === undefined) return true;
  // 范围: { gt, lt, gte, lte }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (expected.gt  !== undefined && !(actual >  expected.gt))  return false;
    if (expected.lt  !== undefined && !(actual <  expected.lt))  return false;
    if (expected.gte !== undefined && !(actual >= expected.gte)) return false;
    if (expected.lte !== undefined && !(actual <= expected.lte)) return false;
    return true;
  }
  // 数组：任一匹配
  if (Array.isArray(expected)) return expected.includes(actual);
  // 布尔 / 精确值
  return actual === expected;
}

function matchRule(feat, match) {
  if (!match || Object.keys(match).length === 0) return true;   // {} 匹配所有
  return Object.entries(match).every(([k, v]) => matchValue(feat, k, v));
}

function resolvePolicy(feat, rules) {
  for (const rule of (rules || [])) {
    if (matchRule(feat, rule.match)) {
      return rule.policy;   // string（policy id）或 inline object
    }
  }
  return 'default-policy';
}

// ── 策略执行：从 local-config.policies 选 provider 列表 + 排序 ──────────────
// 返回 { providerIds: string[], strategy: string }
function selectProviders(policyRef, getLocalConfig) {
  let policyObj = null;

  // inline policy（yaml rule 里直接写的 { strategy, providers }）
  if (policyRef && typeof policyRef === 'object') {
    policyObj = policyRef;
  } else if (typeof policyRef === 'string') {
    const cfg = getLocalConfig ? getLocalConfig() : {};
    const policies = cfg.policies || [];
    policyObj = policies.find(p => p.id === policyRef) || null;
  }

  if (!policyObj) {
    // policy 未找到：回退到"用所有 enabled providers，fallback 策略"
    return { providerIds: [], strategy: 'fallback', fallthrough: true };
  }

  const strategy   = policyObj.strategy || 'fallback';
  const rawProviders = (policyObj.providers || []);
  // 支持 {id, weight} 或 字符串
  const entries = rawProviders.map(p => typeof p === 'string' ? { id: p, weight: 1 } : p);
  const ids     = entries.map(e => e.id).filter(Boolean);

  if (ids.length === 0) return { providerIds: [], strategy, fallthrough: true };

  switch (strategy) {
    case 'round-robin': {
      const key = typeof policyRef === 'string' ? policyRef : 'inline';
      const idx = (_rrIndex.get(key) || 0) % ids.length;
      _rrIndex.set(key, idx + 1);
      // 从 idx 开始排列（round-robin 首选，其余按顺序备用）
      return { providerIds: [...ids.slice(idx), ...ids.slice(0, idx)], strategy };
    }
    case 'weighted': {
      // 加权随机选首选，其余作故障转移
      const total = entries.reduce((s, e) => s + (e.weight || 1), 0);
      let rand = Math.random() * total;
      let chosen = entries[entries.length - 1];
      for (const e of entries) { rand -= (e.weight || 1); if (rand <= 0) { chosen = e; break; } }
      const rest = ids.filter(id => id !== chosen.id);
      return { providerIds: [chosen.id, ...rest], strategy };
    }
    case 'latency': {
      // 按历史延迟排序（没有记录的排最后）
      const sorted = [...ids].sort((a, b) =>
        (_latencyMap.get(a) || Infinity) - (_latencyMap.get(b) || Infinity));
      return { providerIds: sorted, strategy };
    }
    case 'direct':
      return { providerIds: [ids[0]], strategy };    // 只用第一个，不故障转移
    case 'fallback':
    default:
      return { providerIds: ids, strategy };
  }
}

// ── 更新延迟记录（由 route 完成时回调）──────────────────────────────────────
function recordLatency(providerId, latencyMs) {
  const prev = _latencyMap.get(providerId);
  // 指数移动平均（α=0.3）
  _latencyMap.set(providerId, prev == null ? latencyMs : Math.round(prev * 0.7 + latencyMs * 0.3));
}

// ── 主入口：给定请求，返回应该用的 provider id 列表（已按策略排序）──────────
// getLocalConfig: () => local-config 对象（由 main.js 注入）
function resolveProviderOrder(body, callerKey, reqPath, getLocalConfig) {
  const routing = configLoader.routing() || {};
  const rules   = routing.rules || [];
  const feat    = extractFeatures(body, callerKey, reqPath);
  const policyRef = resolvePolicy(feat, rules);
  const { providerIds, strategy, fallthrough } = selectProviders(policyRef, getLocalConfig);
  return { providerIds, strategy, fallthrough, features: feat, policyRef };
}

module.exports = { resolveProviderOrder, recordLatency, extractFeatures, _internal: { matchRule, selectProviders } };
