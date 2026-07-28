// session-trace/shared.js — trace 适配器共用工具（项目名解析、步骤统计等）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { iterFileLines, MAX_JSONL_FILE_BYTES } = require('../jsonl-lines');

// trace 详情读取的兜底上限：行数或累计字节任一超限即停，绝不把整份大文件读进内存。
// 曾有用户的会话 jsonl 达 ~1GB，打开详情时 readFileSync + split 直接 OOM。
const MAX_TRACE_LINES = 50000;
const MAX_TRACE_BYTES = 128 * 1024 * 1024; // 128MB

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 从 user 消息提取可读上下文（去掉 XML 包装）；列表预览默认截断，trace 详情 forTrace 保留全文 */
function extractContext(text, { forTrace = false } = {}) {
  if (!text || typeof text !== 'string') return '';
  let s = text;
  const uq = s.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (uq) s = uq[1];
  if (forTrace) {
    return s.replace(/\r\n/g, '\n').trim();
  }
  s = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 160) s = s.slice(0, 157) + '…';
  return s;
}

/** trace 步骤正文上限（详情页按需加载，仅防极端超大行撑爆内存） */
const TRACE_STEP_TEXT_MAX = 65536;

function clipTraceText(text, max = TRACE_STEP_TEXT_MAX) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function msgText(msg) {
  if (!msg) return '';
  const c = msg.content ?? msg;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(x => (typeof x === 'string' ? x : (x?.text || ''))).join(' ').trim();
  }
  return '';
}

/** Cursor transcript 中 tool 正文常被 [REDACTED] 占位，保留可见摘要 */
function sanitizeCursorText(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text
    .replace(/\n*\[REDACTED\]\s*(\n|$)/gi, '\n')
    .replace(/^\[REDACTED\]\s*$/i, '')
    .trim();
  if (!s || s === '[REDACTED]') return '';
  return s;
}

/** 提取 tool_result / function_call_output 的可读文本 */
function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(x => (typeof x === 'string' ? x : (x?.text || x?.content || '')))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content === 'object') {
    if (typeof content.output === 'string') return content.output.trim();
    if (typeof content.text === 'string') return content.text.trim();
    try { return JSON.stringify(content, null, 2); } catch { return ''; }
  }
  return String(content);
}

function projectLabel(projectPath) {
  if (!projectPath) return 'unknown';
  const p = String(projectPath).replace(/\\/g, '/');
  return p.split('/').filter(Boolean).pop() || p;
}

function isReadableProjectName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('/')) return false;
  if (name.length > 64) return false;
  if (/^githubprojects-/i.test(name)) return false;
  if (/^-?Users-/i.test(name)) return false;
  if (/^-?[A-Za-z]+-/.test(name) && (name.match(/-/g) || []).length >= 3) return false;
  if (/^\d{1,2}$/.test(name)) return false;
  return true;
}

function pathFromEncodedSlug(slug) {
  if (!slug) return null;
  const s = String(slug).trim();
  const gh = s.match(/^(.*?githubprojects-)(.+)$/i);
  if (gh) {
    const prefix = gh[1].replace(/-$/, '');
    const repo = gh[2];
    const prefixPath = '/' + prefix.replace(/^-/, '').replace(/-/g, '/');
    if (/^\/(Users|home|var|opt|Volumes|tmp)\//i.test(prefixPath)) {
      return `${prefixPath}/${repo}`;
    }
  }
  if (!/^-?[A-Za-z][A-Za-z0-9-]*$/.test(s) || !s.includes('-')) return null;
  if (/^\d+$/.test(s.replace(/^-/, ''))) return null;
  const decoded = '/' + s.replace(/^-/, '').replace(/-/g, '/');
  if (/^\/(Users|home|var|opt|Volumes|tmp)\//i.test(decoded)) return decoded;
  return null;
}

function nameFromGithubprojectsSlug(slug) {
  const m = String(slug || '').match(/githubprojects-(.+)$/i);
  return m ? m[1] : null;
}

function isAgentStoragePath(p) {
  if (!p) return false;
  const s = String(p).replace(/\\/g, '/');
  return /\/\.claude\/projects\//.test(s) || /\/\.codex\/sessions\//.test(s);
}

/** 从会话 jsonl 读取 cwd */
function readSessionCwd(sessionFile, agentId) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return null;
  try {
    // 流式逐行：cwd 通常在文件头部的 session_meta，命中即 return，无需读完整份大文件。
    for (const line of iterFileLines(sessionFile)) {
      const s = line.trim();
      if (!s) continue;
      let data;
      try { data = JSON.parse(s); } catch { continue; }
      if (data.cwd && typeof data.cwd === 'string') {
        const p = expandHome(data.cwd);
        if (p.startsWith('/') || p.match(/^[A-Za-z]:\\/)) return p;
      }
      if (agentId === 'codex' && data.type === 'session_meta') {
        const cwd = data.payload?.cwd;
        if (cwd && typeof cwd === 'string') return expandHome(cwd);
      }
      const nested = data.payload?.cwd || data.context?.cwd;
      if (nested && typeof nested === 'string') {
        const p = expandHome(nested);
        if (p.startsWith('/') || p.match(/^[A-Za-z]:\\/)) return p;
      }
    }
  } catch {}
  return null;
}

/** 通用项目名解析 */
function resolveProjectName({ projectPath, sessionFile, agentId, cwdHint } = {}) {
  const cwd = cwdHint || readSessionCwd(sessionFile, agentId);
  if (cwd) {
    const p = expandHome(cwd);
    return { project: projectLabel(p), project_path: p };
  }
  const raw = projectPath ? String(projectPath).replace(/\\/g, '/') : '';
  const slug = raw ? (raw.split('/').filter(Boolean).pop() || raw) : '';
  const ghName = nameFromGithubprojectsSlug(slug);
  if (ghName) {
    const decoded = pathFromEncodedSlug(slug);
    const pathOut = decoded || (isAgentStoragePath(raw) ? null : raw) || slug;
    return { project: ghName, project_path: pathOut };
  }
  const decoded = pathFromEncodedSlug(slug);
  if (decoded) return { project: projectLabel(decoded), project_path: decoded };
  if (raw.startsWith('/') && fs.existsSync(raw) && !raw.endsWith('.jsonl') && !isAgentStoragePath(raw)) {
    const name = projectLabel(raw);
    if (isReadableProjectName(name)) return { project: name, project_path: raw };
  }
  const fallbackPath = isAgentStoragePath(raw) ? (pathFromEncodedSlug(slug) || 'unknown') : (raw || slug);
  return {
    project: isReadableProjectName(slug) ? slug : (ghName || projectLabel(fallbackPath) || slug || 'unknown'),
    project_path: fallbackPath,
  };
}

function shortProjectName(row) {
  if (!row) return '—';
  const resolved = resolveProjectName({
    projectPath: row.project_path || row.project,
    agentId: row.agent,
    cwdHint: row.cwd,
  });
  if (resolved.project && resolved.project !== 'unknown') return resolved.project;
  if (row.project && isReadableProjectName(row.project)) return row.project;
  return row.project || '—';
}

const ARTIFACT_TOOLS = new Set(['Write', 'GenerateImage', 'EditNotebook', 'ApplyPatch', 'StrReplace']);

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function isRawErrorLine(line) {
  const low = String(line).toLowerCase();
  if (low.includes('"is_error":true') || low.includes('"is_error": true')) return true;
  if (low.includes('"status":"error"') || low.includes('"status": "error"')) return true;
  return false;
}

function countRawErrors(rawLines) {
  let n = 0;
  for (const line of rawLines || []) if (isRawErrorLine(line)) n++;
  return n;
}

function pickUsage(obj) {
  const u = obj?.usage || obj?.message?.usage || obj?.payload?.usage || null;
  if (!u) return null;
  return {
    inTok: u.input_tokens || u.prompt_tokens || u.input || 0,
    outTok: u.output_tokens || u.completion_tokens || u.output || 0,
    cached: u.cache_read_input_tokens || u.cache_read_tokens || u.cached_tokens || 0,
  };
}

/** 从 tool 名拆 MCP：mcp__server__tool / mcp_server_tool（对齐 tokentelemetry） */
function mcpUsageFromToolCounts(toolCounts) {
  const out = {};
  for (const [name, n] of Object.entries(toolCounts || {})) {
    if (typeof name !== 'string' || !n) continue;
    let raw = name.startsWith('default_api:') ? name.slice('default_api:'.length) : name;
    let serverName = null;
    let tool = null;
    if (raw.startsWith('mcp__')) {
      const parts = raw.split('__');
      if (parts.length >= 3 && parts[1] && parts[2]) {
        serverName = parts[1];
        tool = parts.slice(2).join('__');
      }
    } else if (raw.startsWith('mcp_')) {
      const rest = raw.slice(4);
      const i = rest.indexOf('_');
      if (i > 0) {
        serverName = rest.slice(0, i);
        tool = rest.slice(i + 1);
      }
    }
    if (!serverName || !tool) continue;
    const server = out[serverName] || (out[serverName] = {});
    server[tool] = (server[tool] || 0) + n;
  }
  return out;
}

/** skills_used: [{ name, count }]，按次数降序 */
function skillsUsedFromCounts(skillCounts) {
  return Object.entries(skillCounts || {})
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name, count]) => ({ name, count }));
}

/** mcp_servers 列表（Trace UI）：[{ name, calls, tools: [{name,count}] }] */
function mcpServersFromUsage(mcpUsage) {
  return Object.entries(mcpUsage || {})
    .map(([name, tools]) => {
      const toolList = Object.entries(tools || {})
        .sort((a, b) => b[1] - a[1])
        .map(([t, count]) => ({ name: t, count }));
      const calls = toolList.reduce((s, t) => s + t.count, 0);
      return { name, calls, tools: toolList };
    })
    .sort((a, b) => b.calls - a.calls);
}

function buildTraceStats(steps, { filePath, rawLines, rawErrorCount, delegation } = {}) {
  let tools = 0, turns = 0, reasoning = 0, artifacts = 0, toolResults = 0, skills = 0;
  let inTok = 0, outTok = 0, cached = 0;
  const toolCounts = {};
  const skillCounts = {};
  const skillNames = [];
  for (const s of steps) {
    if (s.kind === 'tool') {
      tools++;
      const key = s.tool || s.label || 'tool';
      toolCounts[key] = (toolCounts[key] || 0) + 1;
      if (ARTIFACT_TOOLS.has(s.tool)) artifacts++;
      // Skill：结构化 Skill 工具，或 Codex 路径面包屑挂上的 s.skill
      if (s.skill) {
        skills++;
        skillNames.push(s.skill);
        skillCounts[s.skill] = (skillCounts[s.skill] || 0) + 1;
      } else if (s.tool === 'Skill') {
        skills++;
      }
    }
    if (s.kind === 'tool_result') toolResults++;
    if (s.kind === 'user') turns++;
    if (s.reasoning) reasoning++;
    inTok += s.inTok || 0;
    outTok += s.outTok || 0;
    cached += s.cached || 0;
  }
  const toolBreakdown = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  const skills_used = skillsUsedFromCounts(skillCounts);
  const mcp_usage = mcpUsageFromToolCounts(toolCounts);
  const mcp_servers = mcpServersFromUsage(mcp_usage);

  // Subagent types：按 agent_type 汇总 spawn / tokens / cost
  let subagent_types = [];
  if (delegation?.by_type) {
    subagent_types = Object.entries(delegation.by_type)
      .map(([name, row]) => ({
        name,
        spawns: row.count || 0,
        tokens: row.total || 0,
        cost: row.cost || 0,
      }))
      .sort((a, b) => (b.cost - a.cost) || (b.spawns - a.spawns));
  }

  let durationMs = 0;
  if (filePath) {
    try {
      const st = fs.statSync(filePath);
      durationMs = Math.max(0, st.mtimeMs - st.birthtimeMs);
    } catch {}
  }
  const tsList = steps.map(s => s.ts).filter(t => t > 0);
  if (tsList.length >= 2) {
    durationMs = Math.max(durationMs, Math.max(...tsList) - Math.min(...tsList));
  }
  const stats = {
    steps: steps.length,
    tools,
    toolResults,
    skills,
    skillNames,
    skills_used,
    tool_counts: toolCounts,
    toolBreakdown,
    mcp_usage,
    mcp_servers,
    artifacts,
    reasoning,
    turns,
    // 流式路径不保留整份 rawLines，改用预先累计的 rawErrorCount。
    errors: rawErrorCount != null ? rawErrorCount : countRawErrors(rawLines),
    duration_ms: durationMs,
    duration: formatDuration(durationMs),
    tokens: { input: inTok, output: outTok, cached },
  };
  if (delegation) {
    stats.delegation = delegation;
    stats.subagent_types = subagent_types;
  }
  return stats;
}

function fileTimeSpan(filePath, lineCount) {
  try {
    const st = fs.statSync(filePath);
    const t0 = st.birthtimeMs;
    const t1 = st.mtimeMs;
    const span = Math.max(t1 - t0, (lineCount || 1) * 500);
    return { t0, span, lineCount: lineCount || 1 };
  } catch {
    return { t0: Date.now(), span: (lineCount || 1) * 1000, lineCount: lineCount || 1 };
  }
}

function stepTs(timeSpan, lineIdx) {
  const { t0, span, lineCount } = timeSpan;
  return t0 + Math.floor((lineIdx / Math.max(lineCount, 1)) * span);
}

// 流式读取会话 jsonl 为「有界」的非空原始行数组（替代 readFileSync().split().filter）。
// 行数或累计字节任一超限即 break（generator 关闭 fd → 不读完整份大文件），并置 truncated。
// 顺带累计 rawErrorCount，供 buildTraceStats 免去二次全量扫描。
function readBoundedLines(file, { maxLines = MAX_TRACE_LINES, maxBytes = MAX_TRACE_BYTES } = {}) {
  const lines = [];
  let bytes = 0, truncated = false, rawErrorCount = 0;
  try {
    for (const line of iterFileLines(file)) {
      if (!line.trim()) continue;
      if (isRawErrorLine(line)) rawErrorCount++;
      lines.push(line);
      bytes += line.length;
      if (lines.length >= maxLines || bytes >= maxBytes) { truncated = true; break; }
    }
  } catch { /* 读取中断：用已收集的行降级 */ }
  return { lines, lineCount: lines.length, truncated, rawErrorCount };
}

function traceCacheKey(file, st) {
  return `${file}|${st.mtimeMs}|${st.size}`;
}

// trace 结果的 LRU 缓存工厂：key=文件身份（路径|mtime|size），文件一改动即自然失活。
// get 返回浅拷贝并克隆 stats.tokens——enrichTraceWithDb 会就地改写 tokens，避免污染缓存。
function createTraceCache(max = 6) {
  const map = new Map();
  const clone = (hit) => ({ ...hit, stats: { ...hit.stats, tokens: { ...(hit.stats && hit.stats.tokens) } } });
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      map.delete(key); map.set(key, hit); // LRU：命中挪到队尾
      return clone(hit);
    },
    set(key, value) {
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
      return clone(value);
    },
  };
}

module.exports = {
  expandHome,
  extractContext,
  clipTraceText,
  TRACE_STEP_TEXT_MAX,
  msgText,
  sanitizeCursorText,
  toolResultText,
  projectLabel,
  resolveProjectName,
  shortProjectName,
  readSessionCwd,
  pickUsage,
  buildTraceStats,
  isRawErrorLine,
  mcpUsageFromToolCounts,
  skillsUsedFromCounts,
  mcpServersFromUsage,
  fileTimeSpan,
  stepTs,
  readBoundedLines,
  traceCacheKey,
  createTraceCache,
  MAX_TRACE_LINES,
  MAX_TRACE_BYTES,
  MAX_JSONL_FILE_BYTES,
  pathFromEncodedSlug,
  nameFromGithubprojectsSlug,
  formatDuration,
};
