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

let _config = null;        // 解析后的原始 yaml 对象
let _caPath = null;        // 运行时由 ca-manager 注入的实际 CA 路径（解析 {CA_PATH}）

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

/** 读取 tools 默认 yaml（计费目录回退源） */
function toolsDefaultDoc() {
  try { return yaml.load(fs.readFileSync(TOOLS_DEFAULT_YAML, 'utf8')) || {}; } catch { return {}; }
}

/** 计费段：当前下发配置优先，空则回退 tokenbank.tools.default.yaml */
function billingSection(key) {
  const cur = get()[key];
  const empty = cur == null
    || (Array.isArray(cur) && !cur.length)
    || (typeof cur === 'object' && !Array.isArray(cur) && !Object.keys(cur).length);
  if (!empty) return cur;
  const fb = toolsDefaultDoc()[key];
  if (fb != null) return fb;
  return Array.isArray(cur) ? [] : {};
}

// 个人页：可订阅应用目录（由 tokenbank.tools.yaml 下发）
function subscriptionApps() {
  const list = billingSection('subscription_apps');
  return Array.isArray(list) ? list : [];
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

/** 该 Agent 是否会话补录真实 model（Cursor 等只有工具标签 → false） */
function agentHasModelStats(agentId) {
  if (!agentId) return true;
  const src = sessionSources().find(s => s.agent_id === agentId);
  if (!src) return true;
  if (src.model_stats === false) return false;
  if (src.record_label === 'assistant_tools') return false;
  if (src.fields && src.fields.model) return true;
  if (Array.isArray(src.meta) && src.meta.some(m => m.set && m.set.model)) return true;
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
  claudeModels, isClaudeModel, sessionSources, agentHasModelStats,
  subscriptionApps, paygProviders, subscriptionPlansDefaults,
  resolveRef, resolvePlaceholders, expandHome,
};
