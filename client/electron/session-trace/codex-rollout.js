// session-trace/codex-rollout.js — Codex rollout jsonl trace 适配器
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  expandHome, extractContext, toolResultText, resolveProjectName,
  readSessionCwd, buildTraceStats, fileTimeSpan, stepTs, isRawErrorLine,
  traceCacheKey, createTraceCache,
} = require('./shared');
const { iterFileLines, MAX_JSONL_FILE_BYTES } = require('../jsonl-lines');
const { extractSkillsFromToolCall } = require('../skill-signals');

const AGENT_ID = 'codex';
const PROFILE = 'codex-rollout';
const ROOT = () => path.join(os.homedir(), '.codex/sessions');

// trace 详情最多渲染的步骤数：超大会话（曾见 ~1GB rollout）全量渲染既撑爆内存也无意义。
// 命中上限即 break 出流式迭代 → 触发 generator 关闭 fd，因此绝不会读完整份大文件。
const MAX_TRACE_STEPS = 20000;

// trace 结果缓存（共用工厂）：key=文件身份，文件一改动即自然失活，只留最近 N 条。
const traceCache = createTraceCache();

function codexSessionIdFromFilename(name) {
  const stem = String(name).replace(/\.jsonl$/i, '');
  if (!stem.startsWith('rollout-')) return stem;
  const parts = stem.split('-');
  if (parts.length >= 6) return parts.slice(-5).join('-');
  return stem;
}

function loadCodexThreadNames() {
  const map = {};
  const idx = path.join(os.homedir(), '.codex/session_index.jsonl');
  try {
    for (const line of iterFileLines(idx)) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.id && d.thread_name) map[d.id] = String(d.thread_name);
      } catch {}
    }
  } catch {}
  return map;
}

function codexIsEnvironmentContext(text) {
  if (!text || typeof text !== 'string') return false;
  return /<environment_context>/i.test(text);
}

function codexUserText(data) {
  if (data.type === 'event_msg' && data.payload?.type === 'user_message') {
    const m = data.payload.message;
    if (typeof m === 'string' && !codexIsEnvironmentContext(m)) return extractContext(m);
  }
  if (data.type === 'response_item') {
    const p = data.payload || {};
    if (p.type === 'message' && p.role === 'user') {
      const c = p.content;
      if (typeof c === 'string') {
        if (codexIsEnvironmentContext(c)) return '';
        return extractContext(c);
      }
      if (Array.isArray(c)) {
        const text = c
          .filter(x => x?.type === 'input_text' || x?.type === 'text')
          .map(x => x.text || '')
          .join(' ');
        if (text && !codexIsEnvironmentContext(text)) return extractContext(text);
      }
    }
  }
  return '';
}

/** 从 Codex reasoning.summary / content 抽出可读文本（summary 常为 [{type,text}] 数组） */
function codexReasoningText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  const pushPart = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) parts.push(t);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) pushPart(item);
      return;
    }
    if (typeof v === 'object') {
      // Responses：{ type: 'summary_text', text } / { type: 'reasoning_text', text }
      const t = v.text || v.content || v.summary || v.thinking;
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
  };
  pushPart(payload.summary);
  pushPart(payload.content);
  pushPart(payload.reasoning_content);
  // 字符串字段兜底（少数上游直接给 summary 字符串）
  if (!parts.length && typeof payload.text === 'string') pushPart(payload.text);
  return parts.join('\n\n').slice(0, 500);
}

function codexAssistantText(data) {
  if (data.type === 'event_msg' && data.payload?.type === 'agent_message') {
    return String(data.payload.message || '').slice(0, 500);
  }
  if (data.type === 'response_item') {
    const p = data.payload || {};
    if (p.type === 'message' && p.role === 'assistant') {
      const c = p.content;
      if (typeof c === 'string') return c.slice(0, 500);
      if (Array.isArray(c)) {
        return c
          .filter(x => x?.type === 'output_text' || x?.type === 'text')
          .map(x => x.text || '')
          .join(' ')
          .slice(0, 500);
      }
    }
    // reasoning.summary 是对象数组，不能 String(arr) → "[object Object]"
    if (p.type === 'reasoning') return codexReasoningText(p);
  }
  return '';
}

function codexAccumulateUsage(acc, usage) {
  if (!usage || typeof usage !== 'object') return acc;
  const gross = usage.input_tokens || 0;
  const cached = usage.cached_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const reasoning = usage.reasoning_output_tokens || 0;
  const totalRecord = usage.total_tokens || 0;
  const netIn = Math.max(0, gross - cached);
  const outBill = output + (reasoning && totalRecord > gross + output ? reasoning : 0);
  return {
    calls: acc.calls + 1,
    inTok: Math.max(acc.inTok, netIn),
    cached: Math.max(acc.cached, cached),
    outTok: Math.max(acc.outTok, outBill),
  };
}

function parseCodexRolloutFile(filePath, threadNames = {}) {
  const sid = codexSessionIdFromFilename(path.basename(filePath));
  let context = '', cwdHint = null;
  let acc = { calls: 0, inTok: 0, outTok: 0, cached: 0 };
  let lastTs = 0, tooLarge = false;
  try {
    const st = fs.statSync(filePath);
    lastTs = Math.floor(st.mtimeMs / 1000);
    tooLarge = st.size > MAX_JSONL_FILE_BYTES;
  } catch {}
  // 超大文件：列表页只需元信息，跳过逐行解析，绝不整份读入（否则 list() 会卡死在一个 1GB 文件上）。
  if (tooLarge) {
    if (threadNames[sid]) context = extractContext(threadNames[sid]);
    return {
      sid, context, cwdHint,
      calls: 0, inTok: 0, outTok: 0, cached: 0, tokens: 0, lastTs, filePath,
    };
  }
  try {
    // 流式逐行，避免 readFileSync + split 的双份整文件内存拷贝。
    for (const line of iterFileLines(filePath)) {
      if (!line.trim()) continue;
      let data;
      try { data = JSON.parse(line); } catch { continue; }
      if (data.type === 'session_meta' && data.payload?.cwd) {
        cwdHint = expandHome(data.payload.cwd);
      }
      if (data.type === 'event_msg') {
        const pt = data.payload?.type;
        if (pt === 'user_message' && !context) {
          const t = codexUserText(data);
          if (t) context = t;
        }
        if (pt === 'token_count') {
          acc = codexAccumulateUsage(acc, data.payload?.info?.total_token_usage);
        }
      }
    }
  } catch {}
  if (!context && threadNames[sid]) context = extractContext(threadNames[sid]);
  return {
    sid, context, cwdHint,
    calls: acc.calls, inTok: acc.inTok, outTok: acc.outTok,
    cached: acc.cached, tokens: acc.inTok + acc.cached + acc.outTok, lastTs, filePath,
  };
}

function mergeCodexParsed(a, b) {
  const newer = (a.lastTs || 0) >= (b.lastTs || 0) ? a : b;
  return {
    sid: a.sid,
    context: a.context || b.context,
    cwdHint: a.cwdHint || b.cwdHint,
    calls: Math.max(a.calls, b.calls),
    inTok: Math.max(a.inTok, b.inTok),
    outTok: Math.max(a.outTok, b.outTok),
    cached: Math.max(a.cached || 0, b.cached || 0),
    tokens: Math.max(a.tokens, b.tokens),
    lastTs: Math.max(a.lastTs || 0, b.lastTs || 0),
    filePath: newer.filePath,
  };
}

function findSessionFile(sessionId) {
  const root = ROOT();
  let found = null;
  let bestMtime = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
        const sid = codexSessionIdFromFilename(ent.name);
        if (sid !== sessionId && !ent.name.includes(sessionId)) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          found = full;
        }
      }
    }
  };
  walk(root);
  return found;
}

function list({ limit = 50, sinceDays = 30 } = {}) {
  const root = ROOT();
  const threadNames = loadCodexThreadNames();
  const since = Date.now() / 1000 - (sinceDays || 30) * 86400;
  // 先收集候选并按 mtime 排序，再 parse，避免旧 rollout 全量读盘
  const candidates = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const lastTs = Math.floor(st.mtimeMs / 1000);
        if (lastTs < since) continue;
        candidates.push({ full, lastTs });
      }
    }
  }
  walk(root);

  candidates.sort((a, b) => b.lastTs - a.lastTs);
  const parseBudget = Math.max(limit * 4, limit);
  const bySid = new Map();
  for (const c of candidates.slice(0, parseBudget)) {
    const parsed = parseCodexRolloutFile(c.full, threadNames);
    if ((parsed.lastTs || 0) < since) continue;
    const prev = bySid.get(parsed.sid);
    bySid.set(parsed.sid, prev ? mergeCodexParsed(prev, parsed) : parsed);
  }

  const out = [...bySid.values()].map(p => {
    const { project, project_path } = resolveProjectName({
      projectPath: root,
      sessionFile: p.filePath,
      agentId: AGENT_ID,
      cwdHint: p.cwdHint,
    });
    return {
      session_id: p.sid, project, project_path,
      context: p.context || '(无用户消息)',
      calls: p.calls, tokens: p.tokens, inTok: p.inTok, outTok: p.outTok,
      lastTs: p.lastTs, agent: AGENT_ID,
    };
  });
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

function trace(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return { error: 'not_found', steps: [], stats: {} };

  let st;
  try { st = fs.statSync(file); } catch { return { error: 'not_found', steps: [], stats: {} }; }

  // 缓存命中（文件未变）：同一会话反复打开直接返回，不再读盘解析。
  const cacheKey = traceCacheKey(file, st);
  const cached = traceCache.get(cacheKey);
  if (cached) return cached;

  const steps = [];        // 每步暂存 _line（原始行号），ts 在读完得到总行数后统一回填
  let lineIdx = 0;         // 非空行序号（与旧 rawLines 索引一致）
  let rawErrorCount = 0;
  let truncated = false;

  // 流式逐行；累计到 MAX_TRACE_STEPS 即 break（generator 关闭 fd → 不读完整份大文件）。
  try {
    for (const line of iterFileLines(file)) {
      if (!line.trim()) continue;
      if (isRawErrorLine(line)) rawErrorCount++;
      let data;
      try { data = JSON.parse(line); } catch { lineIdx++; continue; }
      const at = lineIdx;

      if (data.type === 'event_msg') {
        const pt = data.payload?.type;
        if (pt === 'user_message') {
          steps.push({
            idx: steps.length, kind: 'user', label: 'User prompt', _line: at,
            text: codexUserText(data) || extractContext(String(data.payload?.message || '')),
          });
        } else if (pt === 'agent_message') {
          steps.push({
            idx: steps.length, kind: 'assistant', label: 'Assistant', _line: at,
            text: codexAssistantText(data),
          });
        }
      } else if (data.type === 'response_item') {
        const p = data.payload || {};
        if (p.type === 'function_call') {
          const skillHits = extractSkillsFromToolCall(p.name, p.arguments, { signalPrefix: 'codex' });
          if (skillHits.length) {
            for (const sk of skillHits) {
              steps.push({
                idx: steps.length, kind: 'tool',
                label: `Skill · ${sk.raw}`, _line: at,
                tool: p.name, skill: sk.raw, signal: sk.signal,
                input: p.arguments,
              });
            }
          } else {
            steps.push({
              idx: steps.length, kind: 'tool', label: p.name || 'tool', _line: at,
              tool: p.name, input: p.arguments,
            });
          }
        } else if (p.type === 'function_call_output' || p.type === 'tool_result') {
          const out = toolResultText(p.output ?? p.content);
          steps.push({
            idx: steps.length, kind: 'tool_result', label: 'Tool output', _line: at,
            is_error: /(\b|")error/i.test(out.slice(0, 80)), text: out.slice(0, 4000),
          });
        } else if (p.type === 'message' && p.role === 'user') {
          const t = codexUserText(data);
          if (t) steps.push({ idx: steps.length, kind: 'user', label: 'User prompt', _line: at, text: t });
        } else if (p.type === 'message' && p.role === 'assistant') {
          const t = codexAssistantText(data);
          if (t) steps.push({ idx: steps.length, kind: 'assistant', label: 'Assistant', _line: at, text: t });
        } else if (p.type === 'reasoning') {
          const text = codexAssistantText(data);
          const encrypted = !text && !!(p.encrypted_content);
          steps.push({
            idx: steps.length, kind: 'assistant', label: 'Reasoning', _line: at,
            reasoning: true, text, encrypted,
          });
        }
      }
      lineIdx++;
      if (steps.length >= MAX_TRACE_STEPS) { truncated = true; break; }
    }
  } catch { /* 读取中断：用已收集的步骤降级返回 */ }

  // 回填时间戳：用实际读到的非空行数铺开（截断时按已读部分铺）。
  const timeSpan = fileTimeSpan(file, Math.max(lineIdx, 1));
  for (const s of steps) { s.ts = stepTs(timeSpan, s._line); delete s._line; }

  const cwdHint = readSessionCwd(file, AGENT_ID);
  const { project, project_path } = resolveProjectName({
    projectPath: path.dirname(file),
    sessionFile: file,
    agentId: AGENT_ID,
    cwdHint,
  });

  const stats = buildTraceStats(steps, { filePath: file, rawErrorCount });
  if (truncated) stats.truncated = true;

  return traceCache.set(cacheKey, {
    session_id: sessionId,
    agent: AGENT_ID,
    project, project_path,
    cwd: project_path,
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
  codexSessionIdFromFilename,
  parseCodexRolloutFile,
  codexReasoningText,
  MAX_TRACE_STEPS,
};
