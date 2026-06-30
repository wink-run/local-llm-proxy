// session-trace/claude-jsonl.js — Claude Code / Desktop jsonl trace 适配器
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  extractContext, msgText, toolResultText, resolveProjectName,
  pickUsage, buildTraceStats, fileTimeSpan, stepTs,
} = require('./shared');

const AGENT_ID = 'claude-code';
const PROFILE = 'claude-jsonl';
const ROOT = () => path.join(os.homedir(), '.claude/projects');

function clientFromEntrypoint(ep) {
  if (!ep) return null;
  if (String(ep).startsWith('claude-desktop')) return 'claude-desktop';
  if (ep === 'cli') return 'claude-code';
  return null;
}

function skillNameFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  return input.skill || input.command || input.name || null;
}

/** Claude / Claude-Code 风格 jsonl → trace steps（3p 沙箱复用） */
function buildClaudeStyleSteps(rawLines, timeSpan) {
  const steps = [];
  const toolNameById = {};
  let lineIdx = 0;
  for (const line of rawLines) {
    let data;
    try { data = JSON.parse(line); } catch { lineIdx++; continue; }
    const ts = stepTs(timeSpan, lineIdx);
    const usage = pickUsage(data) || pickUsage(data.message);

    if (data.type === 'user') {
      const msg = data.message || {};
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result') {
            const tool = toolNameById[b.tool_use_id] || null;
            steps.push({
              idx: steps.length, kind: 'tool_result',
              label: tool ? `${tool} 输出` : 'Tool output', ts,
              tool, tool_use_id: b.tool_use_id, is_error: !!b.is_error,
              text: toolResultText(b.content).slice(0, 4000),
            });
          } else if (b?.type === 'text' && String(b.text || '').trim()) {
            steps.push({
              idx: steps.length, kind: 'user', label: 'User prompt', ts,
              text: extractContext(b.text), ...(usage || {}),
            });
          } else if (typeof b === 'string' && b.trim()) {
            steps.push({
              idx: steps.length, kind: 'user', label: 'User prompt', ts,
              text: extractContext(b), ...(usage || {}),
            });
          }
        }
      } else {
        const text = extractContext(msgText(msg));
        if (text) {
          steps.push({
            idx: steps.length, kind: 'user', label: 'User prompt', ts,
            text, ...(usage || {}),
          });
        }
      }
    } else if (data.type === 'assistant') {
      const msg = data.message || {};
      const blocks = msg.content;
      const before = steps.length;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b?.type === 'tool_use') {
            const skill = b.name === 'Skill' ? skillNameFromInput(b.input) : null;
            if (b.id) toolNameById[b.id] = b.name;
            steps.push({
              idx: steps.length, kind: 'tool',
              label: skill ? `Skill · ${skill}` : (b.name || 'tool'), ts,
              tool: b.name, ...(skill ? { skill } : {}), input: b.input,
            });
          } else if (b?.type === 'thinking' || b?.type === 'reasoning') {
            const think = String(b.text || b.thinking || '').trim();
            const encrypted = !think && !!b.signature;
            steps.push({
              idx: steps.length, kind: 'assistant', label: 'Reasoning', ts,
              reasoning: true, text: think.slice(0, 500),
              ...(encrypted ? { encrypted: true, signature: String(b.signature).slice(0, 80) } : {}),
            });
          } else if (b?.type === 'text') {
            steps.push({
              idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
              text: String(b.text || '').slice(0, 500),
            });
          }
        }
      } else {
        steps.push({
          idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
          text: msgText(msg).slice(0, 500),
        });
      }
      if (usage && steps.length > before) Object.assign(steps[before], usage);
    }
    lineIdx++;
  }
  return steps;
}

function dominantEntrypoint(rawLines) {
  const counts = {};
  for (const line of rawLines || []) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.entrypoint) counts[d.entrypoint] = (counts[d.entrypoint] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function findSessionFile(sessionId) {
  const root = ROOT();
  let found = null;
  const find = (dir) => {
    if (found) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) find(full);
      else if (ent.name === `${sessionId}.jsonl`) found = full;
    }
  };
  find(root);
  return found;
}

function list({ limit = 50, sinceDays = 30, entrypointMatch } = {}) {
  const root = ROOT();
  const since = Date.now() / 1000 - (sinceDays || 30) * 86400;
  const out = [];

  function scanDir(dir, projectPath) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) scanDir(full, projectPath || full);
      else if (ent.name.endsWith('.jsonl')) {
        const sid = ent.name.replace(/\.jsonl$/, '');
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const lastTs = Math.floor(st.mtimeMs / 1000);
        if (lastTs < since) continue;

        let context = '', calls = 0, inTok = 0, outTok = 0, cwdHint = null;
        const epCounts = {};
        try {
          for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
            const s = line.trim();
            if (!s) continue;
            let data;
            try { data = JSON.parse(s); } catch { continue; }
            if (!cwdHint && data.cwd) cwdHint = data.cwd;
            if (data.type === 'user' && !context) {
              context = extractContext(msgText(data.message || {}));
            }
            if (data.type === 'assistant') {
              if (data.entrypoint) epCounts[data.entrypoint] = (epCounts[data.entrypoint] || 0) + 1;
              calls++;
              const u = (data.message || {}).usage || {};
              inTok += u.input_tokens || 0;
              outTok += u.output_tokens || 0;
            }
          }
        } catch {}

        const entrypoint = Object.entries(epCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        if (entrypointMatch && !entrypointMatch(entrypoint)) continue;

        const { project, project_path } = resolveProjectName({
          projectPath: projectPath || dir,
          sessionFile: full,
          agentId: AGENT_ID,
          cwdHint,
        });

        out.push({
          session_id: sid, project, project_path,
          context: context || '(无用户消息)',
          calls, tokens: inTok + outTok, inTok, outTok, lastTs,
          agent: AGENT_ID, entrypoint,
          client: clientFromEntrypoint(entrypoint),
        });
      }
    }
  }

  scanDir(root, null);
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

function trace(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return { error: 'not_found', steps: [], stats: {} };

  const rawLines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const timeSpan = fileTimeSpan(file, rawLines.length);
  const steps = buildClaudeStyleSteps(rawLines, timeSpan);
  const entrypoint = dominantEntrypoint(rawLines);
  const { project, project_path } = resolveProjectName({
    projectPath: path.dirname(file),
    sessionFile: file,
    agentId: AGENT_ID,
  });

  return {
    session_id: sessionId,
    agent: AGENT_ID,
    entrypoint,
    client: clientFromEntrypoint(entrypoint),
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
  buildClaudeStyleSteps,
  clientFromEntrypoint,
};
