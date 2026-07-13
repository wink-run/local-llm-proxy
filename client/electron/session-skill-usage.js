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

const IMPORT_PREFIX = 'skill-usage::';

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
 * 扫描单个 Claude jsonl，返回 skill_calls 行
 * @returns {{ calls: object[], sessionId: string }}
 */
function scanClaudeJsonlFile(filePath, st) {
  const calls = [];
  let sessionId = null;
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return { calls, sessionId: '' }; }
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
    const extracted = extractSkillsFromClaudeRecord(data);
    for (let i = 0; i < extracted.length; i++) {
      const sk = extracted[i];
      const sid = sessionIdFromClaudeFile(filePath, sessionId);
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
    lineIdx++;
  }
  return { calls, sessionId: sessionIdFromClaudeFile(filePath, sessionId) };
}

function scanCodexJsonlFile(filePath, st) {
  const calls = [];
  const sessionId = sessionIdFromCodexFile(filePath);
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return { calls, sessionId }; }
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
    lineIdx++;
  }
  return { calls, sessionId };
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
  const sessionId = sessionIdFromCursorFile(filePath);
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return { calls, sessionId }; }
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
    lineIdx++;
  }
  return { calls, sessionId };
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
  let doc;
  try { doc = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {
    return { calls, sessionId: '' };
  }
  const sessionId = sessionIdFromWorkbuddyFile(filePath, doc);
  const spans = Array.isArray(doc?.spans) ? doc.spans : [];
  const fileT0 = st?.birthtimeMs || Date.now();
  const fileSpan = Math.max((st?.mtimeMs || fileT0) - fileT0, Math.max(spans.length, 1) * 500);

  spans.forEach((span, idx) => {
    if (!span || typeof span !== 'object') return;
    const type = String(span.type || '').toLowerCase();
    if (type !== 'tool' && type !== 'tool_call' && type !== 'function') return;
    const extracted = extractSkillsFromWorkbuddySpan(span);
    if (!extracted.length) return;

    let ts = fileT0 + (idx / Math.max(spans.length, 1)) * fileSpan;
    const rawTs = span.startedAt || span.startTime || span.timestamp;
    if (typeof rawTs === 'string') {
      const parsed = Date.parse(rawTs);
      if (Number.isFinite(parsed)) ts = parsed;
    } else if (typeof rawTs === 'number') {
      ts = rawTs > 1e12 ? rawTs : rawTs * 1000;
    }

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
  });

  return { calls, sessionId };
}

/**
 * 增量同步 Claude / Codex / Cursor / WorkBuddy 会话中的 Skill 调用
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
      let calls = [];
      if (kind === 'codex') calls = scanCodexJsonlFile(file, st).calls;
      else if (kind === 'cursor') calls = scanCursorJsonlFile(file, st).calls;
      else if (kind === 'workbuddy') calls = scanWorkbuddyTraceFile(file, st).calls;
      else calls = scanClaudeJsonlFile(file, st).calls;

      // 文件变更时先清该路径旧记录，再写入，避免重复
      if (typeof localStats.deleteSkillCallsBySourcePath === 'function') {
        localStats.deleteSkillCallsBySourcePath(file);
      }
      if (calls.length) {
        recorded += localStats.recordSkillCalls(calls) || 0;
      }
      localStats.setImportState?.(stateKey, Math.floor(st.mtimeMs), st.size);
    }
  }

  console.log('[skill-usage]', JSON.stringify({ scanned, skipped, recorded }));
  return { ok: true, scanned, skipped, recorded };
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
  extractSkillsFromClaudeRecord,
  extractSkillsFromCodexRecord,
  extractSkillsFromCursorRecord,
  scanClaudeJsonlFile,
  scanCodexJsonlFile,
  scanCursorJsonlFile,
  scanWorkbuddyTraceFile,
  syncSkillUsage,
  rollupSkillsUsed,
  IMPORT_PREFIX,
};
