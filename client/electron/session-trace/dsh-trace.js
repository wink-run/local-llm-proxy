// session-trace/dsh-trace.js — DeepSeek Harness session.jsonl.zstd 适配器
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  extractContext, clipTraceText, toolResultText, projectLabel,
  buildTraceStats, fileTimeSpan, stepTs, pathFromEncodedSlug,
  traceCacheKey, createTraceCache, MAX_JSONL_FILE_BYTES,
} = require('./shared');
const { iterFileLines, iterZstdJsonlLines } = require('../jsonl-lines');

const AGENT_ID = 'deepseek-harness';
const PROFILE = 'dsh-trace';
const ROOT = () => path.join(os.homedir(), '.dsh', 'sessions');
const traceCache = createTraceCache();

/** DSH usage：inputTokens / outputTokens / cacheReadTokens */
function dshUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    inTok: Number(u.inputTokens || u.input_tokens || 0) || 0,
    outTok: Number(u.outputTokens || u.output_tokens || 0) || 0,
    cached: Number(u.cacheReadTokens || u.cache_read_tokens || 0) || 0,
  };
}

function msTs(v, fallback) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  return fallback;
}

function contentPartsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((x) => {
    if (typeof x === 'string') return x;
    if (x?.type === 'text' || x?.type === 'reasoning') return x.text || '';
    return '';
  }).filter(Boolean).join('\n').trim();
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return raw || {};
  try { return JSON.parse(raw); } catch { return raw; }
}

function cwdFromDirSlug(slug) {
  let s = String(slug || '').trim();
  if (s.startsWith('--') && s.endsWith('--') && s.length > 4) s = s.slice(2, -2);
  return pathFromEncodedSlug(s);
}

function* iterSessionLines(file) {
  if (String(file).endsWith('.zstd')) yield* iterZstdJsonlLines(file);
  else yield* iterFileLines(file);
}

function listSessionDirs() {
  const root = ROOT();
  const out = [];
  let wdEntries;
  try { wdEntries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const wd of wdEntries) {
    if (!wd.isDirectory()) continue;
    const wdPath = path.join(root, wd.name);
    let sessEntries;
    try { sessEntries = fs.readdirSync(wdPath, { withFileTypes: true }); } catch { continue; }
    for (const sd of sessEntries) {
      if (!sd.isDirectory() || !sd.name.startsWith('session-')) continue;
      out.push({
        sessionId: sd.name,
        sessionDir: path.join(wdPath, sd.name),
        cwdSlug: wd.name,
      });
    }
  }
  return out;
}

function sessionFilePath(sessionDir) {
  const zstd = path.join(sessionDir, 'session.jsonl.zstd');
  if (fs.existsSync(zstd)) return zstd;
  const jsonl = path.join(sessionDir, 'session.jsonl');
  if (fs.existsSync(jsonl)) return jsonl;
  return null;
}

function findSessionDir(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  for (const { sessionId: id, sessionDir } of listSessionDirs()) {
    if (id === sid) return sessionDir;
  }
  return null;
}

function findSessionFile(sessionId) {
  const dir = findSessionDir(sessionId);
  return dir ? sessionFilePath(dir) : null;
}

function summarizeSession(file) {
  let calls = 0, inTok = 0, outTok = 0, cached = 0;
  let context = '';
  let title = '';
  let cwd = '';
  let lastTs = 0;
  try { if (fs.statSync(file).size > MAX_JSONL_FILE_BYTES) return { calls, inTok, outTok, cached, tokens: 0, context, title, cwd, lastTs }; }
  catch { return { calls, inTok, outTok, cached, tokens: 0, context, title, cwd, lastTs }; }

  for (const line of iterSessionLines(file)) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const ts = msTs(o.time || o.createdAt, 0);
    if (ts > lastTs) lastTs = ts;

    if (o.type === 'session') {
      if (o.cwd) cwd = String(o.cwd);
      continue;
    }
    if (o.type === 'session/title') {
      const t = o.data?.title;
      if (t) title = String(t);
      continue;
    }
    if (o.type === 'user/message' && !context) {
      context = extractContext(contentPartsText(o.data?.content));
      continue;
    }
    if (o.type === 'assistant/message') {
      const u = dshUsage(o.data?.usage);
      if (!u) continue;
      calls++;
      inTok += u.inTok;
      outTok += u.outTok;
      cached += u.cached;
    }
  }
  return {
    calls, inTok, outTok, cached,
    tokens: inTok + outTok + cached,
    context, title, cwd, lastTs,
  };
}

function list({ limit = 50, sinceDays = 30 } = {}) {
  const sinceMs = Date.now() - (sinceDays || 30) * 86400 * 1000;
  const out = [];

  for (const { sessionId, sessionDir, cwdSlug } of listSessionDirs()) {
    const file = sessionFilePath(sessionDir);
    if (!file) continue;
    let lastTs = 0;
    try { lastTs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (lastTs && lastTs < sinceMs) continue;

    const sum = summarizeSession(file);
    if (sum.lastTs) lastTs = Math.max(lastTs, sum.lastTs);
    const workDir = sum.cwd || cwdFromDirSlug(cwdSlug) || sessionDir;

    out.push({
      session_id: sessionId,
      project: projectLabel(workDir),
      project_path: workDir,
      context: sum.context || sum.title || '(无用户消息)',
      calls: sum.calls,
      tokens: sum.tokens,
      inTok: sum.inTok,
      outTok: sum.outTok,
      lastTs: Math.floor((lastTs || 0) / 1000),
      agent: AGENT_ID,
    });
  }

  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

/**
 * 将 DSH jsonl 行转为 trace steps（导出供单测）。
 * 跳过 assistant/chunk 等流式碎片，只用完整 user/assistant/tool 事件。
 */
function buildStepsFromDshLines(rawLines, timeSpan) {
  const steps = [];
  let lineIdx = 0;

  for (const line of rawLines) {
    const s = String(line || '').trim();
    if (!s) { lineIdx++; continue; }
    let o;
    try { o = JSON.parse(s); } catch { lineIdx++; continue; }
    const ts = msTs(o.time || o.createdAt, stepTs(timeSpan, lineIdx));
    const typ = String(o.type || '');

    if (typ === 'session' || typ === 'session/title') {
      lineIdx++;
      continue;
    }
    // 流式碎片：完整事件稍后会再发一条
    if (typ.includes('chunk')) {
      lineIdx++;
      continue;
    }

    if (typ === 'user/message') {
      const text = extractContext(contentPartsText(o.data?.content), { forTrace: true })
        || contentPartsText(o.data?.content);
      if (text) {
        steps.push({
          idx: steps.length, kind: 'user', label: 'User prompt', ts,
          text: clipTraceText(text),
        });
      }
      lineIdx++;
      continue;
    }

    if (typ === 'assistant/message') {
      const parts = o.data?.message?.content;
      const usage = dshUsage(o.data?.usage);
      let lastAssistIdx = -1;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'reasoning' || part.type === 'think' || part.type === 'thinking') {
            const think = String(part.text || part.think || '').trim();
            if (!think) continue;
            lastAssistIdx = steps.length;
            steps.push({
              idx: lastAssistIdx, kind: 'assistant', label: 'Reasoning', ts,
              reasoning: true, text: clipTraceText(think),
            });
          } else if (part.type === 'text' && part.text) {
            lastAssistIdx = steps.length;
            steps.push({
              idx: lastAssistIdx, kind: 'assistant', label: 'Assistant', ts,
              text: clipTraceText(String(part.text)),
            });
          }
        }
      } else {
        const text = contentPartsText(parts);
        if (text) {
          lastAssistIdx = steps.length;
          steps.push({
            idx: lastAssistIdx, kind: 'assistant', label: 'Assistant', ts,
            text: clipTraceText(text),
          });
        }
      }
      if (usage && lastAssistIdx >= 0) Object.assign(steps[lastAssistIdx], usage);
      lineIdx++;
      continue;
    }

    if (typ === 'tool/call') {
      const d = o.data || {};
      steps.push({
        idx: steps.length, kind: 'tool', label: d.name || 'tool', ts,
        tool: d.name, input: parseToolArgs(d.arguments || d.args || d.input),
        toolCallId: d.callId,
      });
      lineIdx++;
      continue;
    }

    if (typ === 'tool/result') {
      const content = o.data?.message?.content;
      const first = Array.isArray(content) ? content[0] : content;
      const out = toolResultText(first?.content ?? first ?? o.data);
      steps.push({
        idx: steps.length, kind: 'tool_result', label: 'Tool result', ts,
        text: clipTraceText(out),
        toolCallId: first?.toolCallId || o.data?.callId,
      });
    }

    lineIdx++;
  }
  return steps;
}

function readBoundedSessionLines(file) {
  const lines = [];
  let bytes = 0, truncated = false, rawErrorCount = 0;
  try {
    for (const line of iterSessionLines(file)) {
      if (!line.trim()) continue;
      lines.push(line);
      bytes += line.length;
      if (lines.length >= 50000 || bytes >= 128 * 1024 * 1024) { truncated = true; break; }
    }
  } catch { /* 已收集的行降级 */ }
  return { lines, lineCount: lines.length, truncated, rawErrorCount };
}

function trace(sessionId) {
  const sessionDir = findSessionDir(sessionId);
  if (!sessionDir) return { error: 'not_found', steps: [], meta: {} };

  const file = sessionFilePath(sessionDir);
  if (!file) return { error: 'not_found', steps: [], meta: {} };

  let st;
  try { st = fs.statSync(file); }
  catch (e) { return { error: e.message, steps: [], stats: {} }; }
  const cacheKey = traceCacheKey(file, st);
  const cached = traceCache.get(cacheKey);
  if (cached) return cached;

  const { lines, lineCount, truncated, rawErrorCount } = readBoundedSessionLines(file);
  const timeSpan = fileTimeSpan(file, lineCount);
  const steps = buildStepsFromDshLines(lines, timeSpan);
  const stats = buildTraceStats(steps, { filePath: file, rawErrorCount });
  if (truncated) stats.truncated = true;

  let cwd = '';
  for (const line of lines.slice(0, 8)) {
    try {
      const o = JSON.parse(line);
      if (o.type === 'session' && o.cwd) { cwd = String(o.cwd); break; }
    } catch { /* skip */ }
  }
  const workDir = cwd || path.dirname(sessionDir);

  return traceCache.set(cacheKey, {
    session_id: sessionId,
    agent: AGENT_ID,
    project: projectLabel(workDir),
    project_path: workDir,
    cwd: workDir,
    session_file: file,
    steps,
    stats,
  });
}

module.exports = {
  agentId: AGENT_ID,
  profile: PROFILE,
  list,
  trace,
  findSessionFile,
  buildStepsFromDshLines,
  dshUsage,
};
