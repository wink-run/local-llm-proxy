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

/** 目录扫描结果短期缓存（单次用量页会多次 find/list） */
let _filesCache = null;
let _filesCacheAt = 0;
const FILES_CACHE_MS = 8000;

function invalidateTraceFileCache() {
  _filesCache = null;
  _filesCacheAt = 0;
}

function walkTraceFiles() {
  const now = Date.now();
  if (_filesCache && now - _filesCacheAt < FILES_CACHE_MS) return _filesCache;
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
  _filesCache = out;
  _filesCacheAt = now;
  return out;
}

/** sessionId → 文件名（trace_*.json） */
function traceBasename(sessionId) {
  const s = String(sessionId || '');
  const id = s.startsWith('trace_') ? s : `trace_${s}`;
  return `${id}.json`.toLowerCase();
}

function loadTraceDoc(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sessionIdFromDoc(doc, file) {
  const id = doc?.trace?.traceId || doc?.traceId || doc?.id;
  if (id) return String(id);
  return path.basename(file).replace(/^trace_/, '').replace(/\.json$/i, '');
}

/** 解析 OpenAI 风格 message content（string 或 [{type,text}]） */
function openAiMessageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const c = msg.content;
  if (typeof c === 'string' && c.trim()) return c.trim();
  if (Array.isArray(c)) {
    return c.map(x => (x?.type === 'text' ? x.text : (typeof x === 'string' ? x : ''))).filter(Boolean).join('\n').trim();
  }
  return '';
}

/** 解析 generation span 的 toolOutput（chat.completion 数组或对象） */
function parseGenerationOutput(span) {
  const empty = { text: '', usage: span?.usage || {}, toolCalls: [] };
  if (!span?.toolOutput) return empty;
  try {
    let parsed = JSON.parse(span.toolOutput);
    const item = Array.isArray(parsed)
      ? (parsed.find(x => x?.choices?.length) || parsed[0])
      : parsed;
    if (!item || typeof item !== 'object') return empty;
    const msg = item.choices?.[0]?.message || {};
    const usage = item.usage || span.usage || {};
    let text = openAiMessageText(msg);
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!text && toolCalls.length) {
      text = toolCalls.map(tc => {
        const fn = tc.function || {};
        return `${fn.name || 'tool'}(${fn.arguments || ''})`;
      }).join('\n');
    }
    return { text, usage, toolCalls };
  } catch {
    return empty;
  }
}

/** Trace 详情全文：优先提取 user_query，但不截断（列表摘要用 extractContext） */
function fullTraceText(text) {
  if (!text || typeof text !== 'string') return '';
  const uq = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  return (uq ? uq[1] : text).trim();
}

/** 从 generation toolInput（messages 数组）提取最后一条 user 消息 */
function userTextFromToolInput(toolInput) {
  if (!toolInput) return '';
  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    const msgs = Array.isArray(parsed) ? parsed : (parsed?.messages || []);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== 'user') continue;
      const t = openAiMessageText(m);
      if (t) return fullTraceText(t);
    }
  } catch { /* ignore */ }
  return '';
}

/** 解析 function span 的 toolOutput（{ title, content, renderer }） */
function parseFunctionOutput(toolOutput) {
  if (!toolOutput) return '';
  try {
    const parsed = typeof toolOutput === 'string' ? JSON.parse(toolOutput) : toolOutput;
    if (parsed && typeof parsed.content === 'string') return parsed.content.trim();
  } catch {
    return String(toolOutput);
  }
  return toolResultText(toolOutput);
}

/** 从 span 提取可读文本（trace 详情用，不截断） */
function spanText(span) {
  if (!span || typeof span !== 'object') return '';
  if (String(span.type || '').toLowerCase() === 'generation') {
    return parseGenerationOutput(span).text;
  }
  for (const key of ['input', 'prompt', 'userMessage', 'message', 'content', 'text']) {
    const v = span[key];
    if (typeof v === 'string' && v.trim()) return fullTraceText(v);
  }
  if (span.toolOutput) {
    const fnOut = parseFunctionOutput(span.toolOutput);
    if (fnOut) return fnOut;
    return parseGenerationOutput(span).text;
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

    // WorkBuddy 专有 span 类型，无展示内容则跳过
    if (type === 'custom') continue;

    if (type === 'generation') {
      const userText = userTextFromToolInput(span.toolInput);
      if (userText) {
        steps.push({ idx: steps.length, kind: 'user', label: 'User prompt', ts, text: userText });
      }
      const { text, usage } = parseGenerationOutput(span);
      const inTok = usage.prompt_tokens || usage.input_tokens || 0;
      const outTok = usage.completion_tokens || usage.output_tokens || 0;
      const cached = usage.prompt_tokens_details?.cached_tokens || usage.cache_read_tokens || 0;
      const body = text || (span.model ? `模型: ${span.model}` : '');
      if (!body && !inTok && !outTok) continue;
      steps.push({
        idx: steps.length,
        kind: 'assistant',
        label: 'Assistant',
        ts,
        text: body,
        inTok,
        outTok,
        cached,
      });
    } else if (type === 'assistant' || type === 'agent') {
      const text = spanText(span);
      if (!text && type === 'agent') continue; // agent 容器 span，无内容跳过
      const usage = span.usage || {};
      steps.push({
        idx: steps.length,
        kind: 'assistant',
        label: type === 'agent' ? (span.agentName || 'Agent') : 'Assistant',
        ts,
        text: text || (span.model ? `模型: ${span.model}` : ''),
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
      const toolName = span.toolName || span.name || span.tool || 'tool';
      const resultText = parseFunctionOutput(span.toolOutput);
      steps.push({
        idx: steps.length,
        kind: 'tool',
        label: toolName,
        ts,
        tool: toolName,
        input: span.toolInput || span.input || span.arguments,
        ...(resultText ? { text: resultText } : {}),
      });
    } else if (type === 'tool_result' || type === 'tool_output') {
      steps.push({
        idx: steps.length,
        kind: 'tool_result',
        label: 'Tool output',
        ts,
        text: toolResultText(span.output ?? span.toolOutput ?? span.content),
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
    if (!context && type === 'generation') {
      const t = userTextFromToolInput(span.toolInput) || spanText(span);
      if (t) context = extractContext(t); // 列表摘要仍截断
    }
    if (type === 'generation') {
      calls++;
      const { usage: u } = parseGenerationOutput(span);
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

/** 同一 WorkBuddy project 目录下多条 trace 合并为一行（用量页按 project 展示） */
function mergeRowsByProject(rows) {
  const byPath = new Map();
  for (const row of rows) {
    const key = row.project_path || row.project || row.session_id;
    const prev = byPath.get(key);
    if (!prev) {
      byPath.set(key, { ...row });
      continue;
    }
    prev.calls = (prev.calls || 0) + (row.calls || 0);
    prev.tokens = (prev.tokens || 0) + (row.tokens || 0);
    prev.inTok = (prev.inTok || 0) + (row.inTok || 0);
    prev.outTok = (prev.outTok || 0) + (row.outTok || 0);
    // 保留最新 trace 供 Trace 按钮打开
    if ((row.lastTs || 0) >= (prev.lastTs || 0)) {
      prev.session_id = row.session_id;
      prev.context = row.context || prev.context;
      prev.lastTs = row.lastTs;
      prev.file = row.file;
    }
  }
  return [...byPath.values()];
}

function findSessionFile(sessionId) {
  const target = traceBasename(sessionId);
  for (const file of walkTraceFiles()) {
    if (path.basename(file).toLowerCase() === target) return file;
  }
  // 兼容 traceId 与文件名不一致的旧数据
  const sid = String(sessionId);
  for (const file of walkTraceFiles()) {
    const doc = loadTraceDoc(file);
    if (doc && sessionIdFromDoc(doc, file) === sid) return file;
  }
  return null;
}

function list({ limit = 50, sinceDays = 30 } = {}) {
  const since = Date.now() / 1000 - (sinceDays || 30) * 86400;
  const cap = Math.max(1, limit || 50);
  const candidates = [];
  for (const file of walkTraceFiles()) {
    try {
      const st = fs.statSync(file);
      const mtimeTs = Math.floor(st.mtimeMs / 1000);
      if (mtimeTs < since) continue;
      candidates.push({ file, mtimeTs });
    } catch { /* skip */ }
  }
  candidates.sort((a, b) => b.mtimeTs - a.mtimeTs);
  const bySid = new Map();
  const parseBudget = Math.min(candidates.length, cap * 4);
  for (let i = 0; i < parseBudget; i++) {
    if (bySid.size >= cap) break;
    const { file } = candidates[i];
    const doc = loadTraceDoc(file);
    if (!doc) continue;
    const row = summarizeDoc(doc, file);
    if ((row.lastTs || 0) < since) continue;
    const prev = bySid.get(row.session_id);
    if (!prev || (row.lastTs || 0) >= (prev.lastTs || 0)) bySid.set(row.session_id, row);
  }
  const out = [...bySid.values()].map(({ file, ...rest }) => rest);
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return mergeRowsByProject(out).slice(0, cap);
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
  invalidateTraceFileCache,
  traceBasename,
  mergeRowsByProject,
};
