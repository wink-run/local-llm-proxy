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
// 工具/计费目录内置默认（个人页订阅应用、按量供给源、刊例价；与服务器 config.apps 同 schema）
const TOOLS_DEFAULT_YAML = path.join(__dirname, 'config', 'tokenbank.tools.default.yaml');
// 用户导入/服务器下发的配置覆盖文件（main.js 的 applyConfigDoc 写这里）。存在则优先于内置默认。
const USER_YAML = path.join(os.homedir(), '.tokenbank', 'tokenbank.yaml');
// 「源」目录下发文件（GET /api/config/sources 写这里），与应用文件 tokenbank.yaml 分离。
const USER_TOOLS_YAML = path.join(os.homedir(), '.tokenbank', 'tokenbank.tools.yaml');

let _config = null;        // 解析后的原始 yaml 对象（应用：tools / api_key_apps / 基础设施）
let _sources = null;       // 源目录文件（tokenbank.tools.yaml）解析结果
let _caPath = null;        // 运行时由 ca-manager 注入的实际 CA 路径（解析 {CA_PATH}）

// 加载源目录文件（tokenbank.tools.yaml）；不存在则空（billingSection 再回退内置默认）。
function loadSources() {
  try {
    if (fs.existsSync(USER_TOOLS_YAML)) {
      _sources = yaml.load(fs.readFileSync(USER_TOOLS_YAML, 'utf8')) || {};
      return _sources;
    }
  } catch (e) { console.error('[config-loader] 加载 tokenbank.tools.yaml 失败:', e.message); }
  _sources = {};
  return _sources;
}

function getSources() {
  if (_sources === null) loadSources();
  return _sources;
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
    _sources = null;          // 同步后强制下次重读源文件 tokenbank.tools.yaml
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
  const tools = get().tools || [];
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
  const list = get().tools || [];
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
function apiKeyApps() { const ctx = gatewayCtx(); return (get().api_key_apps || []).map(p => resolveDeep(p, ctx)); }
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

// 会话用量解析配置（内部固定逻辑，YAML 驱动）：当前配置有就用，否则回退内置默认。
function sessionSources() {
  const cur = get().session_sources;
  if (Array.isArray(cur) && cur.length) return cur;
  try { return ((yaml.load(fs.readFileSync(DEFAULT_YAML, 'utf8')) || {}).session_sources || []); } catch { return []; }
}

// 各应用官方安装/下载页（图标行「未安装」点击跳转）。内置默认始终兜底（即使 USER_YAML
// 覆盖了其它配置也不丢失），当前配置 / 服务端下发的同名段按 id 叠加覆盖。
function appInstallUrls() {
  let builtin = {};
  try { builtin = (yaml.load(fs.readFileSync(DEFAULT_YAML, 'utf8')) || {}).app_install_urls || {}; } catch {}
  const cur = get().app_install_urls;
  const curMap = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  return { ...builtin, ...curMap };
}

// 各应用官方卸载/卸载说明页（百宝箱「卸载」按钮跳转）。合并规则同 appInstallUrls。
function appUninstallUrls() {
  let builtin = {};
  try { builtin = (yaml.load(fs.readFileSync(DEFAULT_YAML, 'utf8')) || {}).app_uninstall_urls || {}; } catch {}
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
function appInstallGuides() { return mergeGuideMap('app_install_guides'); }
function appUninstallGuides() { return mergeGuideMap('app_uninstall_guides'); }
// 兼容旧调用
function normalizeGuide(v) { return resolveGuide(v); }

/** 读取 tools 默认 yaml（计费目录回退源） */
function toolsDefaultDoc() {
  try { return yaml.load(fs.readFileSync(TOOLS_DEFAULT_YAML, 'utf8')) || {}; } catch { return {}; }
}

/** 源/计费段：优先独立源文件 tokenbank.tools.yaml（GET /api/config/sources 下发），
 * 其次 tokenbank.yaml（兼容旧版混装），再回退内置默认 tokenbank.tools.default.yaml。 */
function billingSection(key) {
  const isEmpty = (v) => v == null
    || (Array.isArray(v) && !v.length)
    || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
  let cur = getSources()[key];
  if (isEmpty(cur)) cur = get()[key];
  if (!isEmpty(cur)) return cur;
  const fb = toolsDefaultDoc()[key];
  if (fb != null) return fb;
  return Array.isArray(cur) ? [] : {};
}

// 个人页：可订阅应用目录（由 tokenbank.tools.yaml 下发，缺字段时与内置默认按 source_id 合并）
function subscriptionApps() {
  const defaults = toolsDefaultDoc().subscription_apps || [];
  const defBySource = Object.fromEntries(
    defaults.map(a => [a.source_id || a.id || a.agent_id, a]),
  );
  const list = billingSection('subscription_apps');
  const cur = Array.isArray(list) ? list : [];
  if (!cur.length) return defaults;
  return cur.map(a => {
    const key = a.source_id || a.id || a.agent_id;
    const def = defBySource[key] || {};
    return {
      ...def,
      ...a,
      plan_provider_id: a.plan_provider_id != null ? a.plan_provider_id : def.plan_provider_id,
      // 下发配置未带该字段时，回退内置默认（如 Claude Code → true）
      subscription_to_api: a.subscription_to_api != null
        ? a.subscription_to_api === true
        : def.subscription_to_api === true,
    };
  });
}

// 个人页：预置 API 订阅目录（与 APP 订阅、按量供给源分离）
function apiSubscriptionApps() {
  const defaults = toolsDefaultDoc().api_subscription_apps || [];
  const defBySource = Object.fromEntries(
    defaults.map(a => [a.source_id || a.id, a]),
  );
  const list = billingSection('api_subscription_apps');
  const cur = Array.isArray(list) ? list : [];
  if (!cur.length) return defaults;
  // 服务端已下发：以当前列表为准，仅用内置默认补全缺字段
  return cur.map(a => {
    const key = a.source_id || a.id;
    const def = defBySource[key] || {};
    return {
      ...def,
      ...a,
      plan_provider_id: a.plan_provider_id != null ? a.plan_provider_id : def.plan_provider_id,
    };
  });
}

// 个人页：按量付费供给源目录
function paygProviders() {
  const list = billingSection('payg_providers');
  return Array.isArray(list) ? list : [];
}

// 订阅套餐模板（按 plan_provider_id 索引）
function subscriptionPlansDefaults() {
  const plans = billingSection('subscription_plans');
  return plans && typeof plans === 'object' && !Array.isArray(plans) ? plans : {};
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

module.exports = {
  load, get, setCaPath, getCaPath,
  gatewayCtx, mitmDomains, shouldMitm, tools, appPresets, apiKeyApps,
  routing, caRef,
  claudeModels, isClaudeModel, sessionSources, agentHasModelStats, appInstallUrls, appUninstallUrls,
  appInstallGuides, appUninstallGuides, normalizeGuide, resolveGuide,
  subscriptionApps, apiSubscriptionApps, paygProviders, subscriptionPlansDefaults,
  resolveRef, resolvePlaceholders, expandHome,
};
