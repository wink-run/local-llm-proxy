// app-handlers.js — 客户端内置应用 handler 展开（与 server/app_handlers.py 逻辑对齐）
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { parseRouteBinding, claudeNameAtIndex } = require('../shared/route-binding');

const HANDLERS_YAML = path.join(__dirname, 'config', 'app-handlers.yaml');
const SCANS_YAML = path.join(__dirname, 'config', 'session-scans.yaml');
const OPS_YAML = path.join(__dirname, 'config', 'handler-ops.yaml');
const CAP_KEYS = ['gateway_proxy', 'session_trace', 'session_usage_import', 'resource_project'];

/** 应用实体身份别名：共用同一配置/会话的入口归一（列表与下发不重复） */
const APP_ENTITY_ALIASES = {
  'codex-desktop': 'codex',
};

/** 归一应用实体 id（Codex Desktop 与 CLI 都归为 codex） */
function canonicalAppEntityId(id) {
  const raw = String(id || '').trim();
  if (!raw) return raw;
  return APP_ENTITY_ALIASES[raw] || raw;
}

let _doc = null;
let _scansBuiltin = null;
let _cloudScans = null;   // GET /config/apps 下发的 session_scans 覆盖/扩展
let _cloudHandlers = null; // 云端 handler 定义（客户端无预置时可用）
let _ops = null;

function loadDoc() {
  if (_doc) return _doc;
  try {
    _doc = yaml.load(fs.readFileSync(HANDLERS_YAML, 'utf8')) || {};
  } catch {
    _doc = { handlers: {}, default_entities: [] };
  }
  _doc.handlers = _doc.handlers || {};
  return _doc;
}

/** 内置 session-scans.yaml（离线回退） */
function loadBuiltinScans() {
  if (_scansBuiltin) return _scansBuiltin;
  try {
    const doc = yaml.load(fs.readFileSync(SCANS_YAML, 'utf8')) || {};
    _scansBuiltin = doc.scans || {};
  } catch {
    _scansBuiltin = {};
  }
  return _scansBuiltin;
}

/** 合并内置 + 云端 session_scans；Claude 纳管场景下 sdk-cli/cli 须参与补录（靠 request_id 与 proxy 去重） */
function normalizeClaudeSessionScan(scan) {
  if (!scan || typeof scan !== 'object' || !scan.proxy_dedup) return scan;
  const out = { ...scan };
  const dsm = { ...(out.data_source_map || {}) };
  dsm.map = {
    ...(dsm.map || {}),
    'sdk-cli': 'session-claude',
    'sdk-ts': 'session-claude',
    cli: 'session-claude',
  };
  dsm.skip = (Array.isArray(dsm.skip) ? dsm.skip : []).filter(
    (ep) => ep !== 'sdk-cli' && ep !== 'sdk-ts' && ep !== 'cli',
  );
  out.data_source_map = dsm;
  return out;
}

function sessionScansById() {
  const merged = { ...loadBuiltinScans(), ...(_cloudScans || {}) };
  if (merged.claude) merged.claude = normalizeClaudeSessionScan(merged.claude);
  return merged;
}

/**
 * 应用云端 config.apps 中的 handlers / session_scans（发布目录时写入 tokenbank.yaml）。
 * 调用后需由 config-loader 清空 _appsRuntime。
 */
function applyCloudConfig(doc) {
  if (!doc || typeof doc !== 'object') {
    _cloudScans = null;
    _cloudHandlers = null;
    return;
  }
  _cloudScans = (doc.session_scans && typeof doc.session_scans === 'object') ? doc.session_scans : null;
  _cloudHandlers = (doc.handlers && typeof doc.handlers === 'object') ? doc.handlers : null;
}

/** 内置 + 云端 handler 表 */
function handlersMap() {
  const base = loadDoc().handlers || {};
  if (!_cloudHandlers) return base;
  const out = { ...base };
  for (const [id, h] of Object.entries(_cloudHandlers)) {
    const merged = { ...(base[id] || {}), ...h };
    // capabilities 取并集：避免旧版云端快照缺新能力位（如 resource_project）冲掉内置默认
    const baseCaps = Array.isArray(base[id]?.capabilities) ? base[id].capabilities : [];
    const cloudCaps = Array.isArray(h?.capabilities) ? h.capabilities : [];
    if (baseCaps.length || cloudCaps.length) {
      merged.capabilities = [...new Set([...baseCaps, ...cloudCaps])];
    }
    // session 深合并：云端旧快照缺 source_id 时保留内置（Codex Desktop→codex scan）
    if (base[id]?.session && typeof base[id].session === 'object') {
      merged.session = { ...base[id].session, ...(h.session && typeof h.session === 'object' ? h.session : {}) };
    }
    out[id] = merged;
  }
  return out;
}

/**
 * 解析实体会话补录规则（优先级：vars.session_scan > handler.session.scan > scans[source_id]）。
 * 补录方式由 handler 声明，避免应用间硬编码耦合。
 */
function resolveSessionScan(session, vars, handlerId) {
  const v = vars && typeof vars === 'object' ? vars : {};
  if (v.session_scan && typeof v.session_scan === 'object' && Object.keys(v.session_scan).length) {
    return { ...v.session_scan };
  }
  const h = handlersMap()[handlerId] || {};
  const sess = session || h.session || null;
  if (sess?.scan && typeof sess.scan === 'object' && Object.keys(sess.scan).length) {
    return { ...sess.scan };
  }
  // source_id 优先；旧云端快照可能缺 source_id，回落 activity_agent_id（Codex Desktop 等）
  const sid = sess?.source_id || sess?.activity_agent_id || null;
  if (sid) return { ...(sessionScansById()[sid] || {}) };
  return {};
}

/** 解析 trace 适配配置（vars.trace > handler.session.trace） */
function resolveSessionTrace(session, vars, handlerId) {
  const v = vars && typeof vars === 'object' ? vars : {};
  if (v.trace && typeof v.trace === 'object') return { ...v.trace };
  const h = handlersMap()[handlerId] || {};
  const sess = session || h.session || null;
  if (sess?.trace && typeof sess.trace === 'object') return { ...sess.trace };
  return {};
}

/** source_id → 内置 trace 适配器（实现仍在 session-browser，此处仅路由） */
const TRACE_PROFILE_BY_SOURCE = {
  claude: 'claude-jsonl',
  codex: 'codex-rollout',
  cursor: 'cursor-transcript',
  workbuddy: 'workbuddy-trace',
  'trae-work': 'trae-work-trace',
  kimi: 'kimi-code-trace',
};

/** Trae Work 标准 handler / 实体 id（旧 trae / trae-stats 仍兼容） */
const TRAE_WORK_HANDLER = 'trae-work-stats';
const TRAE_WORK_ENTITY = 'trae-work';
const LEGACY_HANDLER_ALIASES = { 'trae-stats': TRAE_WORK_HANDLER };
const LEGACY_ENTITY_ALIASES = { trae: TRAE_WORK_ENTITY, Trae: TRAE_WORK_ENTITY };

function normalizeHandlerId(hid) {
  return LEGACY_HANDLER_ALIASES[hid] || hid;
}

function normalizeEntityId(id) {
  if (!id) return id;
  if (LEGACY_ENTITY_ALIASES[id]) return LEGACY_ENTITY_ALIASES[id];
  if (String(id).toLowerCase() === 'trae') return TRAE_WORK_ENTITY;
  return id;
}

function isTraeWorkEntity(id) {
  const n = normalizeEntityId(id);
  return n === TRAE_WORK_ENTITY || String(id || '').toLowerCase() === 'trae';
}

function applyTraceFields(entity, session, vars, hid) {
  const traceCfg = resolveSessionTrace(session, vars, hid);
  const sid = session?.source_id;
  entity.trace_profile = traceCfg.profile || TRACE_PROFILE_BY_SOURCE[sid] || null;
  if (traceCfg.entrypoint_data_source) {
    entity.trace_entrypoint_data_source = traceCfg.entrypoint_data_source;
  } else if (entity.trace_profile === 'claude-jsonl' && entity.data_source) {
    entity.trace_entrypoint_data_source = entity.data_source;
  }
}

/** 路由绑定 → 展示标签（写入 Claude inferenceModels.labelOverride 等） */
function routeLabelFor(routeId, routes = []) {
  const parsed = parseRouteBinding(routeId, routes);
  if (parsed.isScene && parsed.scene) {
    const r = parsed.scene;
    const icon = r.icon && !String(r.icon).startsWith('icon:') ? `${r.icon} ` : '';
    return `${icon}${r.scene_name || r.model_key || routeId}`.trim();
  }
  return String(parsed.modelId || routeId).trim();
}

/** 绑定路由 → WorkBuddy models.json 的 id（场景名或模型 id，不含 marker 前缀） */
function routeModelId(routeId, routes = []) {
  if (!routeId) return '';
  const parsed = parseRouteBinding(routeId, routes);
  if (parsed.isScene && parsed.scene) {
    const r = parsed.scene;
    // 必须回 model_key（llm-router-auto）——这是发给网关的 wire model，网关按 model_key 解析。
    // scene_name（"综合最优"）只是显示名，直接当 model 发会 model_not_found（Codex 表现为无返回）。
    return String(r.model_key || r.scene_name || routeId).trim();
  }
  return String(parsed.modelId || routeId).trim();
}

/** 应用绑定的路由 → 模型名数组（去重、保序）。供 Codex model catalog 等消费。 */
/**
 * 供给源模型是否为「图文」(type='vision'，支持图片输入)。扫描 providers[].models[] 按名字匹配。
 * providers 传 readLocalConfig().providers；缺省/未匹配一律 false。兼容旧的 vision 布尔标志。
 */
function modelVision(modelId, providers = []) {
  if (!modelId) return false;
  for (const p of Array.isArray(providers) ? providers : []) {
    for (const m of (p && Array.isArray(p.models) ? p.models : [])) {
      const id = typeof m === 'string' ? m : (m && (m.name || m.id));
      if (id === modelId) return typeof m === 'object' && (m.type === 'vision' || (m.type === 'chat' && !!m.vision));
    }
  }
  return false;
}

function getRouteModels(app, routes = []) {
  const ids = Array.isArray(app?.route_ids) && app.route_ids.length
    ? app.route_ids
    : (app?.route_id ? [app.route_id] : []);
  const out = [];
  for (const rid of ids) {
    const m = routeModelId(rid, routes);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * WorkBuddy 自定义模型格式：name=provider（tokenbank），id=路由/模型名；
 * 多路由则 models[] 多条，不写 availableModels。
 */
function patchRouteWorkbuddyModels(patch, cfg, ctx) {
  const modelsKey = cfg.models_key || 'models';
  const template = patch[modelsKey]?.[0];
  if (!template) return patch;
  const routeIds = ctx.routeIds?.length ? ctx.routeIds
    : (ctx.routeId ? [ctx.routeId] : []);
  if (!routeIds.length) return patch;

  const providerName = cfg.provider_name || ctx.marker || 'tokenbank';
  const routes = ctx.routes || [];
  const providers = ctx.providers || [];
  const models = routeIds
    .map(rid => {
      const id = routeModelId(rid, routes);
      // supportsImages 跟随供给源「图文」标志；template 已带默认值，按模型覆盖
      return { ...template, id, name: providerName, supportsImages: modelVision(id, providers) };
    })
    .filter(m => m.id);

  const out = { ...patch, [modelsKey]: models };
  const availKey = cfg.available_models_key || 'availableModels';
  if (availKey in out) delete out[availKey];
  return out;
}

/** Claude Desktop：inferenceModels[]，每条路由独占一个 claude-* name，labelOverride 显示绑定的路由 */
function patchRouteClaudeInferenceModels(patch, cfg, ctx) {
  const routeIds = ctx.routeIds?.length ? ctx.routeIds : (ctx.routeId ? [ctx.routeId] : []);
  if (!routeIds.length) return patch;
  const fallback = cfg.claude_name || ctx.claudeName || 'claude-sonnet-4-5';
  const claudeModels = ctx.claudeModels?.length
    ? ctx.claudeModels
    : (ctx.claudeName ? [ctx.claudeName] : [fallback]);
  const routes = ctx.routes || [];
  const models = routeIds
    .map((rid, i) => {
      const label = routeLabelFor(rid, routes);
      if (!label) return null;
      return { name: claudeNameAtIndex(i, claudeModels, fallback), labelOverride: label };
    })
    .filter(Boolean);
  if (!models.length) return patch;
  return { ...patch, inferenceModels: models };
}

/** Codex Desktop：顶层 model 写绑定的路由/模型名；多选时首条为默认 */
function patchRouteCodexModel(patch, cfg, ctx) {
  const routeIds = ctx.routeIds?.length ? ctx.routeIds : (ctx.routeId ? [ctx.routeId] : []);
  const first = routeIds[0];
  if (!first) return patch;
  const modelId = routeModelId(first, ctx.routes || []);
  if (!modelId) return patch;
  return { ...patch, model: modelId };
}

/** Trae IDE：每条路由 → 一个自定义 OpenAI 模型（name 唯一，custom_model_id 为实际 model id） */
function patchRouteTraeModels(patch, cfg, ctx) {
  const modelsKey = cfg.models_key || 'models';
  const template = patch[modelsKey]?.[0];
  if (!template) return patch;
  const routeIds = ctx.routeIds?.length ? ctx.routeIds : (ctx.routeId ? [ctx.routeId] : []);
  if (!routeIds.length) return patch;

  const routes = ctx.routes || [];
  const models = routeIds
    .map(rid => {
      const modelId = routeModelId(rid, routes);
      if (!modelId) return null;
      const label = routeLabelFor(rid, routes) || modelId;
      return {
        ...template,
        name: modelId,
        display_name: label,
        custom_model_id: modelId,
      };
    })
    .filter(Boolean);
  return { ...patch, [modelsKey]: models };
}

const PATCH_ROUTE_STRATEGIES = {
  workbuddy_models: patchRouteWorkbuddyModels,
  marker_model_list: patchRouteWorkbuddyModels,
  trae_models: patchRouteTraeModels,
  claude_inference_models: patchRouteClaudeInferenceModels,
  codex_model: patchRouteCodexModel,
};

/**
 * 按 handler.proxy.patch_route 在写入配置前改写 patch（路由绑定标记等）。
 * @param {string} handlerId
 * @param {object} patch
 * @param {{ routeId?: string, routeIds?: string[], routes?: object[], marker?: string }} ctx
 */
function applyRouteToProxyPatch(handlerId, patch, ctx = {}) {
  if (!patch) return patch;
  handlerId = normalizeHandlerId(handlerId);
  const routeIds = ctx.routeIds?.length ? ctx.routeIds
    : (ctx.routeId ? [ctx.routeId] : []);
  if (!routeIds.length) return patch;
  const cfg = handlersMap()[handlerId]?.proxy?.patch_route;
  if (!cfg?.strategy) return patch;
  const fn = PATCH_ROUTE_STRATEGIES[cfg.strategy];
  if (!fn) return patch;
  const marker = ctx.marker || handlersMap()[handlerId]?.proxy?.marker || 'tokenbank';
  return fn(patch, cfg, { ...ctx, routeIds, marker });
}

/** handler 是否声明了 patch_route（配置文件绑路由写入） */
function handlerHasPatchRoute(hid) {
  return !!(handlersMap()[hid]?.proxy?.patch_route?.strategy);
}

/** 实体是否启用路由多选（vars 覆盖 handler.patch_route.multi_select 默认） */
function resolveRouteMultiSelect(hid, vars) {
  const v = vars && typeof vars === 'object' ? vars : {};
  if ('route_multi_select' in v) return !!v.route_multi_select;
  return !!handlersMap()[hid]?.proxy?.patch_route?.multi_select;
}

/** preset_id / app.handler → handler id */
function resolveHandlerId(appRec) {
  if (appRec?.handler) return normalizeHandlerId(appRec.handler);
  const preset = normalizeEntityId(appRec?.preset_id || appRec?.agent_id || appRec?.id);
  if (!preset) return '';
  const entities = loadDoc().default_entities || [];
  const ent = entities.find(e => e.id === preset || normalizeEntityId(e.id) === preset)
    || entities.find(e => e.id === canonicalAppEntityId(preset));
  return normalizeHandlerId(ent?.handler || '');
}

/** handler ops（安装链接等） */
function handlerOps(hid) {
  if (!_ops) {
    try {
      const doc = yaml.load(fs.readFileSync(OPS_YAML, 'utf8')) || {};
      _ops = doc.ops || {};
    } catch {
      _ops = {};
    }
  }
  return _ops[hid] || {};
}

function normStrList(val) {
  if (Array.isArray(val)) return val.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof val === 'string' && val.trim()) return val.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function handlerMaxCapabilities() {
  // 运营可勾选任意能力；运行时能否生效由 handler 内置 proxy/session 决定
  return {
    gateway_proxy: true,
    session_trace: true,
    session_usage_import: true,
    resource_project: true,
  };
}

/** handler.yaml capabilities 字段决定「未显式配置时」的默认勾选建议 */
function defaultUserCapabilities(h) {
  const caps = new Set(h.capabilities || []);
  return {
    gateway_proxy: caps.has('gateway_proxy'),
    session_trace: caps.has('session_import') || caps.has('session_trace'),
    session_usage_import: caps.has('session_import'),
    // 资源投射目标：handler 声明 resource_project = 可作为游乐场/贡献 runtime
    resource_project: caps.has('resource_project'),
  };
}

function resolveUserCapabilities(h, vars) {
  const defaults = defaultUserCapabilities(h);
  const raw = (vars && vars.capabilities && typeof vars.capabilities === 'object') ? vars.capabilities : {};
  const out = {};
  for (const key of CAP_KEYS) {
    if (key in raw) out[key] = !!raw[key];
    else out[key] = defaults[key];
  }
  return out;
}

/** 合并 handler.ops + vars.ops */
function resolveOps(hid, vars) {
  const base = handlerOps(hid);
  const overlay = (vars && vars.ops && typeof vars.ops === 'object') ? vars.ops : {};
  return { ...base, ...overlay };
}

/** 从 scan + session 块推导 linked_data_sources */
function resolveLinkedDataSources(sess, scan, vars, dataSource) {
  if (vars.linked_data_sources) return normStrList(vars.linked_data_sources);
  if (sess.linked_data_sources) return [...sess.linked_data_sources];
  const out = [];
  if (dataSource) out.push(dataSource);
  const m = scan?.data_source_map?.map;
  if (m) for (const v of Object.values(m)) if (v && !out.includes(v)) out.push(v);
  return out;
}

/** handler + vars → 完整实体（与 compile 前 expand 一致） */
function expandEntity(compact) {
  const hid = String(compact.handler || '').trim();
  const h = handlersMap()[hid];
  if (!h) throw new Error(`未知 handler: ${hid}`);

  const vars = compact.vars && typeof compact.vars === 'object' ? compact.vars : {};
  const ops = resolveOps(hid, vars);
  const proxy = h.proxy || null;
  const session = h.session || null;
  const userCaps = resolveUserCapabilities(h, vars);
  const gatewayProxy = userCaps.gateway_proxy && !!proxy;
  const sessionTrace = userCaps.session_trace && !!session;
  const sessionUsageImport = userCaps.session_usage_import && !!session;
  const sessionImport = sessionTrace || sessionUsageImport || !!(session && !gatewayProxy && session.source_id);

  const entity = {
    sort_order: Number(compact.sort_order) || 0,
    id: String(compact.id || '').trim(),
    handler: hid,
    vars,
    capabilities: userCaps,
    name: vars.name || compact.name || h.default_name || compact.id,
    icon: vars.icon || compact.icon || h.default_icon || '🔧',
    gateway_proxy: gatewayProxy,
    session_import: sessionImport,
    session_trace: sessionTrace,
    session_usage_import: sessionUsageImport,
    // 可作为「投射到应用」目标（不依赖 proxy/session 基础设施）
    resource_project: !!userCaps.resource_project,
    ops,
    integrations: { ...(ops.integrations || {}), ...(vars.integrations || {}) },
    handoff_target: ops.handoff_target === true || vars.handoff_target === true,
  };

  if (gatewayProxy && proxy) {
    const mode = proxy.mode || 'cli';
    entity.proxy_mode = mode;
    entity.route_bindable = 'route_bindable' in vars ? !!vars.route_bindable : proxy.route_bindable !== false;
    if (mode === 'cli') {
      Object.assign(entity, {
        protocol: proxy.protocol || 'openai',
        strategy: proxy.strategy || 'base_url-env',
        detect_command: proxy.detect_command || '',
        detect_version_arg: proxy.detect_version_arg || '--version',
        detect_config_dirs: normStrList(proxy.detect_config_dirs),
        inject_env: { ...(proxy.inject_env || {}) },
      });
    } else {
      Object.assign(entity, {
        detect_type: proxy.detect_type || 'appx',
        detect_value: proxy.detect_value || '',
        // 可选第二探测：如 Codex 同时认 Desktop(appx) 与 CLI(command)
        detect_command: proxy.detect_command || '',
        config_file: proxy.config_file || '',
        marker: proxy.marker || 'tokenbank',
        enable_3p: !!proxy.enable_3p,
        allow_direct: 'allow_direct' in vars ? !!vars.allow_direct : !!proxy.allow_direct,
        patch: { ...(proxy.patch || {}) },
        env: { ...(proxy.env || {}) },
      });
    }
  }

  const sid = session?.source_id;
  const scan = resolveSessionScan(session, vars, hid);

  if (sessionImport && session) {
    entity.session_scan = scan;
    entity.standalone = session.standalone != null ? !!session.standalone : !gatewayProxy;
    entity.session_source_id = sid || session.activity_agent_id || entity.id;
    if (gatewayProxy) {
      entity.route_bindable = entity.route_bindable != null
        ? entity.route_bindable
        : proxy.route_bindable !== false;
    } else {
      // 无网关代理：默认不可绑路由（仅会话统计/导入走官方订阅）
      entity.route_bindable = 'route_bindable' in vars ? !!vars.route_bindable
        : ('route_bindable' in session ? !!session.route_bindable : false);
    }
    if (vars.models) entity.models = normStrList(vars.models);
    else if (session.models) entity.models = normStrList(session.models);
    else if (scan.models) entity.models = normStrList(scan.models);
    for (const key of ['data_source', 'provider_id', 'tier', 'billing_type']) {
      if (vars[key] != null && vars[key] !== '') entity[key] = vars[key];
      else if (scan[key]) entity[key] = scan[key];
    }
    entity.pricing_provider_id = vars.pricing_provider_id || ops.pricing_provider_id || entity.provider_id || null;
    entity.billing_type = entity.billing_type || ops.billing_type || 'api-key';
    entity.activity_agent_id = vars.activity_agent_id || session.activity_agent_id || entity.id;
    entity.trace_agent_id = vars.trace_agent_id || session.trace_agent_id || entity.activity_agent_id;
    entity.linked_data_sources = resolveLinkedDataSources(session, scan, vars, entity.data_source);
    if (sessionTrace) applyTraceFields(entity, session, vars, hid);
  } else if (session && gatewayProxy) {
    // 仅网关代理、未开用量导入：可保留 trace 用的 agent 映射，但不挂 linked_data_sources
    if (sessionTrace) {
      entity.activity_agent_id = vars.activity_agent_id || session.activity_agent_id || entity.id;
      entity.trace_agent_id = vars.trace_agent_id || session.trace_agent_id || entity.activity_agent_id;
      applyTraceFields(entity, session, vars, hid);
    }
    if (sessionUsageImport) {
      entity.linked_data_sources = resolveLinkedDataSources(session, scan, vars, null);
    } else {
      entity.linked_data_sources = [];
    }
    entity.pricing_provider_id = vars.pricing_provider_id || ops.pricing_provider_id || null;
  } else if (gatewayProxy) {
    entity.standalone = false;
    entity.activity_agent_id = entity.id;
    entity.trace_agent_id = entity.id;
    entity.linked_data_sources = [];
    entity.pricing_provider_id = vars.pricing_provider_id || ops.pricing_provider_id || null;
  } else {
    entity.standalone = true;
    entity.activity_agent_id = entity.id;
    entity.trace_agent_id = entity.id;
    entity.linked_data_sources = [];
  }

  // 配置文件绑路由写入：是否允许多选（WorkBuddy / Claude Desktop / Codex 等）
  if (handlerHasPatchRoute(hid)) {
    entity.route_multi_select = resolveRouteMultiSelect(hid, vars);
  }

  return entity;
}

/** entity id → 合并后的 ops（安装链接等） */
function opsForEntityId(entityId, compact) {
  const row = compact
    || (loadDoc().default_entities || []).find(r => r.id === entityId);
  if (!row?.handler) return {};
  return resolveOps(row.handler, row.vars || {});
}

/** 所有 handoff 目标（交接下拉） */
function handoffTargets(entities) {
  const out = [];
  const seen = new Set();
  for (const raw of entities || []) {
    let e;
    try { e = expandEntity(raw); } catch { continue; }
    if (!e.handoff_target) continue;
    const id = e.activity_agent_id || e.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: e.name || id });
  }
  return out;
}

function listHandlersMeta() {
  return Object.entries(handlersMap()).map(([id, h]) => ({
    id,
    label: h.label || id,
    label_zh: h.label_zh || h.label || id,
    default_icon: h.default_icon || '🔧',
    default_name: h.default_name || id,
    capabilities: h.capabilities || [],
  }));
}

module.exports = {
  loadDoc,
  handlersMap,
  sessionScansById,
  normalizeClaudeSessionScan,
  applyCloudConfig,
  resolveSessionScan,
  resolveSessionTrace,
  applyTraceFields,
  handlerOps,
  resolveOps,
  opsForEntityId,
  handoffTargets,
  expandEntity,
  resolveUserCapabilities,
  handlerMaxCapabilities,
  defaultUserCapabilities,
  applyRouteToProxyPatch,
  resolveHandlerId,
  routeModelId,
  getRouteModels,
  modelVision,
  routeLabelFor,
  handlerHasPatchRoute,
  resolveRouteMultiSelect,
  listHandlersMeta,
  normStrList,
  APP_ENTITY_ALIASES,
  canonicalAppEntityId,
  TRAE_WORK_HANDLER,
  TRAE_WORK_ENTITY,
  normalizeHandlerId,
  normalizeEntityId,
  isTraeWorkEntity,
};
