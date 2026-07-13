// session-trace/codex-rollout.js — Codex rollout jsonl trace 适配器
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  expandHome, extractContext, toolResultText, resolveProjectName,
  readSessionCwd, buildTraceStats, fileTimeSpan, stepTs,
} = require('./shared');
const { extractSkillsFromToolCall } = require('../skill-signals');

const AGENT_ID = 'codex';
const PROFILE = 'codex-rollout';
const ROOT = () => path.join(os.homedir(), '.codex/sessions');

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
    for (const line of fs.readFileSync(idx, 'utf8').split('\n')) {
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
    if (p.type === 'reasoning') return String(p.summary || p.content || '').slice(0, 500);
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
  let lastTs = 0;
  try {
    const st = fs.statSync(filePath);
    lastTs = Math.floor(st.mtimeMs / 1000);
  } catch {}
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
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
  const bySid = new Map();

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
        const parsed = parseCodexRolloutFile(full, threadNames);
        if ((parsed.lastTs || 0) < since) continue;
        const prev = bySid.get(parsed.sid);
        bySid.set(parsed.sid, prev ? mergeCodexParsed(prev, parsed) : parsed);
      }
    }
  }
  walk(root);

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

  const rawLines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const timeSpan = fileTimeSpan(file, rawLines.length);
  const steps = [];
  let lineIdx = 0;

  for (const line of rawLines) {
    let data;
    try { data = JSON.parse(line); } catch { lineIdx++; continue; }
    const ts = stepTs(timeSpan, lineIdx);

    if (data.type === 'event_msg') {
      const pt = data.payload?.type;
      if (pt === 'user_message') {
        steps.push({
          idx: steps.length, kind: 'user', label: 'User prompt', ts,
          text: codexUserText(data) || extractContext(String(data.payload?.message || '')),
        });
      } else if (pt === 'agent_message') {
        steps.push({
          idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
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
              label: `Skill · ${sk.raw}`, ts,
              tool: p.name, skill: sk.raw, signal: sk.signal,
              input: p.arguments,
            });
          }
        } else {
          steps.push({
            idx: steps.length, kind: 'tool', label: p.name || 'tool', ts,
            tool: p.name, input: p.arguments,
          });
        }
      } else if (p.type === 'function_call_output' || p.type === 'tool_result') {
        const out = toolResultText(p.output ?? p.content);
        steps.push({
          idx: steps.length, kind: 'tool_result', label: 'Tool output', ts,
          is_error: /(\b|")error/i.test(out.slice(0, 80)), text: out.slice(0, 4000),
        });
      } else if (p.type === 'message' && p.role === 'user') {
        const t = codexUserText(data);
        if (t) steps.push({ idx: steps.length, kind: 'user', label: 'User prompt', ts, text: t });
      } else if (p.type === 'message' && p.role === 'assistant') {
        const t = codexAssistantText(data);
        if (t) steps.push({ idx: steps.length, kind: 'assistant', label: 'Assistant', ts, text: t });
      } else if (p.type === 'reasoning') {
        steps.push({
          idx: steps.length, kind: 'assistant', label: 'Reasoning', ts,
          reasoning: true, text: codexAssistantText(data),
        });
      }
    }
    lineIdx++;
  }

  const cwdHint = readSessionCwd(file, AGENT_ID);
  const { project, project_path } = resolveProjectName({
    projectPath: path.dirname(file),
    sessionFile: file,
    agentId: AGENT_ID,
    cwdHint,
  });

  return {
    session_id: sessionId,
    agent: AGENT_ID,
    project, project_path,
    cwd: project_path,
    steps,
    stats: buildTraceStats(steps, { filePath: file, rawLines }),
  };
}

module.exports = {
  agentId: AGENT_ID,
  profile: PROFILE,
  list,
  trace,
  findSessionFile,
  codexSessionIdFromFilename,
};
