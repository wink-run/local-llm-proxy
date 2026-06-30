// client/electron/config-loader.js
// 唯一真相源加载器：读 tokenbank.yaml（内置默认 + 预留远程覆盖），
// 解析占位符（{REVERSE}/{MITM}/{CA_PATH}/{ENV|默认}/~）与 _ref 解析链。
// 纯解析，不含任何业务硬编码——所有决策数据都来自 yaml。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const yaml = require('js-yaml');

const DEFAULT_YAML = path.join(__dirname, 'config', 'tokenbank.default.yaml');
// 供给源 registry（models / pricing / handler / billing_sources；与服务器 config.providers 同 schema）
const REGISTRY_YAML = path.join(__dirname, 'config', 'providers.registry.yaml');
const USER_YAML = path.join(os.homedir(), '.tokenbank', 'tokenbank.yaml');
// 云端下发的 providers.registry.yaml（GET /api/config/providers）
const USER_REGISTRY_YAML = path.join(os.homedir(), '.tokenbank', 'providers.registry.yaml');

let _config = null;
let _appsRuntime = null;
let _registryDoc = null;
let _caPath = null;        // 运行时由 ca-manager 注入的实际 CA 路径（解析 {CA_PATH}）

/** 读取 providers.registry 内置默认（离线回退） */
function registryDefaultDoc() {
  try { return yaml.load(fs.readFileSync(REGISTRY_YAML, 'utf8')) || {}; } catch { return {}; }
}

/** 用户/云端 registry 缺段时从内置默认补全 billing_sources / providers */
function mergeRegistryDoc(doc) {
  const out = doc && typeof doc === 'object' ? { ...doc } : {};
  const def = registryDefaultDoc();
  if (!out.version) out.version = def.version || 1;
  if (!Array.isArray(out.providers) || !out.providers.length) {
    out.providers = Array.isArray(def.providers) ? def.providers : [];
  }
  if (!Array.isArray(out.billing_sources) || !out.billing_sources.length) {
    out.billing_sources = Array.isArray(def.billing_sources) ? def.billing_sources : [];
  }
  return out;
}

// 加载 providers.registry.yaml：用户目录优先，回退内置默认
function loadRegistryDoc() {
  try {
    if (fs.existsSync(USER_REGISTRY_YAML)) {
      _registryDoc = mergeRegistryDoc(yaml.load(fs.readFileSync(USER_REGISTRY_YAML, 'utf8')) || {});
      return _registryDoc;
    }
  } catch (e) {
    console.error('[config-loader] 加载 providers.registry.yaml 失败:', e.message);
  }
  try {
    _registryDoc = mergeRegistryDoc(yaml.load(fs.readFileSync(REGISTRY_YAML, 'utf8')) || {});
  } catch {
    _registryDoc = { version: 1, providers: [], billing_sources: [] };
  }
  return _registryDoc;
}

function getRegistryDoc() {
  if (_registryDoc === null) loadRegistryDoc();
  return _registryDoc;
}

/** 云端同步后刷新 registry */
function reloadRegistryDoc() {
  _registryDoc = null;
  loadRegistryDoc();
}

// ── 占位符 / 路径解析 ────────────────────────────────────────────────────────

// 展开 ~ 为主目录
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 解析 {ENV|默认值}：读环境变量 ENV，空则用默认值
function resolveEnvBrace(str) {
  return str.replace(/\{([A-Z_][A-Z0-9_]*)\|([^}]*)\}/g, (_, env, def) => {
    const v = process.env[env];
    return (v && v.length) ? v : def;
  });
}

// 解析所有占位符。ctx = { reverse, mitm, caPath }
function resolvePlaceholders(str, ctx = {}) {
  if (typeof str !== 'string') return str;
  let s = str;
  if (ctx.reverse) s = s.replace(/\{REVERSE\}/g, ctx.reverse);
  if (ctx.mitm)    s = s.replace(/\{MITM\}/g, ctx.mitm);
  if (ctx.caPath != null) s = s.replace(/\{CA_PATH\}/g, ctx.caPath);
  s = resolveEnvBrace(s);          // {ENV|默认}
  s = expandHome(s);               // ~
  return s;
}

// ── 加载 ─────────────────────────────────────────────────────────────────────

function load() {
  // 优先用户覆盖文件（~/.tokenbank/tokenbank.yaml）—— 导入配置/服务器下发后写在这里；
  // 不存在则回退内置默认 tokenbank.default.yaml。
  let file = DEFAULT_YAML;
  try { if (fs.existsSync(USER_YAML)) file = USER_YAML; } catch {}
  try {
    const text = fs.readFileSync(file, 'utf8');
    _config = yaml.load(text) || {};
    _registryDoc = null;
    _appsRuntime = null;
    // 云端下发的 handlers / session_scans 供 handler 展开时合并
    try { require('./app-handlers').applyCloudConfig(_config); } catch {}
  } catch (e) {
    console.error('[config-loader] 加载 yaml 失败:', e.message, '(', file, ')');
    // 用户覆盖文件损坏时回退内置默认
    if (file !== DEFAULT_YAML) {
      try { _config = yaml.load(fs.readFileSync(DEFAULT_YAML, 'utf8')) || {}; }
      catch { _config = {}; }
    } else { _config = {}; }
  }
  return _config;
}

function get() {
  if (!_config) load();
  return _config;
}

/** handler 展开后的应用运行时段（tools / api_key_apps / session_sources） */
function appsRuntime() {
  if (!_appsRuntime) {
    const { resolveAppsRuntime } = require('./apps-compiler');
    _appsRuntime = resolveAppsRuntime(get());
  }
  return _appsRuntime;
}

/** 紧凑实体列表（app_entities） */
function appEntities() {
  return appsRuntime().app_entities || [];
}

/** 展开后的实体（含 capabilities / proxy_mode 等） */
function appEntitiesExpanded() {
  return appsRuntime().entities_expanded || [];
}

function appEntityById(id) {
  if (!id) return null;
  const exp = appEntitiesExpanded().find(e => e.id === id);
  if (exp) return exp;
  // 紧凑实体按需展开（避免 entities_expanded 未缓存时拿不到 capabilities）
  const compact = appEntities().find(e => e.id === id);
  if (compact?.handler) {
    try { return require('./app-handlers').expandEntity(compact); } catch {}
  }
  return null;
}

/** 用户勾选的三项能力（紧凑 vars 或展开实体） */
function appCapabilities(id) {
  const compact = appEntities().find(e => e.id === id);
  if (compact?.vars?.capabilities) return compact.vars.capabilities;
  const ent = appEntityById(id);
  return ent?.capabilities || null;
}

// 由 ca-manager 在 CA 就绪后调用，供 {CA_PATH} 解析
function setCaPath(p) { _caPath = p; }
function getCaPath() { return _caPath; }

// ── 派生数据（全部来自 yaml，无硬编码）──────────────────────────────────────

function gatewayCtx() {
  const g = get().gateway || {};
  const host = g.host || '127.0.0.1';
  return {
    reverse: `${host}:${g.reverse_port || 11430}`,
    mitm:    `${host}:${g.mitm_port || 8888}`,
    caPath:  _caPath,
  };
}

// 所有需 MITM 的工具（mitm-env / mitm-system）的 mitm-domains 并集（= CA 约束域名）
function mitmDomains() {
  const tools = appsRuntime().tools || [];
  const set = new Set();
  for (const t of tools) {
    if ((t.strategy === 'mitm-env' || t.strategy === 'mitm-system') && Array.isArray(t['mitm-domains'])) {
      for (const d of t['mitm-domains']) set.add(d);
    }
  }
  return [...set];
}

// 某 domain 是否需要被 MITM 拦截解密（查 yaml，不硬编码）
function shouldMitm(host) {
  return mitmDomains().some(d => d === host || host.endsWith('.' + d));
}

// 取工具列表，占位符已解析（inject.env / patch / config-file 等）
function tools() {
  const ctx = gatewayCtx();
  const list = appsRuntime().tools || [];
  return list.map(t => resolveDeep(t, ctx));
}

// 递归解析对象里所有字符串占位符
function resolveDeep(obj, ctx) {
  if (typeof obj === 'string') return resolvePlaceholders(obj, ctx);
  if (Array.isArray(obj)) return obj.map(x => resolveDeep(x, ctx));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = resolveDeep(obj[k], ctx);
    return out;
  }
  return obj;
}

function routing()   { return get().routing || {}; }
// 「添加应用」预设：占位符已解析（{CODEX_HOME|..} 等），但保留 {BASE}/{KEY}（前端按应用解析）
function appPresets() { const ctx = gatewayCtx(); return (get().app_presets || []).map(p => resolveDeep(p, ctx)); }
// API Key 应用（检测 appx → 写其配置文件指向网关）：同样保留 {BASE}/{KEY}，前端按应用解析
function apiKeyApps() { const ctx = gatewayCtx(); return (appsRuntime().api_key_apps || []).map(p => resolveDeep(p, ctx)); }
// Claude 客户端模型名（内部透明：仅供 /v1/models 暴露 + 标记 Claude 请求）。字符串数组。
// 这是内部固定逻辑：始终并入内置默认（即使 TB_YAML 覆盖了 tools 也不丢失），再合并当前配置/下发的。
function claudeModels() {
  const cur = (get().claude_models || []).filter(x => typeof x === 'string');
  let builtin = [];
  try { builtin = ((yaml.load(fs.readFileSync(DEFAULT_YAML, 'utf8')) || {}).claude_models || []).filter(x => typeof x === 'string'); } catch {}
  return [...new Set([...builtin, ...cur])];
}
// 检查某模型名是否是 Claude 客户端模型名
function isClaudeModel(modelId) { return claudeModels().includes(modelId); }

// 会话用量解析：由 app_entities + handler 展开（session-scans.yaml）
function sessionSources() {
  return appsRuntime().session_sources || [];
}

/** 从 handler-ops + app_entities 构建安装链接/说明 */
function buildHandlerOpsMaps() {
  const { opsForEntityId, loadDoc } = require('./app-handlers');
  const install = {};
  const uninstall = {};
  const installGuides = {};
  const uninstallGuides = {};
  const entities = appEntities();
  const list = entities.length ? entities : (loadDoc().default_entities || []);
  for (const ent of list) {
    if (!ent?.id) continue;
    const ops = opsForEntityId(ent.id, ent);
    if (ops.install_url) install[ent.id] = ops.install_url;
    if (ops.uninstall_url) uninstall[ent.id] = ops.uninstall_url;
    if (ops.install_guide) installGuides[ent.id] = ops.install_guide;
    if (ops.uninstall_guide) uninstallGuides[ent.id] = ops.uninstall_guide;
  }
  return { install, uninstall, installGuides, uninstallGuides };
}

function appInstallUrls() {
  const builtin = buildHandlerOpsMaps().install;
  const cur = get().app_install_urls;
  const curMap = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  return { ...builtin, ...curMap };
}

function appUninstallUrls() {
  const builtin = buildHandlerOpsMaps().uninstall;
  const cur = get().app_uninstall_urls;
  const curMap = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  return { ...builtin, ...curMap };
}

// 百宝箱安装/卸载说明（多行文本，服务端可下发覆盖）
function mergeStringMap(key) {
  let builtin = {};
  try { builtin = (yaml.load(fs.readFileSync(DEFAULT_YAML, 'utf8')) || {})[key] || {}; } catch {}
  const cur = get()[key];
  const curMap = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  return { ...builtin, ...curMap };
}
function normalizeGuideText(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean).join('\n') || null;
  return null;
}

// 百宝箱说明：支持纯文本，或 { mac, win, default } 按本机平台选取（mac/darwin/osx、win/win32/windows）
const GUIDE_PLATFORM_KEYS = {
  darwin: ['mac', 'darwin', 'osx', 'macos'],
  win32:  ['win', 'win32', 'windows'],
  linux:  ['linux'],
};
function resolveGuide(v, platform = process.platform) {
  const text = normalizeGuideText(v);
  if (text) return text;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const aliases = GUIDE_PLATFORM_KEYS[platform] || [];
  for (const k of aliases) {
    const t = normalizeGuideText(v[k]);
    if (t) return t;
  }
  return normalizeGuideText(v.default) || normalizeGuideText(v.other);
}

function mergeGuideMap(key) {
  let builtin = {};
  try { builtin = (yaml.load(fs.readFileSync(DEFAULT_YAML, 'utf8')) || {})[key] || {}; } catch {}
  const cur = get()[key];
  const curMap = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  const out = { ...builtin };
  for (const [id, val] of Object.entries(curMap)) {
    const base = out[id];
    if (val && typeof val === 'object' && !Array.isArray(val)
        && base && typeof base === 'object' && !Array.isArray(base)) {
      out[id] = { ...base, ...val };
    } else {
      out[id] = val;
    }
  }
  return out;
}
function appInstallGuides() {
  const builtin = buildHandlerOpsMaps().installGuides;
  const cur = get().app_install_guides;
  const curMap = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  const out = { ...builtin };
  for (const [id, val] of Object.entries(curMap)) {
    const base = out[id];
    if (val && typeof val === 'object' && !Array.isArray(val)
        && base && typeof base === 'object' && !Array.isArray(base)) {
      out[id] = { ...base, ...val };
    } else {
      out[id] = val;
    }
  }
  return out;
}
function appUninstallGuides() {
  const builtin = buildHandlerOpsMaps().uninstallGuides;
  const cur = get().app_uninstall_guides;
  const curMap = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  const out = { ...builtin };
  for (const [id, val] of Object.entries(curMap)) {
    const base = out[id];
    if (val && typeof val === 'object' && !Array.isArray(val)
        && base && typeof base === 'object' && !Array.isArray(base)) {
      out[id] = { ...base, ...val };
    } else {
      out[id] = val;
    }
  }
  return out;
}
// 兼容旧调用
function normalizeGuide(v) { return resolveGuide(v); }

/** 个人源模板完整列表（billing_sources）；以 providers.registry.yaml 为准 */
function billingSourcesList() {
  const list = getRegistryDoc()?.billing_sources;
  if (Array.isArray(list) && list.length) {
    return [...list].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }
  return [];
}

function _modelsFromSource(s) {
  const out = [];
  for (const m of s?.models || []) {
    if (typeof m === 'string' && m.trim()) {
      out.push({ id: m.trim(), modality: 'chat', pricing: (s.pricing || {})[m.trim()] || {} });
    } else if (m && typeof m === 'object') {
      const id = String(m.id || m.name || m.model || '').trim();
      if (id) out.push({ id, modality: m.modality || m.type || 'chat', pricing: m.pricing || (s.pricing || {})[id] || {} });
    }
  }
  if (typeof s?.pricing === 'object') {
    for (const [mid, rates] of Object.entries(s.pricing)) {
      if (!out.some(x => x.id === mid)) out.push({ id: mid, modality: 'chat', pricing: rates || {} });
    }
  }
  return out;
}

// 个人页：可订阅应用目录（由 billing_sources 派生）
function subscriptionApps() {
  const plans = subscriptionPlansDefaults();
  return billingSourcesList()
    .filter(s => s.category === 'app_sub')
    .map(s => {
      const ppid = s.plan_provider_id;
      const entry = {
        source_id: s.source_id || s.id,
        agent_id: s.agent_id || s.source_id || s.id,
        app_name: s.label,
        app_icon: s.icon || '🔧',
        plan_provider_id: ppid,
        subscription_to_api: s.subscription_to_api === true,
      };
      if (s.subscription_to_api) {
        const models = _modelsFromSource(s).map(m => m.id);
        if (models.length) entry.models = models;
        if (Object.keys(s.pricing || {}).length) entry.pricing = s.pricing;
      }
      return entry;
    });
}

// 个人页：预置 API 订阅目录
function apiSubscriptionApps() {
  return billingSourcesList()
    .filter(s => s.category === 'api_sub')
    .map(s => {
      const entry = {
        source_id: s.source_id || s.id,
        app_name: s.label,
        app_icon: s.icon || '🔧',
        plan_provider_id: s.plan_provider_id || s.id,
      };
      const models = _modelsFromSource(s).map(m => m.id);
      if (models.length) entry.models = models;
      if (Object.keys(s.pricing || {}).length) entry.pricing = s.pricing;
      return entry;
    });
}

// 个人页：按量付费供给源目录
function paygProviders() {
  return billingSourcesList()
    .filter(s => s.category === 'payg')
    .map(s => ({
      id: s.id,
      provider_id: s.id,
      label: s.label || s.id,
      icon: s.icon || '🔧',
      aliases: s.aliases || [],
      models: _modelsFromSource(s).map(m => m.id),
      pricing: s.pricing || {},
    }));
}

/** 内置/云端 registry 供给源（models / pricing / handler） */
function registryProviders() {
  const raw = getRegistryDoc().providers;
  return Array.isArray(raw) ? raw : [];
}

// 订阅套餐模板（按 plan_provider_id 索引，来自 billing_sources.plans）
function subscriptionPlansDefaults() {
  const out = {};
  for (const s of billingSourcesList()) {
    const ppid = s.plan_provider_id || (s.category === 'api_sub' ? (s.source_id || s.id) : null);
    if (!ppid || !Array.isArray(s.plans) || !s.plans.length) continue;
    if (!out[ppid]) out[ppid] = [];
    for (const pl of s.plans) {
      if (pl && pl.id && !out[ppid].some(x => x.id === pl.id)) out[ppid].push(pl);
    }
  }
  return out;
}

/** 该 Agent 是否会话补录真实 model（Cursor hook / transcript 有 model 字段 → true） */
function agentHasModelStats(agentId) {
  if (!agentId) return true;
  const src = sessionSources().find(s => s.agent_id === agentId);
  if (!src) return true;
  if (src.model_stats === false) return false;
  // 配置了 model 字段映射的源（含 Cursor）可按模型统计
  if (src.fields && src.fields.model) return true;
  if (Array.isArray(src.meta) && src.meta.some(m => m.set && m.set.model)) return true;
  // 仅工具标签、无 model 字段的源不展示按模型统计
  if (src.record_label === 'assistant_tools') return false;
  return false;
}
function caRef()     { return (get().mitm || {}).ca_ref || ['auto']; }

// ── _ref 解析链（ca_ref / api_key_ref 共用）───────────────────────────────────
// refs: 字符串数组，按序取第一个可用。返回 { kind, value } 或 null。
//   env://X         → 读环境变量 X
//   file://path     → 路径（占位符已解析）；存在才算可用
//   tokenbank://session → 本地登录凭证（交给调用方解析）
//   auto            → 自动（交给调用方处理，如 ca-manager 生成）
function resolveRef(refs, ctx = {}) {
  for (const raw of (refs || [])) {
    const ref = resolvePlaceholders(String(raw), ctx);
    if (ref === 'auto') return { kind: 'auto', value: null };
    if (ref.startsWith('tokenbank://')) return { kind: 'tokenbank', value: ref.slice('tokenbank://'.length) };
    if (ref.startsWith('env://')) {
      const name = ref.slice('env://'.length);
      const v = process.env[name];
      if (v && v.length) return { kind: 'env', value: v, name };
      continue;
    }
    if (ref.startsWith('file://')) {
      const fp = expandHome(ref.slice('file://'.length));
      if (fp && fs.existsSync(fp)) return { kind: 'file', value: fp };
      continue;
    }
  }
  return null;
}

function handoffTargets() {
  const { handoffTargets: ht } = require('./app-handlers');
  return ht(appEntities());
}

module.exports = {
  load, get, setCaPath, getCaPath,
  gatewayCtx, mitmDomains, shouldMitm, tools, appPresets, apiKeyApps,
  routing, caRef,
  claudeModels, isClaudeModel, sessionSources, agentHasModelStats, appInstallUrls, appUninstallUrls,
  appInstallGuides, appUninstallGuides, normalizeGuide, resolveGuide,
  subscriptionApps, apiSubscriptionApps, paygProviders, registryProviders, subscriptionPlansDefaults,
  billingSourcesList, reloadRegistryDoc,
  resolveRef, resolvePlaceholders, expandHome,
  appsRuntime, appEntities, appEntitiesExpanded, appEntityById, appCapabilities,
  handoffTargets,
};
