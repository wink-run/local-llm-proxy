// session-skill-usage.js
// 对齐 tokentelemetry：从会话文件提取 Skill 调用，写入 skill_calls，供 Trace / 闲置扫描共用。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  extractSkillsFromCursorRecord,
  extractSkillsFromWorkbuddySpan,
  extractSkillsFromToolCall,
} = require('./skill-signals');

/** 与 resource-skill-cleanup 一致：plugin:name / path 取末段小写 */
function normalizeSkillKey(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const parts = s.split(/[/:]/);
  return parts[parts.length - 1].toLowerCase();
}

// Claude：Slash 命令标签；内置 CLI 不算 Skill（同 tokentelemetry）
// 支持中文 Skill 名（如 /写诗）；\w 在 JS 不含 Unicode 字母
const COMMAND_NAME_RE = /<command-name>\/?([^<\s]+)<\/command-name>/g;
const BUILTIN_CLI_COMMANDS = new Set([
  'add-dir', 'agents', 'bashes', 'bug', 'clear', 'compact', 'config',
  'context', 'cost', 'doctor', 'exit', 'export', 'fast', 'help', 'hooks',
  'ide', 'install-github-app', 'login', 'logout', 'mcp', 'memory',
  'migrate-installer', 'model', 'output-style', 'permissions', 'plan', 'plugin',
  'privacy-settings', 'quit', 'release-notes', 'resume', 'rewind', 'status',
  'statusline', 'terminal-setup', 'theme', 'todos', 'upgrade', 'usage', 'vim',
]);

// Codex：无结构化 Skill 事件，靠读 SKILL.md 路径面包屑
const CODEX_SKILL_RE = /skills[/\\]+([\w.-]+)[/\\]+SKILL\.md/gi;

// v2：同一次扫盘同时写入 skill_calls + tool_calls（换前缀以便已扫文件补录工具）
const IMPORT_PREFIX = 'agent-usage::v2::';

/** 解析工具名 → key / kind / mcp_server */
function classifyToolName(rawName) {
  let raw = String(rawName || '').trim();
  if (!raw) return null;
  if (raw.startsWith('default_api:')) raw = raw.slice('default_api:'.length);
  // Skill 工具本身计入 skill_calls，不重复进工具榜
  if (raw === 'Skill' || raw.toLowerCase() === 'skill' || raw === 'activate_skill') return null;

  let mcpServer = null;
  let tool = raw;
  let kind = 'builtin';
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__');
    if (parts.length >= 3 && parts[1] && parts[2]) {
      mcpServer = parts[1];
      tool = parts.slice(2).join('__');
      kind = 'mcp';
    }
  } else if (raw.startsWith('mcp_')) {
    const rest = raw.slice(4);
    const i = rest.indexOf('_');
    if (i > 0) {
      mcpServer = rest.slice(0, i);
      tool = rest.slice(i + 1);
      kind = 'mcp';
    }
  } else if (raw.startsWith('dispatch:')) {
    kind = 'dispatch';
    tool = raw.slice('dispatch:'.length) || raw;
  }
  const key = String(tool).toLowerCase();
  if (!key) return null;
  return { tool_key: key, tool_raw: tool, tool_kind: kind, mcp_server: mcpServer };
}

function extractToolsFromClaudeRecord(data) {
  const out = [];
  if (!data || data.type !== 'assistant') return out;
  const blocks = data.message?.content;
  if (!Array.isArray(blocks)) return out;
  for (const b of blocks) {
    if (b?.type !== 'tool_use' || !b.name) continue;
    const c = classifyToolName(b.name);
    if (c) out.push(c);
  }
  return out;
}

function extractToolsFromCodexRecord(data) {
  if (!data || data.type !== 'response_item') return [];
  const p = data.payload || {};
  if (p.type !== 'function_call' || !p.name) return [];
  const c = classifyToolName(p.name);
  return c ? [c] : [];
}

function extractToolsFromCursorRecord(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  // Cursor transcript：assistant message 内 tool_calls / content tool_use
  const msg = data.message || data;
  const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls
    : (Array.isArray(data.tool_calls) ? data.tool_calls : []);
  for (const tc of tcs) {
    const name = tc?.function?.name || tc?.name;
    const c = classifyToolName(name);
    if (c) out.push(c);
  }
  const blocks = msg.content;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b?.type === 'tool_use' && b.name) {
        const c = classifyToolName(b.name);
        if (c) out.push(c);
      }
    }
  }
  // Cursor stream 形态：toolCallName / tool_name
  const streamName = data.toolCallName || data.tool_name || data.name;
  if (data.type === 'tool_call' || data.subtype === 'started' || data.subtype === 'completed') {
    const c = classifyToolName(streamName);
    if (c) out.push(c);
  }
  return out;
}

function extractToolsFromWorkbuddySpan(span) {
  const type = String(span?.type || '').toLowerCase();
  if (type !== 'tool' && type !== 'tool_call' && type !== 'function') return [];
  const name = span.name || span.toolName || span.function?.name || span.attributes?.name;
  const c = classifyToolName(name);
  return c ? [c] : [];
}

function pushToolRows(acc, tools, meta) {
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    acc.push({
      ts: meta.ts,
      agent_id: meta.agent_id,
      session_id: meta.session_id,
      tool_key: t.tool_key,
      tool_raw: t.tool_raw,
      tool_kind: t.tool_kind,
      mcp_server: t.mcp_server,
      data_source: meta.data_source,
      source_path: meta.source_path,
      call_uid: `${meta.uidPrefix}:${i}:${t.tool_key}`,
    });
  }
}

function skillNameFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  return input.skill || input.command || input.name || null;
}

function tsFromRecord(data, fallbackMs) {
  if (data?.timestamp) {
    const parsed = Date.parse(data.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof data?.timestamp === 'number' && data.timestamp > 1e12) return data.timestamp;
  if (typeof data?.timestamp === 'number' && data.timestamp > 1e9) return data.timestamp * 1000;
  return fallbackMs || Date.now();
}

/**
 * 从 Claude jsonl 单行提取 Skill 调用（两条信号）：
 * 1) assistant tool_use name=Skill + input.skill
 * 2) user 行 <command-name>/xxx</command-name>（过滤内置命令）
 */
function extractSkillsFromClaudeRecord(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;

  if (data.type === 'assistant') {
    const blocks = data.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b?.type !== 'tool_use' || b.name !== 'Skill') continue;
        const raw = skillNameFromInput(b.input);
        const key = normalizeSkillKey(raw);
        if (key) out.push({ raw: String(raw), key, signal: 'tool' });
      }
    }
  }

  if (data.type === 'user') {
    const msg = data.message || {};
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = msg.content
        .map(b => (typeof b === 'string' ? b : (b?.text || '')))
        .join('\n');
    }
    if (text) {
      COMMAND_NAME_RE.lastIndex = 0;
      let m;
      while ((m = COMMAND_NAME_RE.exec(text)) !== null) {
        const cmd = m[1];
        if (!cmd || BUILTIN_CLI_COMMANDS.has(cmd)) continue;
        const key = normalizeSkillKey(cmd);
        if (key) out.push({ raw: cmd, key, signal: 'slash' });
      }
    }
  }

  return out;
}

/** 从 Codex jsonl 单行提取 Skill（function_call arguments 中的 SKILL.md 路径） */
function extractSkillsFromCodexRecord(data) {
  if (!data || typeof data !== 'object') return [];
  if (data.type !== 'response_item') return [];
  const p = data.payload || {};
  if (p.type !== 'function_call') return [];
  return extractSkillsFromToolCall(p.name, p.arguments, { signalPrefix: 'codex' });
}

function walkJsonlFiles(root, depth = 0, acc = []) {
  if (!root || !fs.existsSync(root) || depth > 8) return acc;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      walkJsonlFiles(full, depth + 1, acc);
      continue;
    }
    if (ent.isFile() && ent.name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}

function sessionIdFromClaudeFile(filePath, firstSid) {
  if (firstSid) return String(firstSid);
  return path.basename(filePath, '.jsonl');
}

function sessionIdFromCodexFile(filePath) {
  return path.basename(filePath, '.jsonl');
}

/**
 * 扫描单个 Claude jsonl
 * @returns {{ calls: object[], tools: object[], sessionId: string }}
 */
function scanClaudeJsonlFile(filePath, st) {
  const calls = [];
  const tools = [];
  let sessionId = null;
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return { calls, tools, sessionId: '' }; }
  const lines = text.split(/\r?\n/);
  const fileT0 = st?.birthtimeMs || Date.now();
  const fileSpan = Math.max((st?.mtimeMs || fileT0) - fileT0, lines.length * 500);
  let lineIdx = 0;
  for (const line of lines) {
    if (!line.trim()) { lineIdx++; continue; }
    let data;
    try { data = JSON.parse(line); } catch { lineIdx++; continue; }
    if (data.sessionId && !sessionId) sessionId = data.sessionId;
    const estTs = fileT0 + (lineIdx / Math.max(lines.length, 1)) * fileSpan;
    const ts = tsFromRecord(data, estTs);
    const sid = sessionIdFromClaudeFile(filePath, sessionId);
    const extracted = extractSkillsFromClaudeRecord(data);
    for (let i = 0; i < extracted.length; i++) {
      const sk = extracted[i];
      calls.push({
        ts,
        agent_id: 'claude-code',
        session_id: sid,
        skill_key: sk.key,
        skill_raw: sk.raw,
        data_source: 'session-claude',
        source_path: filePath,
        call_uid: `claude:${sid}:${lineIdx}:${i}:${sk.key}`,
        signal: sk.signal,
      });
    }
    pushToolRows(tools, extractToolsFromClaudeRecord(data), {
      ts, agent_id: 'claude-code', session_id: sid,
      data_source: 'session-claude', source_path: filePath,
      uidPrefix: `claude-tool:${sid}:${lineIdx}`,
    });
    lineIdx++;
  }
  return { calls, tools, sessionId: sessionIdFromClaudeFile(filePath, sessionId) };
}

function scanCodexJsonlFile(filePath, st) {
  const calls = [];
  const tools = [];
  const sessionId = sessionIdFromCodexFile(filePath);
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return { calls, tools, sessionId }; }
  const lines = text.split(/\r?\n/);
  const fileT0 = st?.birthtimeMs || Date.now();
  const fileSpan = Math.max((st?.mtimeMs || fileT0) - fileT0, lines.length * 500);
  let lineIdx = 0;
  for (const line of lines) {
    if (!line.trim()) { lineIdx++; continue; }
    let data;
    try { data = JSON.parse(line); } catch { lineIdx++; continue; }
    const estTs = fileT0 + (lineIdx / Math.max(lines.length, 1)) * fileSpan;
    const ts = tsFromRecord(data, estTs);
    const extracted = extractSkillsFromCodexRecord(data);
    for (let i = 0; i < extracted.length; i++) {
      const sk = extracted[i];
      calls.push({
        ts,
        agent_id: 'codex',
        session_id: sessionId,
        skill_key: sk.key,
        skill_raw: sk.raw,
        data_source: 'session-codex',
        source_path: filePath,
        call_uid: `codex:${sessionId}:${lineIdx}:${i}:${sk.key}`,
        signal: sk.signal,
      });
    }
    pushToolRows(tools, extractToolsFromCodexRecord(data), {
      ts, agent_id: 'codex', session_id: sessionId,
      data_source: 'session-codex', source_path: filePath,
      uidPrefix: `codex-tool:${sessionId}:${lineIdx}`,
    });
    lineIdx++;
  }
  return { calls, tools, sessionId };
}

function walkCursorTranscriptFiles(root, depth = 0, acc = []) {
  if (!root || !fs.existsSync(root) || depth > 10) return acc;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      walkCursorTranscriptFiles(full, depth + 1, acc);
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const norm = full.replace(/\\/g, '/');
    if (norm.includes('/agent-transcripts/')) acc.push(full);
  }
  return acc;
}

function sessionIdFromCursorFile(filePath) {
  const base = path.basename(filePath, '.jsonl');
  if (base) return base;
  return path.basename(path.dirname(filePath));
}

function scanCursorJsonlFile(filePath, st) {
  const calls = [];
  const tools = [];
  const sessionId = sessionIdFromCursorFile(filePath);
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return { calls, tools, sessionId }; }
  const lines = text.split(/\r?\n/);
  const fileT0 = st?.birthtimeMs || Date.now();
  const fileSpan = Math.max((st?.mtimeMs || fileT0) - fileT0, lines.length * 500);
  let lineIdx = 0;
  for (const line of lines) {
    if (!line.trim()) { lineIdx++; continue; }
    let data;
    try { data = JSON.parse(line); } catch { lineIdx++; continue; }
    const estTs = fileT0 + (lineIdx / Math.max(lines.length, 1)) * fileSpan;
    const ts = tsFromRecord(data, estTs);
    const extracted = extractSkillsFromCursorRecord(data);
    for (let i = 0; i < extracted.length; i++) {
      const sk = extracted[i];
      calls.push({
        ts,
        agent_id: 'cursor',
        session_id: sessionId,
        skill_key: sk.key,
        skill_raw: sk.raw,
        data_source: 'session-cursor',
        source_path: filePath,
        call_uid: `cursor:${sessionId}:${lineIdx}:${i}:${sk.key}`,
        signal: sk.signal,
      });
    }
    pushToolRows(tools, extractToolsFromCursorRecord(data), {
      ts, agent_id: 'cursor', session_id: sessionId,
      data_source: 'session-cursor', source_path: filePath,
      uidPrefix: `cursor-tool:${sessionId}:${lineIdx}`,
    });
    lineIdx++;
  }
  return { calls, tools, sessionId };
}

function walkWorkbuddyTraceFiles(root, depth = 0, acc = []) {
  if (!root || !fs.existsSync(root) || depth > 8) return acc;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  const re = /^trace_.*\.json$/i;
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      walkWorkbuddyTraceFiles(full, depth + 1, acc);
      continue;
    }
    if (ent.isFile() && re.test(ent.name)) acc.push(full);
  }
  return acc;
}

function sessionIdFromWorkbuddyFile(filePath, doc) {
  const id = doc?.trace?.traceId || doc?.traceId || doc?.id;
  if (id) return String(id);
  return path.basename(filePath).replace(/^trace_/i, '').replace(/\.json$/i, '');
}

function scanWorkbuddyTraceFile(filePath, st) {
  const calls = [];
  const tools = [];
  let doc;
  try { doc = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {
    return { calls, tools, sessionId: '' };
  }
  const sessionId = sessionIdFromWorkbuddyFile(filePath, doc);
  const spans = Array.isArray(doc?.spans) ? doc.spans : [];
  const fileT0 = st?.birthtimeMs || Date.now();
  const fileSpan = Math.max((st?.mtimeMs || fileT0) - fileT0, Math.max(spans.length, 1) * 500);

  spans.forEach((span, idx) => {
    if (!span || typeof span !== 'object') return;
    const type = String(span.type || '').toLowerCase();
    if (type !== 'tool' && type !== 'tool_call' && type !== 'function') return;

    let ts = fileT0 + (idx / Math.max(spans.length, 1)) * fileSpan;
    const rawTs = span.startedAt || span.startTime || span.timestamp;
    if (typeof rawTs === 'string') {
      const parsed = Date.parse(rawTs);
      if (Number.isFinite(parsed)) ts = parsed;
    } else if (typeof rawTs === 'number') {
      ts = rawTs > 1e12 ? rawTs : rawTs * 1000;
    }

    const extracted = extractSkillsFromWorkbuddySpan(span);
    extracted.forEach((sk, i) => {
      calls.push({
        ts,
        agent_id: 'workbuddy',
        session_id: sessionId,
        skill_key: sk.key,
        skill_raw: sk.raw,
        data_source: 'session-workbuddy',
        source_path: filePath,
        call_uid: `workbuddy:${sessionId}:${idx}:${i}:${sk.key}`,
        signal: sk.signal,
      });
    });
    pushToolRows(tools, extractToolsFromWorkbuddySpan(span), {
      ts, agent_id: 'workbuddy', session_id: sessionId,
      data_source: 'session-workbuddy', source_path: filePath,
      uidPrefix: `workbuddy-tool:${sessionId}:${idx}`,
    });
  });

  return { calls, tools, sessionId };
}

/**
 * 增量同步 Claude / Codex / Cursor / WorkBuddy 会话中的 Skill + 工具调用
 */
function syncSkillUsage(localStats) {
  if (!localStats || typeof localStats.recordSkillCalls !== 'function') {
    return { ok: false, error: 'local-stats skill API missing', scanned: 0, recorded: 0 };
  }

  const roots = [
    { root: path.join(os.homedir(), '.claude', 'projects'), kind: 'claude', listFiles: walkJsonlFiles },
    { root: path.join(os.homedir(), '.codex', 'sessions'), kind: 'codex', listFiles: walkJsonlFiles },
    { root: path.join(os.homedir(), '.cursor', 'projects'), kind: 'cursor', listFiles: walkCursorTranscriptFiles },
    { root: path.join(os.homedir(), '.workbuddy', 'traces'), kind: 'workbuddy', listFiles: walkWorkbuddyTraceFiles },
  ];

  let scanned = 0;
  let recorded = 0;
  let toolsRecorded = 0;
  let skipped = 0;

  for (const { root, kind, listFiles } of roots) {
    const files = listFiles(root);
    for (const file of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const stateKey = IMPORT_PREFIX + file;
      const prev = localStats.getImportState?.(stateKey);
      if (prev && prev.mtime === Math.floor(st.mtimeMs) && prev.size === st.size) {
        skipped++;
        continue;
      }
      scanned++;
      let scannedFile = { calls: [], tools: [] };
      if (kind === 'codex') scannedFile = scanCodexJsonlFile(file, st);
      else if (kind === 'cursor') scannedFile = scanCursorJsonlFile(file, st);
      else if (kind === 'workbuddy') scannedFile = scanWorkbuddyTraceFile(file, st);
      else scannedFile = scanClaudeJsonlFile(file, st);

      // 文件变更时先清该路径旧记录，再写入，避免重复
      if (typeof localStats.deleteSkillCallsBySourcePath === 'function') {
        localStats.deleteSkillCallsBySourcePath(file);
      }
      if (typeof localStats.deleteToolCallsBySourcePath === 'function') {
        localStats.deleteToolCallsBySourcePath(file);
      }
      if (scannedFile.calls?.length) {
        recorded += localStats.recordSkillCalls(scannedFile.calls) || 0;
      }
      if (scannedFile.tools?.length && typeof localStats.recordToolCalls === 'function') {
        toolsRecorded += localStats.recordToolCalls(scannedFile.tools) || 0;
      }
      localStats.setImportState?.(stateKey, Math.floor(st.mtimeMs), st.size);
    }
  }

  console.log('[skill-usage]', JSON.stringify({ scanned, skipped, recorded, toolsRecorded }));
  return { ok: true, scanned, skipped, recorded, toolsRecorded };
}

/** 供 Trace 统计：skills_used 形态 [{ name, count }] */
function rollupSkillsUsed(calls) {
  const counts = {};
  for (const c of calls || []) {
    const name = c.skill_raw || c.skill_key;
    if (!name) continue;
    counts[name] = (counts[name] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name, count]) => ({ name, count }));
}

module.exports = {
  normalizeSkillKey,
  skillNameFromInput,
  COMMAND_NAME_RE,
  BUILTIN_CLI_COMMANDS,
  CODEX_SKILL_RE,
  classifyToolName,
  extractSkillsFromClaudeRecord,
  extractSkillsFromCodexRecord,
  extractSkillsFromCursorRecord,
  extractToolsFromClaudeRecord,
  extractToolsFromCodexRecord,
  scanClaudeJsonlFile,
  scanCodexJsonlFile,
  scanCursorJsonlFile,
  scanWorkbuddyTraceFile,
  syncSkillUsage,
  rollupSkillsUsed,
  IMPORT_PREFIX,
};
