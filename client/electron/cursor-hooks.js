'use strict';
// Cursor 纳管：安装/卸载 ~/.cursor/hooks.json，并把 hook 事件导入 local-stats。

const fs = require('fs');
const path = require('path');
const os = require('os');

const CURSOR_HOOKS_JSON = path.join(os.homedir(), '.cursor', 'hooks.json');
const TB_HOOK_DIR = path.join(os.homedir(), '.tokenbank', 'hooks');
const TB_HOOK_JS = path.join(TB_HOOK_DIR, 'cursor-token-stop.js');
const TB_HOOK_LOG_JS = path.join(TB_HOOK_DIR, 'cursor-hooks-log.js');
const TB_HOOK_SH = path.join(TB_HOOK_DIR, 'cursor-token-stop.sh');
const TB_EVENTS = path.join(os.homedir(), '.tokenbank', 'cursor-hook-events.jsonl');
const HOOK_CMD_MARKER = '.tokenbank/hooks/cursor-token-stop.sh';
const { hookLog } = require('./hooks/cursor-hooks-log');

/** 从 Cursor 本地库查用户发消息时间（秒） */
function lookupPromptTsSec(generationId) {
  if (!generationId) return null;
  const dbPath = path.join(
    os.homedir(),
    'Library/Application Support/Cursor/User/workspaceStorage/empty-window/state.vscdb',
  );
  if (process.platform !== 'darwin' || !fs.existsSync(dbPath)) return null;
  try {
    const Database = require('better-sqlite3');
    const row = new Database(dbPath, { readonly: true })
      .prepare("SELECT value FROM ItemTable WHERE key='aiService.generations'")
      .get();
    if (!row?.value) return null;
    const list = JSON.parse(row.value);
    for (const item of list) {
      if (item.generationUUID === generationId && item.unixMs) {
        return Math.floor(Number(item.unixMs) / 1000);
      }
    }
  } catch { /* 非关键路径 */ }
  return null;
}

function bundledHookJs(name) {
  return path.join(__dirname, 'hooks', name);
}

function readHooksJson() {
  if (!fs.existsSync(CURSOR_HOOKS_JSON)) return { version: 1, hooks: {} };
  try {
    const data = JSON.parse(fs.readFileSync(CURSOR_HOOKS_JSON, 'utf8'));
    if (!data || typeof data !== 'object') return { version: 1, hooks: {} };
    data.hooks = data.hooks || {};
    data.version = data.version || 1;
    return data;
  } catch {
    return { version: 1, hooks: {} };
  }
}

function writeHooksJson(data) {
  fs.mkdirSync(path.dirname(CURSOR_HOOKS_JSON), { recursive: true });
  fs.writeFileSync(CURSOR_HOOKS_JSON, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function isOurHook(entry) {
  const cmd = String(entry?.command || '');
  return cmd.includes(HOOK_CMD_MARKER);
}

/** 写入 hook 脚本与 launcher */
function materializeHookRunner(execPath) {
  fs.mkdirSync(TB_HOOK_DIR, { recursive: true });
  fs.copyFileSync(bundledHookJs('cursor-token-stop.js'), TB_HOOK_JS);
  fs.copyFileSync(bundledHookJs('cursor-hooks-log.js'), TB_HOOK_LOG_JS);

  const sh = [
    '#!/bin/bash',
    'export ELECTRON_RUN_AS_NODE=1',
    `exec ${JSON.stringify(execPath)} ${JSON.stringify(TB_HOOK_JS)}`,
    '',
  ].join('\n');
  fs.writeFileSync(TB_HOOK_SH, sh, { mode: 0o755 });
}

/** 纳管 Cursor：安装 stop hook（合并已有 hooks.json） */
function install(execPath) {
  materializeHookRunner(execPath);
  const hooks = readHooksJson();
  const list = Array.isArray(hooks.hooks.stop) ? hooks.hooks.stop.filter(h => !isOurHook(h)) : [];
  // 用户级 hooks 从 ~/.cursor/ 运行，command 用 ~/.tokenbank 下的绝对路径
  list.push({ command: TB_HOOK_SH });
  hooks.hooks.stop = list;
  writeHooksJson(hooks);
  return { ok: true, command: TB_HOOK_SH };
}

/** 还原 Cursor：移除 Token Bank 的 stop hook */
function uninstall() {
  const hooks = readHooksJson();
  const before = Array.isArray(hooks.hooks.stop) ? hooks.hooks.stop.length : 0;
  hooks.hooks.stop = (hooks.hooks.stop || []).filter(h => !isOurHook(h));
  if (hooks.hooks.stop.length !== before) writeHooksJson(hooks);
  try { if (fs.existsSync(TB_HOOK_SH)) fs.unlinkSync(TB_HOOK_SH); } catch {}
  try { if (fs.existsSync(TB_HOOK_JS)) fs.unlinkSync(TB_HOOK_JS); } catch {}
  try { if (fs.existsSync(TB_HOOK_LOG_JS)) fs.unlinkSync(TB_HOOK_LOG_JS); } catch {}
  return { ok: true };
}

function isInstalled() {
  const hooks = readHooksJson();
  return (hooks.hooks.stop || []).some(isOurHook);
}

/** 将 hook 事件导入 SQLite（session-cursor + request_id 去重），成功后清空 jsonl 队列 */
function importEvents(localStats, { appId = 'app-direct-cursor', eventsPath = TB_EVENTS } = {}) {
  if (!localStats?.record || !fs.existsSync(eventsPath)) return 0;

  let lines;
  try {
    lines = fs.readFileSync(eventsPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return 0;
  }
  if (!lines.length) return 0;

  let imported = 0;
  const pending = [];
  const importedEvents = [];

  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.generation_id) continue;

    const ts = lookupPromptTsSec(e.generation_id) || e.ts || Math.floor(Date.now() / 1000);
    const modelRaw = e.model || null;
    const model = modelRaw && modelRaw !== 'default' ? modelRaw : 'cursor-agent';

    try {
      const ok = localStats.record({
        ts,
        app_id: appId,
        model,
        provider_id: 'cursor',
        tier: 'paid',
        billing_type: 'subscription',
        input_tokens: e.input_tokens || 0,
        output_tokens: e.output_tokens || 0,
        cache_read_tokens: e.cache_read_tokens || 0,
        cache_create_tokens: e.cache_write_tokens || 0,
        request_id: `cursor-hook:${e.generation_id}`,
        data_source: 'session-cursor',
        session_id: e.conversation_id || null,
        status_code: e.status === 'completed' ? 200 : 499,
        is_streaming: false,
      });
      if (ok) {
        imported++;
        importedEvents.push({ generation_id: e.generation_id, model, ...e });
      }
    } catch {
      pending.push(line);
    }
  }

  try {
    if (pending.length) fs.writeFileSync(eventsPath, `${pending.join('\n')}\n`, 'utf8');
    else fs.writeFileSync(eventsPath, '', 'utf8');
  } catch {}

  hookLog('importEvents', {
    total: lines.length,
    imported,
    pending: pending.length,
    events: importedEvents,
  });

  return imported;
}

/** 清除 transcript 补录的 0 token 行（request_id 形如 cursor:…，保留 cursor-hook:…） */
function purgeTranscriptZeroTokens(localStats) {
  if (!localStats?.deleteZeroTokenSessionRows) return 0;
  return localStats.deleteZeroTokenSessionRows({
    dataSource: 'session-cursor',
    requestIdLike: 'cursor:%',
  });
}

/** 根据 Cursor 纳管状态同步 hook */
function syncForApps(apps, execPath) {
  const cursor = (apps || []).find(a => a.link_method === 'direct' && a.agent_id === 'cursor');
  if (cursor?.hosted) return install(execPath);
  if (isInstalled()) return uninstall();
  return { ok: true, skipped: true };
}

module.exports = {
  install,
  uninstall,
  isInstalled,
  importEvents,
  purgeTranscriptZeroTokens,
  syncForApps,
  TB_EVENTS,
};
