// session-trace/kimi-code-trace.js — Kimi Code wire.jsonl 适配器
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  extractContext, clipTraceText, msgText, toolResultText, projectLabel,
  buildTraceStats, fileTimeSpan, stepTs,
  readBoundedLines, traceCacheKey, createTraceCache, MAX_JSONL_FILE_BYTES,
} = require('./shared');
const { iterFileLines } = require('../jsonl-lines');

const AGENT_ID = 'kimi-code';
const PROFILE = 'kimi-code-trace';
const ROOT = () => path.join(os.homedir(), '.kimi-code', 'sessions');
const traceCache = createTraceCache();

/** Kimi usage：inputOther / output / inputCacheRead */
function kimiUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    inTok: Number(u.inputOther || u.input_tokens || 0) || 0,
    outTok: Number(u.output || u.output_tokens || 0) || 0,
    cached: Number(u.inputCacheRead || u.cache_read_tokens || 0) || 0,
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
  return content.map(x => (x?.type === 'text' ? x.text : (typeof x === 'string' ? x : ''))).filter(Boolean).join('\n').trim();
}

function promptInputText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input.map(x => (x?.type === 'text' ? x.text : (typeof x === 'string' ? x : ''))).filter(Boolean).join('\n').trim();
}

/** 枚举 session_* 目录（含 state.json） */
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
      if (!sd.isDirectory() || !sd.name.startsWith('session_')) continue;
      out.push({
        sessionId: sd.name,
        sessionDir: path.join(wdPath, sd.name),
      });
    }
  }
  return out;
}

function readState(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function mainWirePath(sessionDir) {
  return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

function allWirePaths(sessionDir) {
  const agentsDir = path.join(sessionDir, 'agents');
  let ents;
  try { ents = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return []; }
  const wires = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const w = path.join(agentsDir, e.name, 'wire.jsonl');
    if (fs.existsSync(w)) wires.push(w);
  }
  // main 优先，其余按名排序
  wires.sort((a, b) => {
    const am = a.endsWith(`${path.sep}main${path.sep}wire.jsonl`) ? 0 : 1;
    const bm = b.endsWith(`${path.sep}main${path.sep}wire.jsonl`) ? 0 : 1;
    return am - bm || a.localeCompare(b);
  });
  return wires;
}

/** 汇总 wire 中 turn 级 usage + 首条用户提示 */
function summarizeWires(wirePaths) {
  let calls = 0, inTok = 0, outTok = 0, cached = 0;
  let context = '';
  let lastTs = 0;
  for (const wp of wirePaths) {
    try { if (fs.statSync(wp).size > MAX_JSONL_FILE_BYTES) continue; } catch { continue; }
    for (const line of iterFileLines(wp)) {
      const s = line.trim();
      if (!s) continue;
      let o;
      try { o = JSON.parse(s); } catch { continue; }
      const ts = msTs(o.time, 0);
      if (ts > lastTs) lastTs = ts;

      if (!context) {
        if (o.type === 'turn.prompt') {
          context = extractContext(promptInputText(o.input));
        } else if (o.type === 'context.append_message' && o.message?.role === 'user') {
          context = extractContext(contentPartsText(o.message.content) || msgText(o.message));
        }
      }

      if (o.type === 'usage.record' && o.usageScope === 'turn') {
        const u = kimiUsage(o.usage);
        if (!u) continue;
        calls++;
        inTok += u.inTok;
        outTok += u.outTok;
        cached += u.cached;
      }
    }
  }
  return { calls, inTok, outTok, cached, tokens: inTok + outTok + cached, context, lastTs };
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
  if (!dir) return null;
  const main = mainWirePath(dir);
  if (fs.existsSync(main)) return main;
  const wires = allWirePaths(dir);
  return wires[0] || null;
}

function list({ limit = 50, sinceDays = 30 } = {}) {
  const sinceMs = Date.now() - (sinceDays || 30) * 86400 * 1000;
  const out = [];

  for (const { sessionId, sessionDir } of listSessionDirs()) {
    const state = readState(sessionDir) || {};
    const workDir = state.workDir || '';
    const project = workDir ? projectLabel(workDir) : 'unknown';
    const wires = allWirePaths(sessionDir);
    if (!wires.length) continue;

    let lastTs = 0;
    try {
      const st = fs.statSync(wires[0]);
      lastTs = st.mtimeMs;
    } catch {}
    if (state.updatedAt) {
      const t = Date.parse(state.updatedAt);
      if (Number.isFinite(t)) lastTs = Math.max(lastTs, t);
    }
    if (lastTs && lastTs < sinceMs) continue;

    const sum = summarizeWires(wires);
    if (sum.lastTs) lastTs = Math.max(lastTs, sum.lastTs);

    out.push({
      session_id: sessionId,
      project,
      project_path: workDir || sessionDir,
      context: sum.context || state.title || state.lastPrompt || '(无用户消息)',
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
 * 将 wire.jsonl 行转为 trace steps（导出供单测）。
 * 覆盖：user 提示、assistant 文本/思考、tool.call / tool.result、step.end 用量。
 */
function buildStepsFromWireLines(rawLines, timeSpan) {
  const steps = [];
  let lineIdx = 0;
  // stepUuid → 最近一条 assistant step 索引（用于挂 step.end usage）
  const stepAssistIdx = new Map();

  for (const line of rawLines) {
    const s = String(line || '').trim();
    if (!s) { lineIdx++; continue; }
    let o;
    try { o = JSON.parse(s); } catch { lineIdx++; continue; }
    const ts = msTs(o.time, stepTs(timeSpan, lineIdx));

    if (o.type === 'turn.prompt') {
      const text = extractContext(promptInputText(o.input), { forTrace: true }) || promptInputText(o.input);
      if (text) {
        steps.push({
          idx: steps.length, kind: 'user', label: 'User prompt', ts,
          text: clipTraceText(text),
        });
      }
      lineIdx++;
      continue;
    }

    if (o.type === 'context.append_message' && o.message?.role === 'user') {
      // turn.prompt 已覆盖时跳过重复 user
      const text = extractContext(contentPartsText(o.message.content) || msgText(o.message), { forTrace: true });
      const last = steps[steps.length - 1];
      if (text && !(last && last.kind === 'user' && last.text === clipTraceText(text))) {
        steps.push({
          idx: steps.length, kind: 'user', label: 'User prompt', ts,
          text: clipTraceText(text),
        });
      }
      lineIdx++;
      continue;
    }

    if (o.type === 'context.append_loop_event' && o.event && typeof o.event === 'object') {
      const ev = o.event;
      const et = ev.type;

      if (et === 'tool.call') {
        steps.push({
          idx: steps.length, kind: 'tool', label: ev.name || 'tool', ts,
          tool: ev.name, input: ev.args || ev.input,
        });
      } else if (et === 'tool.result') {
        const out = toolResultText(ev.result?.output ?? ev.result);
        steps.push({
          idx: steps.length, kind: 'tool_result', label: 'Tool result', ts,
          text: clipTraceText(out),
          toolCallId: ev.toolCallId || ev.parentUuid,
        });
      } else if (et === 'content.part' && ev.part) {
        const part = ev.part;
        if (part.type === 'think' || part.type === 'thinking') {
          const think = String(part.think || part.text || '').trim();
          if (think) {
            const idx = steps.length;
            steps.push({
              idx, kind: 'assistant', label: 'Reasoning', ts,
              reasoning: true, text: clipTraceText(think),
            });
            if (ev.stepUuid) stepAssistIdx.set(ev.stepUuid, idx);
          }
        } else if (part.type === 'text' && part.text) {
          const idx = steps.length;
          steps.push({
            idx, kind: 'assistant', label: 'Assistant', ts,
            text: clipTraceText(String(part.text)),
          });
          if (ev.stepUuid) stepAssistIdx.set(ev.stepUuid, idx);
        }
      } else if (et === 'step.end') {
        const u = kimiUsage(ev.usage);
        if (u && ev.uuid) {
          const ai = stepAssistIdx.get(ev.uuid);
          if (ai != null && steps[ai]) {
            Object.assign(steps[ai], u);
          }
        }
      }
    }

    lineIdx++;
  }
  return steps;
}

function trace(sessionId) {
  const sessionDir = findSessionDir(sessionId);
  if (!sessionDir) return { error: 'not_found', steps: [], meta: {} };

  const state = readState(sessionDir) || {};
  const workDir = state.workDir || '';
  const project = workDir ? projectLabel(workDir) : 'unknown';

  // 详情以 main 为主；无 main 则取第一份 wire
  const wireFile = findSessionFile(sessionId);
  if (!wireFile) return { error: 'not_found', steps: [], meta: {} };

  let st;
  try { st = fs.statSync(wireFile); }
  catch (e) { return { error: e.message, steps: [], stats: {} }; }
  const cacheKey = traceCacheKey(wireFile, st);
  const cached = traceCache.get(cacheKey);
  if (cached) return cached;

  const { lines, lineCount, truncated, rawErrorCount } = readBoundedLines(wireFile);
  const timeSpan = fileTimeSpan(wireFile, lineCount);
  const steps = buildStepsFromWireLines(lines, timeSpan);
  const stats = buildTraceStats(steps, { filePath: wireFile, rawErrorCount });
  if (truncated) stats.truncated = true;

  return traceCache.set(cacheKey, {
    session_id: sessionId,
    agent: AGENT_ID,
    project,
    project_path: workDir || sessionDir,
    cwd: workDir || sessionDir,
    session_file: wireFile,
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
  buildStepsFromWireLines,
  kimiUsage,
};
