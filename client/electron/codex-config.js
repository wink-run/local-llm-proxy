// client/electron/codex-config.js
// Codex Desktop 纳管专用：对 ~/.codex/config.toml 做「外科手术式」合并编辑——
// 只增改我们的顶层标量(model_provider/model/model_catalog_json)与
// [model_providers.<id>] 段，其余原文(notify 数组 / [mcp_servers.*] 嵌套表 /
// [projects.'...'] 引号 key / plugins / marketplaces / desktop 等)一字不动。
// 不引第三方 TOML 库(遵循 injector.js 的项目约定)；用 state 精确还原。
//
// 为什么不用 injector.js：它的极简 TOML 逐行正则+整份重建，会把 Codex 复杂
// config.toml 的数组/嵌套表/引号 key 解析错并损坏。这里只碰自己那几处，绕开解析。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.tokenbank', 'applied');
const CATALOG_FILE = 'tokenbank-codex-catalog.json';

function ensureStateDir() { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); }
function statePath(configPath) {
  // 单机通常单个 codex 实例；用 config 路径做 key 以防多实例
  const tag = Buffer.from(String(configPath)).toString('hex').slice(0, 16);
  return path.join(STATE_DIR, `codex-${tag}.json`);
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const q = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

// ── 外科手术编辑：删掉我们旧的痕迹(记录旧值供还原) → 顶层 key 插到最前、段追加到末尾 ──
function editCodexToml(original, topKeys, providerId, sectionLines) {
  let lines = original.length ? original.split(/\r?\n/) : [];
  const state = { top: {}, section: null };
  const DEL = '\0DEL\0';

  // 顶层区域 = 第一个 [table] 行之前(TOML 顶层 key 必须在任何表之前)
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;

  // 顶层标量：记录旧值 + 标记删除(仅在顶层区域内，不碰表内同名 key)
  for (const key of Object.keys(topKeys)) {
    const re = new RegExp('^\\s*' + escapeRe(key) + '\\s*=\\s*(.*)$');
    let found = null;
    for (let i = 0; i < Math.min(topEnd, lines.length); i++) {
      const m = lines[i] != null && lines[i].match(re);
      if (m) { found = m[1].trim(); lines[i] = DEL; }
    }
    state.top[key] = found != null ? { existed: true, oldValue: found } : { existed: false };
  }
  lines = lines.filter((l) => l !== DEL);

  // [model_providers.<id>] 段：精确匹配到下一个 ^[ 或 EOF，记录旧内容后删除
  const secHeadRe = new RegExp('^\\s*\\[model_providers\\.' + escapeRe(providerId) + '\\]\\s*$');
  const secStart = lines.findIndex((l) => secHeadRe.test(l));
  if (secStart >= 0) {
    let secEnd = secStart + 1;
    while (secEnd < lines.length && !/^\s*\[/.test(lines[secEnd])) secEnd++;
    state.section = { existed: true, oldText: lines.slice(secStart, secEnd).join('\n') };
    lines.splice(secStart, secEnd - secStart);
  } else {
    state.section = { existed: false };
  }

  // 顶层 key 插到文件最前(合法：在所有表之前)；段追加到末尾
  const head = Object.entries(topKeys).map(([k, v]) => `${k} = ${v}`);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const out = [...head, ...lines, '', ...sectionLines, ''].join('\n');
  return { text: out, state };
}

/**
 * 纳管：把 Token Bank provider 写进 config.toml(合并、保留其他段)。
 * @param {string} configPath  ~/.codex/config.toml 绝对路径
 * @param {{providerId?, name?, baseUrl, model?, bearerToken?, catalogFile?}} opts
 */
function applyCodexProvider(configPath, opts = {}) {
  const {
    providerId = 'tokenbank', name = 'Tokenbank',
    baseUrl, model, bearerToken, catalogFile = CATALOG_FILE,
  } = opts;
  const dir = path.dirname(configPath);
  // 配置文件不存在则不新建：避免「自写 config.toml → 再判已安装」
  if (!fs.existsSync(configPath)) {
    return { ok: false, error: 'config-missing', path: configPath };
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existed = true;
  const original = fs.readFileSync(configPath, 'utf8');
  const bak = configPath + '.tokenbank-bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(configPath, bak);

  const topKeys = {
    model_provider: q(providerId),
    ...(model ? { model: q(model) } : {}),
    ...(catalogFile ? { model_catalog_json: q(catalogFile) } : {}),
  };
  const sectionLines = [
    `[model_providers.${providerId}]`,
    `name = ${q(name)}`,
    `base_url = ${q(baseUrl)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,          // 解锁 Codex Desktop 的 Model 门控
    ...(bearerToken ? [`experimental_bearer_token = ${q(bearerToken)}`] : []),
  ];

  const { text, state } = editCodexToml(original, topKeys, providerId, sectionLines);
  fs.writeFileSync(configPath, text, 'utf8');

  ensureStateDir();
  fs.writeFileSync(statePath(configPath), JSON.stringify({
    configPath, existed, backup: existed ? bak : null, providerId,
    top: state.top, section: state.section,
  }, null, 2), 'utf8');
  return { ok: true };
}

/** 还原：按 state 精确删除我们的顶层 key + 段、恢复旧值；失败回退整文件备份。 */
function revertCodexProvider(configPath) {
  const sp = statePath(configPath);
  const bak = configPath + '.tokenbank-bak';
  let st = null;
  try { st = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch {}
  if (!st) {
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, configPath); fs.unlinkSync(bak); return { ok: true, note: 'backup' }; }
    return { ok: true, note: 'no-state' };
  }
  try {
    if (!st.existed) {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } else {
      let lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
      const DEL = '\0DEL\0';
      const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
      const topEnd = firstTable < 0 ? lines.length : firstTable;
      // 删我们加的顶层 key(顶层区域内)
      for (const key of Object.keys(st.top || {})) {
        const re = new RegExp('^\\s*' + escapeRe(key) + '\\s*=');
        for (let i = 0; i < Math.min(topEnd, lines.length); i++) if (lines[i] != null && re.test(lines[i])) lines[i] = DEL;
      }
      lines = lines.filter((l) => l !== DEL);
      // 删我们的段
      const secHeadRe = new RegExp('^\\s*\\[model_providers\\.' + escapeRe(st.providerId) + '\\]\\s*$');
      const s = lines.findIndex((l) => secHeadRe.test(l));
      if (s >= 0) { let e = s + 1; while (e < lines.length && !/^\s*\[/.test(lines[e])) e++; lines.splice(s, e - s); }
      // 恢复旧的顶层 key / 旧段(纳管前若本就存在)
      const restore = [];
      for (const [key, rec] of Object.entries(st.top || {})) if (rec.existed) restore.push(`${key} = ${rec.oldValue}`);
      let tail = [];
      if (st.section && st.section.existed) tail = ['', ...st.section.oldText.split('\n')];
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      const out = [...restore, ...lines, ...tail].join('\n') + '\n';
      fs.writeFileSync(configPath, out, 'utf8');
    }
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
    fs.unlinkSync(sp);
    return { ok: true };
  } catch (e) {
    try {
      if (fs.existsSync(bak)) { fs.copyFileSync(bak, configPath); fs.unlinkSync(bak); }
      if (fs.existsSync(sp)) fs.unlinkSync(sp);
      return { ok: true, note: 'fallback-backup' };
    } catch (e2) { return { ok: false, error: e2.message }; }
  }
}

// ── Codex model_catalog_json 生成(照抄实测 schema，缺元数据用默认值) ──
function catalogModel(modelId, priority) {
  return {
    additional_speed_tiers: [], availability_nux: null,
    base_instructions: "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
    context_window: 128000, default_reasoning_level: 'high', default_reasoning_summary: 'none',
    description: modelId, display_name: modelId, effective_context_window_percent: 95,
    experimental_supported_tools: [], input_modalities: ['text'], max_context_window: 128000,
    priority, service_tiers: [], shell_type: 'shell_command', slug: modelId,
    support_verbosity: false, supported_in_api: true,
    supported_reasoning_levels: [
      { description: 'Disable Thinking', effort: 'none' },
      { description: 'Enabled Thinking', effort: 'high' },
    ],
    supports_image_detail_original: false, supports_parallel_tool_calls: false,
    supports_reasoning_summaries: true, supports_search_tool: false,
    truncation_policy: { limit: 10000, mode: 'bytes' }, upgrade: null, visibility: 'list',
  };
}

/** 生成 <codexHome>/tokenbank-codex-catalog.json，models 为模型名数组(去重、保序)。 */
function writeCodexCatalog(codexHome, models, fileName = CATALOG_FILE) {
  const uniq = [...new Set((models || []).filter(Boolean).map(String))];
  const doc = { models: uniq.map((m, i) => catalogModel(m, 1000 + i)) };
  const file = path.join(codexHome, fileName);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return { ok: true, count: uniq.length, file };
}

function removeCodexCatalog(codexHome, fileName = CATALOG_FILE) {
  try { const f = path.join(codexHome, fileName); if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

// ── 会话 provider 归一（让纳管态/直连态都看到全部会话）──
// Codex 会话 rollout 首行 session_meta 记了 payload.model_provider，Codex Desktop 按当前
// config 的 model_provider 过滤会话列表。切换纳管/直连时把所有 rollout 的 model_provider
// 归一到目标 provider，使当前 provider 组始终包含全部历史会话 → 两态都显示全部。
function retagRolloutProvider(file, target) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || !lines[i].trim()) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o && o.payload && typeof o.payload === 'object' && 'model_provider' in o.payload) {
      if (o.payload.model_provider === target) return false;      // 已是目标，跳过
      o.payload.model_provider = target;
      lines[i] = JSON.stringify(o);
      try { fs.writeFileSync(file, lines.join('\n'), 'utf8'); return true; } catch { return false; }
    }
  }
  return false;
}

/** 把 <codexHome>/sessions 下所有 rollout 的 model_provider 归一到 targetProvider。 */
function retagSessionsProvider(codexHome, targetProvider) {
  const root = path.join(codexHome, 'sessions');
  let changed = 0;
  let total = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^rollout-.+\.jsonl$/.test(e.name)) { total++; if (retagRolloutProvider(p, targetProvider)) changed++; }
    }
  };
  walk(root);
  return { changed, total };
}

// ── Codex Desktop 会话列表来源：state_*.sqlite 的 threads 表(按 model_provider 过滤)──
// 参考 cc-switch codex_history_migration：改 threads.model_provider 即可让 Desktop
// 在当前 provider 下显示这些会话。只改这一个字段，rollout_path 等不动。
function codexDebugLog(msg) {
  try { fs.appendFileSync(path.join(os.homedir(), '.tokenbank', 'codex-retag-debug.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

function retagThreadsProvider(codexHome, targetProvider) {
  let Database;
  try { Database = require('better-sqlite3'); }
  catch (e) { codexDebugLog('retagThreads: require better-sqlite3 FAILED: ' + (e && e.message)); return { changed: 0, dbs: 0, err: 'no-sqlite' }; }
  let dbs;
  try { dbs = fs.readdirSync(codexHome).filter((f) => /^state_\d+\.sqlite$/.test(f)); }
  catch (e) { codexDebugLog('retagThreads: readdir ' + codexHome + ' FAILED: ' + (e && e.message)); return { changed: 0, dbs: 0 }; }
  codexDebugLog(`retagThreads: home=${codexHome} target=${targetProvider} dbs=${JSON.stringify(dbs)}`);
  let changed = 0;
  for (const name of dbs) {
    const dbPath = path.join(codexHome, name);
    let conn;
    try {
      const bak = dbPath + '.tokenbank-bak';
      if (!fs.existsSync(bak)) { try { fs.copyFileSync(dbPath, bak); } catch {} }
      conn = new Database(dbPath, { timeout: 5000 });
      const tbl = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get();
      if (tbl) {
        const cols = conn.prepare('PRAGMA table_info(threads)').all().map((r) => r.name);
        if (cols.includes('model_provider')) {
          const r = conn.prepare('UPDATE threads SET model_provider = ? WHERE model_provider IS NOT ?').run(targetProvider, targetProvider);
          changed += r.changes || 0;
          codexDebugLog(`retagThreads: ${name} changed=${r.changes}`);
        } else codexDebugLog(`retagThreads: ${name} threads 无 model_provider 列`);
      } else codexDebugLog(`retagThreads: ${name} 无 threads 表`);
    } catch (e) { codexDebugLog(`retagThreads: ${name} UPDATE FAILED: ${e && e.message}`); }
    finally { try { conn && conn.close(); } catch {} }
  }
  return { changed, dbs: dbs.length };
}

/**
 * Codex 会话 provider 归一(纳管/直连切换时调)：threads sqlite(决定 Desktop 列表显示)
 * + rollout jsonl(保持一致，打开会话时 provider 匹配)一并归一到 targetProvider。
 */
function syncCodexSessionProvider(codexHome, targetProvider) {
  const threads = retagThreadsProvider(codexHome, targetProvider);
  const rollout = retagSessionsProvider(codexHome, targetProvider);
  return { threads, rollout };
}

// ── auth.json：官方登录态检测 + 清第三方残留 key(保留官方 tokens.*) ──
function readCodexAuth(codexHome) {
  try { return JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')); } catch { return null; }
}

/** Desktop 门控要求官方 OAuth 登录态(tokens.access_token)才放行自定义模型。 */
function codexHasOfficialLogin(codexHome) {
  const a = readCodexAuth(codexHome);
  return !!(a && a.tokens && a.tokens.access_token);
}

/** 清掉 auth.json 里第三方残留的 OPENAI_API_KEY(仅当官方登录态在时)，不动 tokens.*。 */
function cleanupThirdPartyAuthKey(codexHome) {
  const p = path.join(codexHome, 'auth.json');
  const a = readCodexAuth(codexHome);
  if (a && a.OPENAI_API_KEY && a.tokens && a.tokens.access_token) {
    a.OPENAI_API_KEY = null;
    try { fs.writeFileSync(p, JSON.stringify(a, null, 2), 'utf8'); } catch {}
  }
}

module.exports = {
  applyCodexProvider,
  revertCodexProvider,
  writeCodexCatalog,
  removeCodexCatalog,
  retagSessionsProvider,
  retagThreadsProvider,
  syncCodexSessionProvider,
  codexHasOfficialLogin,
  cleanupThirdPartyAuthKey,
  CATALOG_FILE,
  // 供单测
  editCodexToml,
};
