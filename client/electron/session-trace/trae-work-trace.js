// session-trace/trae-work-trace.js — Trae Work 官方订阅：trace 来自 session_memory 导出
'use strict';

const fs = require('fs');
const path = require('path');
const { extractContext, buildTraceStats, fileTimeSpan, stepTs } = require('./shared');
const { traeLogsDir, traeSessionsExportDir } = require('../trae-support');
const { EXPORT_FILE } = require('../trae-session-sync');

const AGENT_ID = 'trae-work';
const PROFILE = 'trae-work-trace';

function readUsageRows() {
  const file = path.join(traeSessionsExportDir(), EXPORT_FILE);
  if (!fs.existsSync(file)) return [];
  const bySession = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    const sid = rec.session_id || rec.sessionId;
    if (!sid) continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(rec);
  }
  return bySession;
}

function projectLabelFromPath(p) {
  if (!p) return 'Trae Work';
  const base = path.basename(String(p).replace(/\/$/, ''));
  if (/^[0-9a-f]{24}$/i.test(base)) return `Trae Work · ${base.slice(0, 8)}`;
  return base || 'Trae Work';
}

function summarizeSession(sessionId, rows) {
  let context = '';
  let calls = 0;
  let inTok = 0;
  let outTok = 0;
  let lastTs = 0;
  let model = 'auto';
  let project_path = '';

  for (const rec of rows) {
    if (rec.project_path) project_path = rec.project_path;
    const ts = rec.timestamp || rec.ts || 0;
    if (ts) lastTs = Math.max(lastTs, ts);
    const usage = rec.message?.usage || rec.usage || {};
    const inT = usage.input_tokens || usage.prompt_tokens || 0;
    const outT = usage.output_tokens || usage.completion_tokens || 0;
    if (rec.type === 'assistant' && (inT || outT)) {
      calls++;
      inTok += inT;
      outTok += outT;
    }
    if (rec.message?.model && rec.message.model !== 'trae-work') model = rec.message.model;
    const text = rec.message?.content || rec.content || rec.text || '';
    if (!context && text && rec.type === 'user') context = extractContext(String(text));
    if (!context && text && rec.type === 'assistant' && rec.step_kind === 'outcome') {
      context = extractContext(String(text));
    }
  }

  return {
    session_id: sessionId,
    project: projectLabelFromPath(project_path),
    project_path: project_path || sessionId,
    context: context || '(Trae Work 会话)',
    calls,
    tokens: inTok + outTok,
    inTok,
    outTok,
    lastTs,
    model,
    agent: AGENT_ID,
  };
}

function list(opts = {}) {
  const bySession = readUsageRows();
  const rows = [];
  for (const [sid, recs] of bySession.entries()) {
    rows.push(summarizeSession(sid, recs));
  }
  rows.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const limit = opts.limit || 50;
  return rows.slice(0, limit);
}

function recordToStep(rec, timeSpan, idx) {
  const ts = stepTs(timeSpan, idx);
  const usage = rec.message?.usage || rec.usage || {};
  const text = rec.message?.content || rec.content || rec.text || '';
  const role = rec.type || rec.role || 'assistant';

  if (role === 'user' || role === 'human') {
    return text ? { idx, kind: 'user', label: 'User', ts, text } : null;
  }

  let label = 'Assistant';
  if (rec.step_kind?.startsWith('action:')) label = 'Action';
  if (rec.step_kind === 'outcome') label = 'Summary';

  if (!text) return null;
  return {
    idx,
    kind: 'assistant',
    label,
    ts,
    text,
    inTok: usage.input_tokens || usage.prompt_tokens || 0,
    outTok: usage.output_tokens || usage.completion_tokens || 0,
    cached: usage.cache_read_tokens || usage.cached_tokens || 0,
  };
}

function trace(sessionId) {
  const bySession = readUsageRows();
  const rows = (bySession.get(sessionId) || []).slice().sort((a, b) => {
    const ta = a.timestamp || 0;
    const tb = b.timestamp || 0;
    if (ta !== tb) return ta - tb;
    const order = { user: 0, assistant: 1 };
    return (order[a.type] ?? 2) - (order[b.type] ?? 2);
  });

  if (!rows.length) {
    if (traeLogsDir()) {
      return { error: 'not_found', steps: [], hint: 'trae-session-empty' };
    }
    return { error: 'not_found', steps: [] };
  }

  const steps = [];
  const timeSpan = fileTimeSpan(null);
  let idx = 0;
  for (const rec of rows) {
    const step = recordToStep(rec, timeSpan, idx++);
    if (step) steps.push({ ...step, idx: steps.length });
  }

  const stats = buildTraceStats(steps);
  const summary = summarizeSession(sessionId, rows);
  return {
    session_id: sessionId,
    project: summary.project,
    project_path: summary.project_path,
    context: summary.context,
    steps,
    stats,
  };
}

function findSessionFile(sessionId) {
  const file = path.join(traeSessionsExportDir(), EXPORT_FILE);
  if (!fs.existsSync(file)) return null;
  const needle = String(sessionId);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.includes(needle)) return file;
  }
  return null;
}

module.exports = {
  agentId: AGENT_ID,
  profile: PROFILE,
  list,
  trace,
  findSessionFile,
};
