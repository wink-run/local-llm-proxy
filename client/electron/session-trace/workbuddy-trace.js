// session-trace/workbuddy-trace.js — WorkBuddy trace_*.json 适配器
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  extractContext, toolResultText, buildTraceStats, fileTimeSpan, stepTs,
} = require('./shared');

const AGENT_ID = 'workbuddy';
const PROFILE = 'workbuddy-trace';
const ROOT = () => path.join(os.homedir(), '.workbuddy/traces');

function walkTraceFiles() {
  const out = [];
  const re = /^trace_.*\.json$/i;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (re.test(ent.name)) out.push(full);
    }
  };
  walk(ROOT());
  return out;
}

function loadTraceDoc(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sessionIdFromDoc(doc, file) {
  const id = doc?.trace?.traceId || doc?.traceId || doc?.id;
  if (id) return String(id);
  return path.basename(file).replace(/^trace_/, '').replace(/\.json$/i, '');
}

/** 从 span 提取可读文本（含 toolOutput JSON 字符串） */
function spanText(span) {
  if (!span || typeof span !== 'object') return '';
  for (const key of ['input', 'prompt', 'userMessage', 'message', 'content', 'text']) {
    const v = span[key];
    if (typeof v === 'string' && v.trim()) return extractContext(v);
  }
  if (span.toolOutput) {
    try {
      let parsed = JSON.parse(span.toolOutput);
      if (Array.isArray(parsed)) parsed = parsed.find(x => x && typeof x === 'object') || parsed[0];
      if (parsed && typeof parsed === 'object') {
        const choice = parsed.choices?.[0]?.message?.content
          || parsed.message?.content
          || parsed.content;
        if (typeof choice === 'string') return extractContext(choice);
        if (Array.isArray(choice)) {
          const t = choice.find(x => x?.type === 'text')?.text;
          if (t) return extractContext(t);
        }
      }
    } catch {
      return extractContext(String(span.toolOutput).slice(0, 500));
    }
  }
  return '';
}

function parseStartedAtMs(span, fallback) {
  const raw = span?.startedAt || span?.startTime || span?.timestamp;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

function buildStepsFromSpans(spans, timeSpan) {
  const steps = [];
  let lineIdx = 0;
  for (const span of spans || []) {
    if (!span || typeof span !== 'object') continue;
    const ts = stepTs(timeSpan, lineIdx++);
    const type = String(span.type || '').toLowerCase();

    if (type === 'generation' || type === 'assistant' || type === 'agent') {
      const text = spanText(span);
      const usage = span.usage || {};
      steps.push({
        idx: steps.length,
        kind: 'assistant',
        label: 'Assistant',
        ts,
        text: text.slice(0, 500) || (span.model ? `模型: ${span.model}` : 'Assistant'),
        inTok: usage.prompt_tokens || usage.input_tokens || 0,
        outTok: usage.completion_tokens || usage.output_tokens || 0,
        cached: usage.prompt_tokens_details?.cached_tokens || 0,
      });
    } else if (type === 'user' || type === 'human' || type === 'user_message') {
      const text = spanText(span);
      if (text) {
        steps.push({ idx: steps.length, kind: 'user', label: 'User prompt', ts, text });
      }
    } else if (type === 'tool' || type === 'tool_call' || type === 'function') {
      steps.push({
        idx: steps.length,
        kind: 'tool',
        label: span.name || span.tool || 'tool',
        ts,
        tool: span.name || span.tool,
        input: span.input || span.arguments,
      });
    } else if (type === 'tool_result' || type === 'tool_output') {
      steps.push({
        idx: steps.length,
        kind: 'tool_result',
        label: 'Tool output',
        ts,
        text: toolResultText(span.output ?? span.toolOutput ?? span.content).slice(0, 4000),
      });
    }
  }
  return steps;
}

function summarizeDoc(doc, file) {
  const sid = sessionIdFromDoc(doc, file);
  const spans = Array.isArray(doc?.spans) ? doc.spans : [];
  let context = '';
  let calls = 0;
  let inTok = 0;
  let outTok = 0;
  let lastTs = 0;
  try {
    lastTs = Math.floor(fs.statSync(file).mtimeMs / 1000);
  } catch {}

  for (const span of spans) {
    const type = String(span?.type || '').toLowerCase();
    if (!context) {
      const t = spanText(span);
      if (t && type !== 'generation') context = t;
    }
    if (type === 'generation') {
      calls++;
      const u = span.usage || {};
      inTok += u.prompt_tokens || u.input_tokens || 0;
      outTok += u.completion_tokens || u.output_tokens || 0;
      const ms = parseStartedAtMs(span, 0);
      if (ms) lastTs = Math.max(lastTs, Math.floor(ms / 1000));
    }
    if ((type === 'user' || type === 'user_message') && !context) {
      context = spanText(span);
    }
  }

  const title = doc?.trace?.title || doc?.title || doc?.name;
  if (!context && title) context = extractContext(String(title));

  return {
    session_id: sid,
    project: title || path.basename(path.dirname(file)),
    project_path: path.dirname(file),
    context: context || '(无用户消息)',
    calls,
    tokens: inTok + outTok,
    inTok,
    outTok,
    lastTs,
    agent: AGENT_ID,
    file,
  };
}

function findSessionFile(sessionId) {
  for (const file of walkTraceFiles()) {
    const doc = loadTraceDoc(file);
    if (doc && sessionIdFromDoc(doc, file) === sessionId) return file;
  }
  return null;
}

function list({ limit = 50, sinceDays = 30 } = {}) {
  const since = Date.now() / 1000 - (sinceDays || 30) * 86400;
  const bySid = new Map();
  for (const file of walkTraceFiles()) {
    const doc = loadTraceDoc(file);
    if (!doc) continue;
    const row = summarizeDoc(doc, file);
    if ((row.lastTs || 0) < since) continue;
    const prev = bySid.get(row.session_id);
    if (!prev || (row.lastTs || 0) >= (prev.lastTs || 0)) bySid.set(row.session_id, row);
  }
  const out = [...bySid.values()].map(({ file, ...rest }) => rest);
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

function trace(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return { error: 'not_found', steps: [], stats: {} };
  const doc = loadTraceDoc(file);
  const spans = Array.isArray(doc?.spans) ? doc.spans : [];
  const timeSpan = fileTimeSpan(file, Math.max(spans.length, 1));
  const steps = buildStepsFromSpans(spans, timeSpan);
  const summary = summarizeDoc(doc, file);
  return {
    session_id: sessionId,
    agent: AGENT_ID,
    project: summary.project,
    project_path: summary.project_path,
    cwd: summary.project_path,
    steps,
    stats: buildTraceStats(steps, { filePath: file, rawLines: [] }),
  };
}

module.exports = {
  agentId: AGENT_ID,
  profile: PROFILE,
  list,
  trace,
  findSessionFile,
  buildStepsFromSpans,
};
