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

// Slash 命令标签；内置 CLI 不算 Skill（对齐 tokentelemetry）
// 用 [^<\s]+ 以支持中文 Skill 名（如 /写诗）；JS \w 不含 Unicode 字母
const COMMAND_NAME_RE = /<command-name>\/?([^<\s]+)<\/command-name>/g;
const BUILTIN_CLI_COMMANDS = new Set([
  'add-dir', 'agents', 'bashes', 'bug', 'clear', 'compact', 'config',
  'context', 'cost', 'doctor', 'exit', 'export', 'fast', 'help', 'hooks',
  'ide', 'install-github-app', 'login', 'logout', 'mcp', 'memory',
  'migrate-installer', 'model', 'output-style', 'permissions', 'plan', 'plugin',
  'privacy-settings', 'quit', 'release-notes', 'resume', 'rewind', 'status',
  'statusline', 'terminal-setup', 'theme', 'todos', 'upgrade', 'usage', 'vim',
]);

function slashSkillsFromUserText(text) {
  const out = [];
  if (!text) return out;
  COMMAND_NAME_RE.lastIndex = 0;
  let m;
  while ((m = COMMAND_NAME_RE.exec(String(text))) !== null) {
    const cmd = m[1];
    if (!cmd || BUILTIN_CLI_COMMANDS.has(cmd)) continue;
    out.push(cmd);
  }
  return out;
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
            const text = String(b.text || '');
            steps.push({
              idx: steps.length, kind: 'user', label: 'User prompt', ts,
              text: extractContext(text), ...(usage || {}),
            });
            // Slash 调用 Skill（与 tool_use Skill 并列计入）
            for (const skill of slashSkillsFromUserText(text)) {
              steps.push({
                idx: steps.length, kind: 'tool',
                label: `Skill · ${skill}`, ts,
                tool: 'Skill', skill, signal: 'slash',
              });
            }
          } else if (typeof b === 'string' && b.trim()) {
            steps.push({
              idx: steps.length, kind: 'user', label: 'User prompt', ts,
              text: extractContext(b), ...(usage || {}),
            });
            for (const skill of slashSkillsFromUserText(b)) {
              steps.push({
                idx: steps.length, kind: 'tool',
                label: `Skill · ${skill}`, ts,
                tool: 'Skill', skill, signal: 'slash',
              });
            }
          }
        }
      } else {
        const rawText = msgText(msg);
        const text = extractContext(rawText);
        if (text) {
          steps.push({
            idx: steps.length, kind: 'user', label: 'User prompt', ts,
            text, ...(usage || {}),
          });
        }
        for (const skill of slashSkillsFromUserText(rawText)) {
          steps.push({
            idx: steps.length, kind: 'tool',
            label: `Skill · ${skill}`, ts,
            tool: 'Skill', skill, signal: 'slash',
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
              tool: b.name, ...(skill ? { skill, signal: 'tool' } : {}), input: b.input,
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

/**
 * 汇总 Claude Code 子代理（Task/Agent）用量。
 * 目录：<project>/<sessionId>/subagents/agent-*.jsonl + .meta.json
 */
function claudeSubagentUsage(sessionFile, sessionId) {
  const fs = require('fs');
  const path = require('path');
  let estimateCost = () => 0;
  try { estimateCost = require('../pricing').estimateCost; } catch { /* optional */ }

  const subDir = path.join(path.dirname(sessionFile), sessionId, 'subagents');
  let names;
  try {
    if (!fs.existsSync(subDir)) return null;
    names = fs.readdirSync(subDir).filter(n => n.startsWith('agent-') && n.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (!names.length) return null;

  const entries = [];
  for (const name of names.sort()) {
    const agentId = name.slice('agent-'.length, -'.jsonl'.length);
    const jsonlPath = path.join(subDir, name);
    const metaPath = path.join(subDir, `agent-${agentId}.meta.json`);
    let agentType = null;
    let description = null;
    let toolUseId = null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && typeof meta === 'object') {
        agentType = meta.agentType || null;
        description = meta.description || null;
        toolUseId = meta.toolUseId || null;
      }
    } catch { /* ignore */ }

    const tokens = { input: 0, output: 0, cached: 0, cache_creation: 0, total: 0 };
    let model = null;
    try {
      for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let data;
        try { data = JSON.parse(line); } catch { continue; }
        if (data.type !== 'assistant') continue;
        const msg = data.message && typeof data.message === 'object' ? data.message : {};
        if (msg.model && msg.model !== '<synthetic>' && !model) model = msg.model;
        if (!agentType && data.attributionAgent) agentType = data.attributionAgent;
        const usage = msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
        if (!usage) continue;
        const cr = usage.cache_read_input_tokens || 0;
        const cc = usage.cache_creation_input_tokens || 0;
        tokens.input += usage.input_tokens || 0;
        tokens.output += usage.output_tokens || 0;
        tokens.cached = Math.max(tokens.cached, cr);
        tokens.cache_creation += cc;
      }
    } catch { continue; }
    tokens.total = tokens.input + tokens.output + tokens.cached;
    let cost = 0;
    try {
      cost = estimateCost(model, tokens.input, tokens.output, tokens.cache_creation, tokens.cached, 'claude-cli') || 0;
    } catch { cost = 0; }
    entries.push({
      agent_id: agentId,
      agent_type: agentType || 'unknown',
      description,
      tool_use_id: toolUseId,
      model,
      tokens,
      cost,
    });
  }
  if (!entries.length) return null;

  const totals = { input: 0, output: 0, cached: 0, cache_creation: 0, total: 0 };
  const by_type = {};
  for (const e of entries) {
    for (const k of Object.keys(totals)) totals[k] += e.tokens[k] || 0;
    const bt = by_type[e.agent_type] || (by_type[e.agent_type] = { count: 0, total: 0, cost: 0 });
    bt.count += 1;
    bt.total += e.tokens.total || 0;
    bt.cost = Math.round((bt.cost + (e.cost || 0)) * 1e6) / 1e6;
  }
  return {
    spawn_count: entries.length,
    subagents: entries,
    totals,
    by_type,
    cost: Math.round(entries.reduce((s, e) => s + (e.cost || 0), 0) * 1e6) / 1e6,
  };
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
  // 先按 mtime 收集候选，再只解析最近一批，避免 30 天窗口内全量读大 jsonl
  const candidates = [];

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
        candidates.push({ full, sid, lastTs, projectPath: projectPath || dir });
      }
    }
  }

  scanDir(root, null);
  candidates.sort((a, b) => b.lastTs - a.lastTs);
  // 有 entrypoint 过滤时多解析一些，保证筛后仍够 limit
  const parseBudget = entrypointMatch ? Math.max(limit * 8, 80) : Math.max(limit * 3, limit);
  const out = [];

  for (const c of candidates.slice(0, parseBudget)) {
    let context = '', calls = 0, inTok = 0, outTok = 0, cwdHint = null;
    const epCounts = {};
    try {
      for (const line of fs.readFileSync(c.full, 'utf8').split('\n')) {
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
      projectPath: c.projectPath,
      sessionFile: c.full,
      agentId: AGENT_ID,
      cwdHint,
    });

    out.push({
      session_id: c.sid, project, project_path,
      context: context || '(无用户消息)',
      calls, tokens: inTok + outTok, inTok, outTok, lastTs: c.lastTs,
      agent: AGENT_ID, entrypoint,
      client: clientFromEntrypoint(entrypoint),
    });
    if (out.length >= limit) break;
  }

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
  const delegation = claudeSubagentUsage(file, sessionId);

  return {
    session_id: sessionId,
    agent: AGENT_ID,
    entrypoint,
    client: clientFromEntrypoint(entrypoint),
    project, project_path,
    cwd: project_path,
    steps,
    stats: buildTraceStats(steps, { filePath: file, rawLines, delegation: delegation || undefined }),
  };
}

module.exports = {
  agentId: AGENT_ID,
  profile: PROFILE,
  list,
  trace,
  findSessionFile,
  buildClaudeStyleSteps,
  claudeSubagentUsage,
  slashSkillsFromUserText,
  clientFromEntrypoint,
};
