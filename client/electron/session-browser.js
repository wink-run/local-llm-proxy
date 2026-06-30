// session-browser.js — 会话 trace 编排层（各应用解析逻辑在 session-trace/ 适配器中）
'use strict';

const fs = require('fs');
const {
  extractContext, msgText, sanitizeCursorText, toolResultText,
  resolveProjectName, shortProjectName, buildTraceStats, formatDuration,
} = require('./session-trace/shared');
const { buildClaudeStyleSteps } = require('./session-trace/claude-jsonl');
const registry = require('./session-trace/registry');

/** 用 DB 统计补全 Token / 持续时间 / 费用 */
function enrichTraceWithDb(trace, dbRow) {
  if (!trace || trace.error || !dbRow) return trace;
  const stats = { ...(trace.stats || {}) };
  stats.tokens = stats.tokens || { input: 0, output: 0, cached: 0 };
  if (dbRow.inTok) stats.tokens.input = dbRow.inTok;
  if (dbRow.outTok) stats.tokens.output = dbRow.outTok;
  if (dbRow.cached) stats.tokens.cached = dbRow.cached;
  if (dbRow.firstTs && dbRow.lastTs && dbRow.lastTs > dbRow.firstTs) {
    stats.duration_ms = (dbRow.lastTs - dbRow.firstTs) * 1000;
    stats.duration = formatDuration(stats.duration_ms);
  }
  if (dbRow.calls) stats.db_calls = dbRow.calls;
  if (dbRow.cost_usd) stats.cost_usd = dbRow.cost_usd;
  return { ...trace, stats };
}

/** 规范化 activity 行：同步修正 project / project_path */
function normalizeActivityRow(row, agentId) {
  if (!row) return row;
  const sessionFile = row.session_id ? registry.findSessionFile(agentId, row.session_id) : null;
  const { project, project_path } = resolveProjectName({
    projectPath: row.project_path || row.project,
    sessionFile,
    agentId,
    cwdHint: row.cwd,
  });
  return { ...row, project, project_path };
}

/** 合并 DB 统计与会话文件扫描结果 */
function mergeActivityWithStats(activity, dbSessions = []) {
  const byId = Object.fromEntries((dbSessions || []).map(s => [s.session_id, s]));
  return activity.map(a => {
    const db = byId[a.session_id];
    if (!db) return a;
    const dbCost = Number(db.cost_usd) || 0;
    return {
      ...a,
      calls: db.calls || a.calls,
      tokens: db.tokens || a.tokens,
      lastTs: db.lastTs || a.lastTs,
      cost_usd: dbCost > 0 ? dbCost : (Number(a.cost_usd) || 0),
    };
  });
}

/** 从单条 assistant/user 记录提取可读标签（用于最近明细） */
function assistantLineLabel(data) {
  if (!data || typeof data !== 'object') return 'assistant';
  const role = data.role || data.type;
  if (role === 'user' || data.type === 'user') {
    const t = extractContext(msgText(data.message));
    return t ? t.slice(0, 60) : 'User prompt';
  }
  const msg = data.message || {};
  const content = msg.content;
  if (Array.isArray(content)) {
    const tools = content
      .filter(x => x?.type === 'tool_use' || x?.type === 'tool-call')
      .map(x => x.name)
      .filter(Boolean);
    if (tools.length) {
      const uniq = [...new Set(tools)];
      return uniq.slice(0, 4).join(' · ') + (uniq.length > 4 ? ' …' : '');
    }
    const text = content.find(x => x?.type === 'text')?.text;
    if (text) {
      const t = extractContext(sanitizeCursorText(String(text)));
      if (t) return t.slice(0, 60);
    }
  }
  const plain = msgText(msg);
  if (plain) return extractContext(plain).slice(0, 60) || 'assistant';
  return 'assistant';
}

/** 定位会话文件（兼容旧 API 名 findSessionJsonl） */
function findSessionJsonl(agentId, sessionId) {
  return registry.findSessionFile(agentId, sessionId);
}

/** 补全最近明细：从 jsonl 解析工具名/上下文 */
function enrichRecentDetail(agentId, recent, activity = []) {
  const actBySid = Object.fromEntries((activity || []).map(a => [a.session_id, a]));
  const lineCache = {};

  return (recent || []).map(r => {
    let label = r.label || r.model;
    let context = r.context;
    let row = { ...r };

    const rid = String(r.request_id || '');
    const lineIdx = /:(\d+)$/.test(rid) ? +rid.replace(/^.*:/, '') : null;

    if (lineIdx != null && r.session_id) {
      if (!lineCache[r.session_id]) {
        const f = findSessionJsonl(agentId, r.session_id);
        if (f) {
          let st;
          try { st = fs.statSync(f); } catch { st = null; }
          const lines = fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
          lineCache[r.session_id] = { lines, st };
        } else {
          lineCache[r.session_id] = { lines: [], st: null };
        }
      }
      const { lines, st } = lineCache[r.session_id];
      const line = lines[lineIdx];
      if (line) {
        try { label = assistantLineLabel(JSON.parse(line)); } catch {}
      }
      if (st && lines.length > 0) {
        const span = Math.max(st.mtimeMs - st.birthtimeMs, lines.length * 500);
        row = { ...row, ts: Math.floor((st.birthtimeMs + (lineIdx / lines.length) * span) / 1000) };
      }
    }

    const act = actBySid[r.session_id];
    if (!context && act?.context) context = act.context;
    if (!label) {
      label = context ? context.slice(0, 60) : (act?.project ? `${act.project}` : null);
    }
    return { ...row, label: label || 'assistant', context: context || act?.context };
  });
}

function getTrace(agentId, sessionId, handlerOverride) {
  const raw = handlerOverride
    ? registry.traceForAdapter(handlerOverride, sessionId)
    : registry.getTrace(agentId, sessionId);
  if (raw.error || !sessionId) return raw;
  const sessionFile = findSessionJsonl(agentId, sessionId);
  const { project, project_path } = resolveProjectName({
    projectPath: raw.project_path || raw.project,
    sessionFile,
    agentId,
    cwdHint: raw.cwd,
  });
  return { ...raw, project, project_path, cwd: project_path };
}

function getTraceForEntity(entity, sessionId) {
  const adapter = registry.resolveTraceAdapter(entity);
  const agentId = entity?.trace_agent_id || entity?.activity_agent_id || entity?.id;
  return getTrace(agentId, sessionId, adapter);
}

function listAllSessions(opts = {}) {
  return registry.listAllFromAdapters(opts);
}

module.exports = {
  // 编排 API
  listActivity: registry.listActivity,
  listActivityForEntity: registry.listActivityForEntity,
  getTrace,
  getTraceForEntity,
  entrypointMatchForEntity: registry.entrypointMatchForEntity,
  resolveTraceHandler: registry.resolveTraceAdapter,
  PROFILE_HANDLERS: registry.PROFILE_ADAPTERS,
  mergeActivityWithStats,
  enrichTraceWithDb,
  enrichRecentDetail,
  assistantLineLabel,
  listAllSessions,
  findSessionJsonl,
  // 共享工具（测试 / session-import 复用）
  extractContext,
  sanitizeCursorText,
  shortProjectName,
  normalizeActivityRow,
  buildClaudeStyleSteps,
  buildTraceStats,
  toolResultText,
};
