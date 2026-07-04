// trae-session-sync.js — 从 Trae session_memory + ai-agent 日志同步会话用量 JSONL
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { traeLogsDir, traeSessionsExportDir } = require('./trae-support');

const EXPORT_FILE = 'usage.jsonl';
const STATE_FILE = 'sync-state.json';
const MEMORY_ROOT = path.join(os.homedir(), '.trae-cn', 'memory', 'projects');

/** 解析 ai-agent stdout 行中的 session / workspace / 时间戳 */
function parseLogLine(line) {
  const out = {};
  const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.+-]+)/);
  if (tsMatch) {
    const ms = Date.parse(tsMatch[1]);
    if (!Number.isNaN(ms)) out.ts = Math.floor(ms / 1000);
  }
  const sid = line.match(/chat_session_id:\s*"([0-9a-f]{24})"/i)
    || line.match(/session_id[=:\s]+(?:Some\(")?([0-9a-f]{24})/i)
    || line.match(/"session_id":\s*String\("([0-9a-f]{24})"/);
  if (sid) out.session_id = sid[1];
  const ws = line.match(/workspace_folder:\s*Some\("([^"]+)"/)
    || line.match(/project_local_path:\s*String\("([^"]+)"/)
    || line.match(/main_folder:\s*Some\("([^"]+)"/);
  if (ws) out.project_path = ws[1];
  const model = line.match(/"model_name":\s*String\("([^"]+)"/)
    || line.match(/model_name:\s*"([^"]+)"/);
  if (model && model[1] && model[1] !== 'auto') out.model = model[1];
  return out;
}

/** 从 send_message / create_chat_session 日志提取用户 query 文本 */
function parseUserQuery(line) {
  const m = line.match(/query:\s*Some\("(\[\{.*?\}\])"\)/)
    || line.match(/"query":\s*String\("(\[\{.*?\}\])"\)/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1].replace(/\\"/g, '"'));
    const parts = [];
    for (const item of arr) {
      const c = item?.data?.content ?? item?.content;
      if (c) parts.push(String(c));
    }
    return parts.join('\n').trim() || null;
  } catch {
    const inner = m[1].match(/"content":"((?:\\.|[^"\\])*)"/);
    return inner ? inner[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;
  }
}

/** 粗估 token（官方订阅无本地 usage 时的 fallback） */
function estimateTokens(text) {
  const n = String(text || '').trim().length;
  return n ? Math.max(1, Math.ceil(n / 4)) : 0;
}

function parseSummaryTime(s) {
  if (!s) return null;
  const ms = Date.parse(String(s).replace(' ', 'T') + '+08:00');
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

function rowKey(r) {
  const content = r.message?.content || '';
  return [
    r.session_id,
    r.type,
    r.message_id || '',
    r.step_kind || '',
    r._source || '',
    r.type === 'user' ? content : content.slice(0, 80),
  ].join('|');
}

/** 归一化用户 query，用于去重 */
function normalizeQueryText(s) {
  return String(s || '').replace(/\s+/g, '').trim();
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** memory 已有相近 user 文本时跳过 renderer 重复写入（避免短 query 误匹配长摘要） */
function isDuplicateUserQuery(existingTexts, query) {
  const q = normalizeQueryText(query);
  if (!q) return true;
  for (const raw of existingTexts || []) {
    const t = normalizeQueryText(raw);
    if (!t) continue;
    if (t === q) return true;
    const minLen = Math.min(t.length, q.length);
    const maxLen = Math.max(t.length, q.length);
    const prefix = commonPrefixLen(t, q);
    // 长度接近且互为子串，或共享足够长前缀 → 视为同一轮
    if (minLen >= 4 && maxLen > 0 && minLen / maxLen >= 0.55) {
      if (t.includes(q) || q.includes(t)) return true;
    }
    if (prefix >= 7 && minLen / maxLen >= 0.5) return true;
  }
  return false;
}

/** 解析 renderer.log MetadataHandler 行（solo_work_lite 任务） */
function parseRendererMetadata(line) {
  const m = line.match(/\[MetadataHandler\] received metadata (\{.*\})\s*$/);
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]);
    const ctx = meta.user_message_context || {};
    const queries = ctx.parsed_query;
    const query = Array.isArray(queries) ? queries.map(String).join('\n').trim()
      : (typeof queries === 'string' ? queries.trim() : '');
    if (!query) return null;
    const session_id = meta.session_id || meta.sessionId;
    const agent_message_id = meta.message_id;
    if (!session_id || !agent_message_id) return null;
    return {
      session_id,
      agent_message_id,
      reply_to_message_id: meta.reply_to_message_id || null,
      timestamp: Number(meta.created_at) || null,
      query,
      model: ctx.model_info?.config_name || ctx.model_info?.model_name || '',
    };
  } catch { return null; }
}

/** 解析 renderer.log DoneHandler 行（任务流结束） */
function parseRendererDone(line) {
  const m = line.match(/\[DoneHandler\] Stream done event received (\{.*\})\s*$/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]);
    if (d.status !== 'completed') return null;
    const session_id = d.sessionId || d.session_id;
    const agent_message_id = d.agentMessageId || d.agent_message_id;
    if (!session_id || !agent_message_id) return null;
    return { session_id, agent_message_id };
  } catch { return null; }
}

/** 从 renderer.log 补全已完成但 session_memory 尚未写入的 user+assistant 配对 */
function syncFromRendererLogs(state, memoryIndex) {
  const logsRoot = traeLogsDir();
  if (!logsRoot || !fs.existsSync(logsRoot)) return [];

  const exported = new Set(state.exportedRendererTasks || []);
  const pending = new Map(); // agent_message_id → meta
  const completed = new Set();

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/renderer\.log$/i.test(ent.name)) {
        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          const meta = parseRendererMetadata(line);
          if (meta) pending.set(meta.agent_message_id, meta);
          const done = parseRendererDone(line);
          if (done) completed.add(done.agent_message_id);
        }
      }
    }
  };
  walk(logsRoot);

  const rows = [];
  for (const agentId of completed) {
    if (exported.has(agentId)) continue;
    const meta = pending.get(agentId);
    if (!meta?.session_id || !meta.query) continue;
    // memory 已有同 message_id 轮次则跳过
    if (memoryIndex.messageIds.has(meta.reply_to_message_id) && memoryIndex.byMessage.has(meta.reply_to_message_id)) {
      // reply_to 仅指链上父消息；若 query 与 memory 不同则仍是新轮
      const memUser = memoryIndex.byMessage.get(meta.reply_to_message_id)?.userText;
      if (memUser && normalizeQueryText(memUser) === normalizeQueryText(meta.query)) continue;
    }
    const memTexts = memoryIndex.userTextsBySession.get(meta.session_id);
    if (isDuplicateUserQuery(memTexts, meta.query)) continue;

    const ts = meta.timestamp || Math.floor(Date.now() / 1000);
    const userMsgId = `${agentId}-user`;
    rows.push({
      type: 'user',
      session_id: meta.session_id,
      message_id: userMsgId,
      timestamp: ts,
      message: { content: meta.query },
      _source: 'trae-renderer',
    });
    rows.push({
      type: 'assistant',
      session_id: meta.session_id,
      message_id: agentId,
      step_kind: 'outcome',
      timestamp: ts + 1,
      message: {
        content: 'Trae Work 已完成回复（会话摘要同步中，稍后可在 trace 中查看详情）',
        model: meta.model || 'auto',
        usage: { input_tokens: estimateTokens(meta.query), output_tokens: 1 },
      },
      _source: 'trae-renderer',
    });
    exported.add(agentId);
  }

  state.exportedRendererTasks = [...exported].slice(-2000);
  return rows;
}

/** 构建 memory 索引，供 renderer 去重 */
function buildMemoryIndex(memoryRows) {
  const messageIds = new Set();
  const userTextsBySession = new Map();
  const byMessage = new Map();

  for (const r of memoryRows) {
    if (r.message_id) messageIds.add(r.message_id);
    if (r.type === 'user' && r.session_id) {
      if (!userTextsBySession.has(r.session_id)) userTextsBySession.set(r.session_id, []);
      userTextsBySession.get(r.session_id).push(r.message?.content || '');
      if (r.message_id) {
        byMessage.set(r.message_id, { userText: r.message?.content || '' });
      }
    }
  }
  return { messageIds, userTextsBySession, byMessage };
}

/** 去掉 trae-log 孤儿 user，以及各 session 末尾无 assistant 的 user */
function dropOrphanTailUsers(rows) {
  const out = rows.filter(r => !(r.type === 'user' && r._source === 'trae-log'));
  const bySession = new Map();
  for (const r of out) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }
  const dropKeys = new Set();
  for (const recs of bySession.values()) {
    for (let i = recs.length - 1; i >= 0; i--) {
      if (recs[i].type !== 'user') break;
      const hasAssistantAfter = recs.slice(i + 1).some(x => x.type === 'assistant');
      if (!hasAssistantAfter) dropKeys.add(rowKey(recs[i]));
      else break;
    }
  }
  return out.filter(r => !dropKeys.has(rowKey(r)));
}

/** 从 ~/.trae-cn/memory/.../session_memory_{id}.jsonl 提取完整会话 trace */
function syncFromSessionMemory() {
  const rows = [];
  if (!fs.existsSync(MEMORY_ROOT)) return rows;

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/^session_memory_([0-9a-f]{24})\.jsonl$/i.test(ent.name)) {
        const session_id = ent.name.match(/^session_memory_([0-9a-f]{24})\.jsonl$/i)[1];
        // 父目录名含 work-mode-projects/{projectId}
        const projectMatch = full.match(/work-mode-projects-([0-9a-f]{24})/i);
        const project_path = projectMatch
          ? path.join(
            os.homedir(),
            'Library/Application Support/TRAE SOLO CN/ModularData/ai-agent/work-mode-projects',
            projectMatch[1],
          )
          : '';

        for (const mem of readJsonl(full)) {
          const ts = parseSummaryTime(mem.message_summary_time) || Math.floor(Date.now() / 1000);
          const intent = String(mem.intent || '').trim();
          const actions = Array.isArray(mem.actions) ? mem.actions.map(String).filter(Boolean) : [];
          const outcome = String(mem.outcome || '').trim();
          const learned = Array.isArray(mem.learned) ? mem.learned.map(String).filter(Boolean) : [];
          const message_id = mem.message_id || null;

          if (intent) {
            rows.push({
              type: 'user',
              session_id,
              message_id,
              timestamp: ts,
              project_path,
              message: { content: intent },
              _source: 'trae-memory',
            });
          }

          for (let i = 0; i < actions.length; i++) {
            rows.push({
              type: 'assistant',
              session_id,
              message_id,
              step_kind: `action:${i}`,
              timestamp: ts,
              project_path,
              message: {
                content: actions[i],
                model: 'auto',
                usage: { input_tokens: 0, output_tokens: estimateTokens(actions[i]) },
              },
              _source: 'trae-memory',
            });
          }

          const assistantText = [outcome, learned.length ? `要点：\n${learned.map(x => `- ${x}`).join('\n')}` : '']
            .filter(Boolean).join('\n\n');
          if (assistantText) {
            rows.push({
              type: 'assistant',
              session_id,
              message_id,
              step_kind: 'outcome',
              timestamp: ts,
              project_path,
              message: {
                content: assistantText,
                model: 'auto',
                usage: {
                  input_tokens: estimateTokens(intent),
                  output_tokens: estimateTokens(assistantText),
                },
              },
              _source: 'trae-memory',
            });
          }
        }
      }
    }
  };
  walk(MEMORY_ROOT);
  return rows;
}

/** 扫描日志补充 workspace / 模型信息（不再写入仅 user 的孤儿行） */
function syncMetaFromTraeLogs(state) {
  const logsRoot = traeLogsDir();
  if (!logsRoot || !fs.existsSync(logsRoot)) return { meta: new Map() };

  const meta = new Map(); // session_id → { project_path, model, queries[] }
  const seen = new Set(state.seenKeys || []);

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/ai-agent.*stdout\.log$/i.test(ent.name)) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const key = `${full}:${st.size}:${Math.floor(st.mtimeMs)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          const parsed = parseLogLine(line);
          const sid = parsed.session_id;
          if (!sid) continue;
          if (!meta.has(sid)) meta.set(sid, { project_path: '', model: '', queries: [] });
          const m = meta.get(sid);
          if (parsed.project_path) m.project_path = parsed.project_path;
          if (parsed.model) m.model = parsed.model;
        }
      }
    }
  };
  walk(logsRoot);
  state.seenKeys = [...seen].slice(-500);

  return { meta };
}

/** 合并 bridge / 外部写入的 incoming/*.jsonl */
function mergeIncoming(exportDir) {
  const incoming = path.join(exportDir, 'incoming');
  if (!fs.existsSync(incoming)) return [];
  const rows = [];
  for (const name of fs.readdirSync(incoming)) {
    if (!/\.jsonl$/i.test(name)) continue;
    rows.push(...readJsonl(path.join(incoming, name)));
    try { fs.unlinkSync(path.join(incoming, name)); } catch {}
  }
  return rows;
}

/** 去重合并后写回 usage.jsonl */
function rebuildExport(exportDir, incomingRows) {
  const byKey = new Map();
  const memoryRows = syncFromSessionMemory();
  const memoryIndex = buildMemoryIndex(memoryRows);

  const add = (r) => {
    if (!r?.session_id) return;
    const k = rowKey(r);
    if (!byKey.has(k)) byKey.set(k, r);
  };

  for (const r of memoryRows) add(r);
  for (const r of incomingRows) add(r);

  const state = { seenKeys: [], exportedRendererTasks: [] };
  try {
    const statePath = path.join(exportDir, STATE_FILE);
    if (fs.existsSync(statePath)) {
      Object.assign(state, JSON.parse(fs.readFileSync(statePath, 'utf8')));
    }
  } catch {}

  const { meta } = syncMetaFromTraeLogs(state);
  for (const r of syncFromRendererLogs(state, memoryIndex)) add(r);

  // 为 memory 行补全 project_path
  for (const r of byKey.values()) {
    if (!r.project_path && meta.has(r.session_id)) {
      r.project_path = meta.get(r.session_id).project_path || r.project_path;
    }
  }

  let sorted = [...byKey.values()].sort((a, b) => {
    const ta = a.timestamp || 0;
    const tb = b.timestamp || 0;
    if (ta !== tb) return ta - tb;
    const order = { user: 0, assistant: 1 };
    return (order[a.type] ?? 2) - (order[b.type] ?? 2);
  });
  sorted = dropOrphanTailUsers(sorted);

  const usagePath = path.join(exportDir, EXPORT_FILE);
  fs.writeFileSync(
    usagePath,
    sorted.length ? sorted.map(r => JSON.stringify(r)).join('\n') + '\n' : '',
    'utf8',
  );

  try {
    fs.writeFileSync(path.join(exportDir, STATE_FILE), JSON.stringify(state), 'utf8');
  } catch {}

  return sorted.length;
}

/** 导入前同步 Trae 会话到 ~/.tokenbank/trae-sessions/usage.jsonl */
function syncTraeSessions() {
  const exportDir = traeSessionsExportDir();
  try { fs.mkdirSync(exportDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(path.join(exportDir, 'incoming'), { recursive: true }); } catch {}

  const incoming = mergeIncoming(exportDir);
  return rebuildExport(exportDir, incoming);
}

module.exports = {
  syncTraeSessions,
  syncFromSessionMemory,
  syncFromRendererLogs,
  parseUserQuery,
  parseRendererMetadata,
  parseRendererDone,
  normalizeQueryText,
  isDuplicateUserQuery,
  dropOrphanTailUsers,
  estimateTokens,
  traeSessionsExportDir,
  EXPORT_FILE,
  MEMORY_ROOT,
};
