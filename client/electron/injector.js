// client/electron/injector.js
// config-file 策略的写入/精确还原（state-precise）。
//   apply：备份原文件 + patch（点路径 key）+ 写 state（记录每个 key 改前状态）
//   revert：按 state 精确回滚（existed→还原旧值，!existed→删除我们加的），失败回退整文件备份
// 仅依赖最小 TOML 读写（够 Codex config.toml 用），不引第三方 TOML 库以免增加依赖。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TB_DIR     = path.join(os.homedir(), '.tokenbank');
const STATE_DIR  = path.join(TB_DIR, 'applied');

function ensureStateDir() { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); }
function statePath(toolId) { return path.join(STATE_DIR, toolId + '.json'); }

// ── 极简 TOML 读写（支持顶层 key 与 [table] 下 key；够 codex 场景）─────────────
// 解析为 { 'model_provider': 'x', 'model_providers.tokenbank.base_url': 'y' } 扁平点路径表
function parseToml(text) {
  const flat = {};
  let curTable = '';
  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tbl = line.match(/^\[(.+)\]$/);
    if (tbl) { curTable = tbl[1].trim(); continue; }
    const kv = line.match(/^([A-Za-z0-9_.\-]+)\s*=\s*(.+)$/);
    if (kv) {
      const key = (curTable ? curTable + '.' : '') + kv[1].trim();
      flat[key] = stripTomlVal(kv[2].trim());
    }
  }
  return flat;
}
function stripTomlVal(v) {
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  return v;
}

// ── 格式判定 + JSON/YAML 的点路径深取/深设/深删 ──────────────────────────────
// config-file 工具可能是 TOML(codex) / JSON(opencode,openclaw) / YAML(hermes)。
function fmtOf(file) {
  if (/\.json$/i.test(file)) return 'json';
  if (/\.ya?ml$/i.test(file)) return 'yaml';
  return 'toml';
}
const SENTINEL = Symbol('missing');
function deepGet(obj, dotKey) {
  const parts = dotKey.split('.'); let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return SENTINEL;
  }
  return cur;
}
function deepSet(obj, dotKey, val) {
  const parts = dotKey.split('.'); let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}
function deepDelete(obj, dotKey) {
  const parts = dotKey.split('.');
  // 记录路径上每层容器，删完叶子后自底向上清理变空的父对象（只删我们注入时新建的空壳）
  const chain = [obj];
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] == null) return;
    cur = cur[parts[i]];
    chain.push(cur);
  }
  delete cur[parts[parts.length - 1]];
  // 自底向上：父对象若已空则删除
  for (let i = chain.length - 1; i > 0; i--) {
    const node = chain[i];
    if (node && typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length === 0) {
      delete chain[i - 1][parts[i - 1]];
    } else break;
  }
}
function parseObj(text, fmt) {
  if (!text) return {};
  try {
    if (fmt === 'json') return JSON.parse(text) || {};
    if (fmt === 'yaml') return require('js-yaml').load(text) || {};
  } catch {}
  return {};
}
function serializeObj(obj, fmt) {
  if (fmt === 'json') return JSON.stringify(obj, null, 2);
  return require('js-yaml').dump(obj, { lineWidth: 120 });
}
function tomlVal(v) {
  // 字符串加引号；布尔/数字原样
  if (v === 'true' || v === 'false' || /^-?\d+(\.\d+)?$/.test(String(v))) return String(v);
  return `"${String(v)}"`;
}

// 用扁平点路径表重建 TOML 文本（顶层 key 先写，再按 table 分组）
function buildToml(flat) {
  const top = [];
  const tables = {};
  for (const key of Object.keys(flat)) {
    const idx = key.lastIndexOf('.');
    if (idx < 0) { top.push([key, flat[key]]); }
    else {
      const tbl = key.slice(0, idx), k = key.slice(idx + 1);
      (tables[tbl] = tables[tbl] || []).push([k, flat[key]]);
    }
  }
  const lines = [];
  for (const [k, v] of top) lines.push(`${k} = ${tomlVal(v)}`);
  for (const tbl of Object.keys(tables)) {
    lines.push('', `[${tbl}]`);
    for (const [k, v] of tables[tbl]) lines.push(`${k} = ${tomlVal(v)}`);
  }
  return lines.join('\n') + '\n';
}

// ── env 策略：状态查询（实际写入由 shim 负责，这里只判断 shim 注入的 env 是否生效）──
// env 类的“是否已接入”由 detect-tools/config-loader 的 linked 判断，injector 不重复。

// ── config-file 策略 ─────────────────────────────────────────────────────────

// apply：patch 是扁平点路径表（占位符已解析）。按文件格式（TOML/JSON/YAML）分派。
function applyConfigFile(toolId, configFile, patch) {
  ensureStateDir();
  const dir = path.dirname(configFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existedFile = fs.existsSync(configFile);
  const originalText = existedFile ? fs.readFileSync(configFile, 'utf8') : '';
  const backup = configFile + '.tokenbank-bak';
  if (existedFile && !fs.existsSync(backup)) fs.copyFileSync(configFile, backup);

  const fmt = fmtOf(configFile);
  const applied = {};
  if (fmt === 'toml') {
    const flat = parseToml(originalText);
    for (const key of Object.keys(patch)) {
      applied[key] = (key in flat) ? { existed: true, oldValue: flat[key] } : { existed: false };
      flat[key] = patch[key];
    }
    fs.writeFileSync(configFile, buildToml(flat));
  } else {
    // JSON / YAML：解析成对象，按点路径深取旧值（用于精确还原）后深设
    const obj = parseObj(originalText, fmt);
    for (const key of Object.keys(patch)) {
      const old = deepGet(obj, key);
      applied[key] = (old !== SENTINEL) ? { existed: true, oldValue: old } : { existed: false };
      deepSet(obj, key, patch[key]);
    }
    fs.writeFileSync(configFile, serializeObj(obj, fmt));
  }

  fs.writeFileSync(statePath(toolId), JSON.stringify({
    tool: toolId, configFile, backup: existedFile ? backup : null,
    fileExisted: existedFile, format: fmt, applied,
  }, null, 2));
  return { ok: true };
}

// revert：按 state 精确回滚
function revertConfigFile(toolId) {
  const sp = statePath(toolId);
  if (!fs.existsSync(sp)) return { ok: true, note: 'no-state' };
  let st;
  try { st = JSON.parse(fs.readFileSync(sp, 'utf8')); }
  catch { return { ok: false, error: 'bad-state' }; }

  try {
    if (!st.fileExisted) {
      // 文件原本不存在 → 整个删掉（我们创建的）
      if (fs.existsSync(st.configFile)) fs.unlinkSync(st.configFile);
    } else {
      const fmt = st.format || fmtOf(st.configFile);
      const text = fs.readFileSync(st.configFile, 'utf8');
      if (fmt === 'toml') {
        const flat = parseToml(text);
        for (const key of Object.keys(st.applied)) {
          const rec = st.applied[key];
          if (rec.existed) flat[key] = rec.oldValue;   // 还原旧值
          else delete flat[key];                        // 删除我们加的
        }
        fs.writeFileSync(st.configFile, buildToml(flat));
      } else {
        const obj = parseObj(text, fmt);
        for (const key of Object.keys(st.applied)) {
          const rec = st.applied[key];
          if (rec.existed) deepSet(obj, key, rec.oldValue);  // 还原旧值
          else deepDelete(obj, key);                          // 删除我们加的
        }
        fs.writeFileSync(st.configFile, serializeObj(obj, fmt));
      }
    }
    if (st.backup && fs.existsSync(st.backup)) fs.unlinkSync(st.backup);
    fs.unlinkSync(sp);
    return { ok: true };
  } catch (e) {
    // 精确回滚失败 → 回退整文件备份
    try {
      if (st.backup && fs.existsSync(st.backup)) {
        fs.copyFileSync(st.backup, st.configFile);
        fs.unlinkSync(st.backup);
      }
      fs.unlinkSync(sp);
      return { ok: true, note: 'fallback-backup' };
    } catch (e2) { return { ok: false, error: e2.message }; }
  }
}

// status：config-file 当前是否指向网关（文件内任意字符串值含网关 host:port 即视为已接入）
function statusConfigFile(configFile, gatewayHostPort) {
  if (!fs.existsSync(configFile)) return false;
  const text = fs.readFileSync(configFile, 'utf8');
  const fmt = fmtOf(configFile);
  if (fmt === 'toml') {
    const flat = parseToml(text);
    return Object.values(flat).some(v => typeof v === 'string' && v.includes(gatewayHostPort));
  }
  // JSON/YAML：直接在原文里找网关地址（够判断是否已注入）
  return text.includes(gatewayHostPort);
}

module.exports = {
  applyConfigFile, revertConfigFile, statusConfigFile,
  _internal: { parseToml, buildToml },
};
