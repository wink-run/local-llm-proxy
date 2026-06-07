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
  try {
    const text = fs.readFileSync(DEFAULT_YAML, 'utf8');
    _config = yaml.load(text) || {};
  } catch (e) {
    console.error('[config-loader] 加载内置 yaml 失败:', e.message);
    _config = {};
  }
  // 预留：若 remote.url 非空，这里拉取并合并覆盖（第一期不实现，仅占位）
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
// 虚拟模型列表（对外 Anthropic 模型名，对内改写到真实模型）
function virtualModels() { const ctx = gatewayCtx(); return (get().virtual_models || []).map(m => resolveDeep(m, ctx)); }
function caRef()     { return (get().mitm || {}).ca_ref || ['auto']; }

// 虚拟模型 ID → 真实模型 ID 映射（网关请求改写用）
function resolveVirtualModel(virtualId) {
  const vm = virtualModels().find(m => m.id === virtualId);
  return vm ? vm.real_model : null;
}

// 检查模型 ID 是否是虚拟模型
function isVirtualModel(modelId) {
  return virtualModels().some(m => m.id === modelId);
}

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
  virtualModels, resolveVirtualModel, isVirtualModel,
  resolveRef, resolvePlaceholders, expandHome,
};
