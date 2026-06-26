// client/electron/session-browser.js
// 从本地 Agent 会话文件读取「项目 / 上下文 / Trace」（参考 tokentelemetry）。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 从 user 消息提取可读上下文（去掉 XML 包装） */
function extractContext(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text;
  const uq = s.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (uq) s = uq[1];
  s = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 160) s = s.slice(0, 157) + '…';
  return s;
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

/** 提取 tool_result / function_call_output 的可读文本（string | 数组块 | {output} 等） */
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

/** 是否已是可读项目名（非编码 slug / 日期目录） */
function isReadableProjectName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('/')) return false;
  if (name.length > 64) return false;
  if (/^githubprojects-/i.test(name)) return false;
  if (/^-?Users-/i.test(name)) return false;
  // Claude/Cursor 等目录 slug：Users-ully-githubprojects-xxx
  if (/^-?[A-Za-z]+-/.test(name) && (name.match(/-/g) || []).length >= 3) return false;
  // Codex 会话目录常为日号（29）或年月路径末段
  if (/^\d{1,2}$/.test(name)) return false;
  return true;
}

/** 编码目录名 → 真实路径（如 -Users-ully-githubprojects-podcast） */
function pathFromEncodedSlug(slug) {
  if (!slug) return null;
  const s = String(slug).trim();

  // githubprojects 类 slug：仓库名可含连字符（local-llm-proxy），不能全局 replace('-','/')
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

/** 从 githubprojects- 类 slug 提取项目名 */
function nameFromGithubprojectsSlug(slug) {
  const m = String(slug || '').match(/githubprojects-(.+)$/i);
  return m ? m[1] : null;
}

/** Agent 内部会话存储目录（非真实工作区） */
function isAgentStoragePath(p) {
  if (!p) return false;
  const s = String(p).replace(/\\/g, '/');
  return /\/\.claude\/projects\//.test(s)
    || /\/\.codex\/sessions\//.test(s);
}

/** 从会话 jsonl 读取 cwd（Claude / Codex 等通用字段） */
function readSessionCwd(sessionFile, agentId) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return null;
  try {
    for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
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

/**
 * 通用项目名解析（各 Agent 共用）
 * 优先级：jsonl cwd → 真实路径 → 编码 slug 解码 → githubprojects- 后缀
 */
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
    // 禁止把 ~/.claude/projects/<slug> 当作项目路径
    const pathOut = decoded || (isAgentStoragePath(raw) ? null : raw) || slug;
    return { project: ghName, project_path: pathOut };
  }

  const decoded = pathFromEncodedSlug(slug);
  if (decoded) {
    return { project: projectLabel(decoded), project_path: decoded };
  }

  if (raw.startsWith('/') && fs.existsSync(raw) && !raw.endsWith('.jsonl') && !isAgentStoragePath(raw)) {
    const name = projectLabel(raw);
    if (isReadableProjectName(name)) {
      return { project: name, project_path: raw };
    }
  }

  const fallbackPath = isAgentStoragePath(raw) ? (pathFromEncodedSlug(slug) || 'unknown') : (raw || slug);
  return {
    project: isReadableProjectName(slug) ? slug : (ghName || projectLabel(fallbackPath) || slug || 'unknown'),
    project_path: fallbackPath,
  };
}

/** Cursor 项目目录 slug → 可读项目名（无 workspace.json 时的回退） */
function projectFromCursorSlug(slug) {
  const gh = nameFromGithubprojectsSlug(slug);
  if (gh) return gh;
  const decoded = pathFromEncodedSlug(slug);
  if (decoded) return projectLabel(decoded);
  const parts = String(slug || '').split('-');
  if (parts.length >= 2) return parts[parts.length - 1];
  return slug || 'unknown';
}

/** 解析 Cursor 项目名与路径（避免把 slug 当路径拆分） */
function resolveCursorProject(slug, projMap) {
  const mapped = projMap[slug];
  let project, project_path;

  if (mapped && mapped.startsWith('/') && fs.existsSync(mapped)) {
    project = projectLabel(mapped);
    project_path = mapped;
  } else if (/githubprojects-/i.test(slug)) {
    project = projectFromCursorSlug(slug);
    project_path = mapped || slug;
  } else if (mapped && mapped.startsWith('/')) {
    project = projectLabel(mapped);
    project_path = mapped;
  } else {
    project = projectFromCursorSlug(slug);
    project_path = slug;
  }

  // 兜底：project 不得为 slug / 长路径
  if (!project || project === slug || project === project_path
      || project.includes('/') || /^Users-/i.test(project)) {
    project = projectFromCursorSlug(slug);
  }
  // 悬浮提示等场景需要绝对路径，slug 解码为真实 cwd
  if (project_path && !project_path.startsWith('/') && !/^[A-Za-z]:\\/.test(project_path)) {
    const decoded = pathFromEncodedSlug(project_path) || pathFromEncodedSlug(slug);
    if (decoded) project_path = decoded;
  }
  return { project, project_path };
}

/** 前端/IPC 兜底：从 activity 行提取短项目名 */
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

/** 规范化 activity 行：同步修正 project / project_path */
function normalizeActivityRow(row, agentId) {
  if (!row) return row;
  const sessionFile = row.session_id ? findSessionJsonl(agentId, row.session_id) : null;
  const { project, project_path } = resolveProjectName({
    projectPath: row.project_path || row.project,
    sessionFile,
    agentId,
    cwdHint: row.cwd,
  });
  return { ...row, project, project_path };
}

// 产出类工具 → 计入 Artifacts
const ARTIFACT_TOOLS = new Set(['Write', 'GenerateImage', 'EditNotebook', 'ApplyPatch', 'StrReplace']);

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** 从 jsonl 原始行统计错误数 */
function countRawErrors(rawLines) {
  let n = 0;
  for (const line of rawLines || []) {
    const low = String(line).toLowerCase();
    if (low.includes('"is_error":true') || low.includes('"is_error": true')) n++;
    else if (low.includes('"status":"error"') || low.includes('"status": "error"')) n++;
  }
  return n;
}

/** 解析 usage 字段（各 Agent 格式略有差异） */
function pickUsage(obj) {
  const u = obj?.usage || obj?.message?.usage || obj?.payload?.usage || null;
  if (!u) return null;
  return {
    inTok:  u.input_tokens || u.prompt_tokens || u.input || 0,
    outTok: u.output_tokens || u.completion_tokens || u.output || 0,
    cached: u.cache_read_input_tokens || u.cache_read_tokens || u.cached_tokens || 0,
  };
}

/** 汇总 Trace 统计（参考 tokentelemetry Session Trace 顶栏） */
function buildTraceStats(steps, { filePath, rawLines } = {}) {
  let tools = 0, turns = 0, reasoning = 0, artifacts = 0, toolResults = 0, skills = 0;
  let inTok = 0, outTok = 0, cached = 0;
  const toolCounts = {};
  const skillNames = [];

  for (const s of steps) {
    if (s.kind === 'tool') {
      tools++;
      const key = s.tool || s.label || 'tool';
      toolCounts[key] = (toolCounts[key] || 0) + 1;
      if (ARTIFACT_TOOLS.has(s.tool)) artifacts++;
      if (s.tool === 'Skill') { skills++; if (s.skill) skillNames.push(s.skill); }
    }
    if (s.kind === 'tool_result') toolResults++;
    if (s.kind === 'user') turns++;
    if (s.reasoning) reasoning++;
    inTok  += s.inTok  || 0;
    outTok += s.outTok || 0;
    cached += s.cached || 0;
  }

  const toolBreakdown = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

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

  const errors = countRawErrors(rawLines);

  return {
    steps: steps.length,
    tools,
    toolResults,
    skills,
    skillNames,
    toolBreakdown,
    artifacts,
    reasoning,
    turns,
    errors,
    duration_ms: durationMs,
    duration: formatDuration(durationMs),
    tokens: { input: inTok, output: outTok, cached },
  };
}

/** 用 DB 统计补全 Token / 持续时间 / 费用 */
function enrichTraceWithDb(trace, dbRow) {
  if (!trace || trace.error || !dbRow) return trace;
  const stats = { ...(trace.stats || {}) };
  stats.tokens = stats.tokens || { input: 0, output: 0, cached: 0 };
  if (dbRow.inTok)  stats.tokens.input  = dbRow.inTok;
  if (dbRow.outTok) stats.tokens.output = dbRow.outTok;
  if (dbRow.cached) stats.tokens.cached = dbRow.cached;
  if (dbRow.firstTs && dbRow.lastTs && dbRow.lastTs > dbRow.firstTs) {
    stats.duration_ms = (dbRow.lastTs - dbRow.firstTs) * 1000;
    stats.duration = formatDuration(stats.duration_ms);
  }
  if (dbRow.calls) stats.db_calls = dbRow.calls;
  if (dbRow.cost_usd) stats.cost_usd = dbRow.cost_usd;
  return { ...trace, stats };
}

/** 按文件时间线分配步骤时间戳 */
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

// ── Cursor ───────────────────────────────────────────────────────────────────

function buildCursorProjectMap() {
  const map = {};
  const root = path.join(os.homedir(), '.cursor/projects');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return map; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const wsPath = path.join(root, slug, 'workspace.json');
    try {
      if (!fs.existsSync(wsPath)) continue;
      const data = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
      const folder = data.folder || data.path;
      if (folder) {
        map[slug] = decodeURIComponent(String(folder).replace(/^file:\/\//, ''));
        continue;
      }
    } catch {}
    for (const p of Object.values(map)) {
      if (p.replace(/\//g, '-').replace(/^-/, '') === slug) { map[slug] = p; break; }
    }
    if (!map[slug]) map[slug] = '/' + slug.replace(/-/g, '/');
  }
  return map;
}

/** 从 Cursor jsonl 路径提取项目 slug（…/projects/<slug>/agent-transcripts/…） */
function cursorProjectSlugFromFile(jsonlPath) {
  const normalized = String(jsonlPath).replace(/\\/g, '/');
  const marker = '/agent-transcripts/';
  const i = normalized.indexOf(marker);
  if (i > 0) return path.basename(normalized.slice(0, i));
  return path.basename(path.dirname(path.dirname(path.dirname(jsonlPath))));
}

function listCursorActivity({ limit = 50, sinceDays = 30 } = {}) {
  const root = path.join(os.homedir(), '.cursor/projects');
  const projMap = buildCursorProjectMap();
  const since = Date.now() / 1000 - (sinceDays || 30) * 86400;
  const out = [];

  let projectDirs;
  try { projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }

  for (const pd of projectDirs) {
    const { project: projectName, project_path: projectPath } = resolveCursorProject(pd.name, projMap);
    const transRoot = path.join(root, pd.name, 'agent-transcripts');
    let sessDirs;
    try { sessDirs = fs.readdirSync(transRoot, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }

    for (const sd of sessDirs) {
      const sid = sd.name;
      const cf = path.join(transRoot, sid, `${sid}.jsonl`);
      if (!fs.existsSync(cf)) continue;
      let st;
      try { st = fs.statSync(cf); } catch { continue; }
      const lastTs = Math.floor(st.mtimeMs / 1000);
      if (lastTs < since) continue;

      let context = '';
      let calls = 0;
      let inTok = 0, outTok = 0;
      try {
        const lines = fs.readFileSync(cf, 'utf8').split('\n');
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          let data;
          try { data = JSON.parse(s); } catch { continue; }
          const role = data.role;
          const msg = data.message || {};
          if (role === 'user') {
            if (!context) context = extractContext(msgText(msg));
          } else if (role === 'assistant') {
            calls++;
            const u = msg.usage || {};
            inTok  += u.input_tokens  || 0;
            outTok += u.output_tokens || 0;
          }
        }
      } catch {}

      out.push({
        session_id: sid,
        project: projectName,
        project_path: projectPath,
        context: context || '(无用户消息)',
        calls,
        tokens: inTok + outTok,
        inTok, outTok,
        lastTs,
        agent: 'cursor',
      });
    }
  }

  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

function getCursorTrace(sessionId) {
  const root = path.join(os.homedir(), '.cursor/projects');
  let files = [];
  try {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name === `${sessionId}.jsonl`) files.push(full);
      }
    };
    walk(root);
  } catch {}

  if (!files.length) return { error: 'not_found', steps: [], meta: {} };

  const cf = files[0];
  const slug = cursorProjectSlugFromFile(cf);
  const projMap = buildCursorProjectMap();
  const { project: projectName, project_path: projectPath } = resolveCursorProject(slug, projMap);

  const rawLines = fs.readFileSync(cf, 'utf8').split('\n').filter(l => l.trim());
  const timeSpan = fileTimeSpan(cf, rawLines.length);

  const steps = [];
  let lineIdx = 0;
  let agentTurns = 0;
  try {
    for (const line of rawLines) {
      let data;
      try { data = JSON.parse(line); } catch { lineIdx++; continue; }

      // Cursor 新版 jsonl：turn 结束标记（仅统计，不占用步骤列表）
      if (data.type === 'turn_ended') {
        lineIdx++;
        continue;
      }

      const role = data.role;
      const msg = data.message || {};
      const ts = stepTs(timeSpan, lineIdx);
      const usage = pickUsage(data) || pickUsage(msg);

      if (role === 'user') {
        steps.push({
          idx: steps.length, kind: 'user', label: 'User prompt', ts,
          text: extractContext(msgText(msg)) || msgText(msg),
          ...(usage || {}),
        });
      } else if (role === 'assistant') {
        agentTurns++;
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            const t = item?.type;
            if (t === 'tool_use' || t === 'tool-call') {
              steps.push({
                idx: steps.length, kind: 'tool', label: item.name || 'tool', ts,
                tool: item.name, input: item.input || item.arguments,
              });
            } else if (t === 'thinking' || t === 'reasoning') {
              const think = sanitizeCursorText(String(item.text || item.thinking || ''));
              if (think) {
                steps.push({
                  idx: steps.length, kind: 'assistant', label: 'Reasoning', ts,
                  reasoning: true,
                  text: think.slice(0, 500),
                });
              }
            } else if (t === 'text' && item.text) {
              const text = sanitizeCursorText(String(item.text));
              if (text) {
                steps.push({
                  idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
                  text: text.slice(0, 500),
                  ...(usage || {}),
                });
              }
            }
          }
        } else {
          const text = sanitizeCursorText(msgText(msg));
          if (text) {
            steps.push({
              idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
              text: text.slice(0, 500),
              ...(usage || {}),
            });
          }
        }
      }
      lineIdx++;
    }
  } catch (e) {
    return { error: e.message, steps: [], stats: {} };
  }

  const stats = buildTraceStats(steps, { filePath: cf, rawLines });
  if (agentTurns > 0) stats.turns = agentTurns;

  return {
    session_id: sessionId,
    agent: 'cursor',
    project: projectName,
    project_path: projectPath,
    cwd: projectPath,
    session_file: cf,
    steps,
    stats,
  };
}

// ── Claude Code ─────────────────────────────────────────────────────────────

/** jsonl entrypoint → 展示用客户端标识（仅用于显示，不改 agent/trace 路由）。
 *  与应用侧 data_source 拆分保持一致：claude-desktop* 全部归 Claude Desktop，
 *  cli / 未知归 Claude Code（见 tokenbank.default.yaml 的 data_source_map）。 */
function clientFromEntrypoint(ep) {
  if (!ep) return null;
  if (String(ep).startsWith('claude-desktop')) return 'claude-desktop';
  if (ep === 'cli') return 'claude-code';
  return null;
}

function listClaudeActivity({ limit = 50, sinceDays = 30, entrypointMatch } = {}) {
  const root = path.join(os.homedir(), '.claude/projects');
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
              const msg = data.message || {};
              context = extractContext(msgText(msg));
            }
            if (data.type === 'assistant') {
              if (data.entrypoint) epCounts[data.entrypoint] = (epCounts[data.entrypoint] || 0) + 1;
              calls++;
              const u = (data.message || {}).usage || {};
              inTok  += u.input_tokens  || 0;
              outTok += u.output_tokens || 0;
            }
          }
        } catch {}

        const entrypoint = Object.entries(epCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        if (entrypointMatch && !entrypointMatch(entrypoint)) continue;

        const { project, project_path } = resolveProjectName({
          projectPath: projectPath || dir,
          sessionFile: full,
          agentId: 'claude-code',
          cwdHint,
        });

        out.push({
          session_id: sid,
          project,
          project_path,
          context: context || '(无用户消息)',
          calls, tokens: inTok + outTok, inTok, outTok, lastTs,
          agent: 'claude-code',
          entrypoint,
          client: clientFromEntrypoint(entrypoint),
        });
      }
    }
  }

  scanDir(root, null);
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

/** 把一组 Claude / Claude-Code 风格 jsonl 行解析为 trace steps（CLI 与 3p agent 沙箱共用）。 */
/** 从 Skill tool_use 的 input 解析技能名（superpowers:brainstorming 等） */
function skillNameFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  return input.skill || input.command || input.name || null;
}

function buildClaudeStyleSteps(rawLines, timeSpan) {
  const steps = [];
  const toolNameById = {};   // tool_use_id → 工具名（用于给 tool_result 步骤命名）
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
        // user 行可同时承载真实输入(text)与工具回执(tool_result)，需逐块拆分
        for (const b of content) {
          if (b?.type === 'tool_result') {
            const tool = toolNameById[b.tool_use_id] || null;
            steps.push({ idx: steps.length, kind: 'tool_result',
              label: tool ? `${tool} 输出` : 'Tool output', ts,
              tool, tool_use_id: b.tool_use_id, is_error: !!b.is_error,
              text: toolResultText(b.content).slice(0, 4000) });
          } else if (b?.type === 'text' && String(b.text || '').trim()) {
            steps.push({ idx: steps.length, kind: 'user', label: 'User prompt', ts,
              text: extractContext(b.text), ...(usage || {}) });
          } else if (typeof b === 'string' && b.trim()) {
            steps.push({ idx: steps.length, kind: 'user', label: 'User prompt', ts,
              text: extractContext(b), ...(usage || {}) });
          }
          // image / 其它块视为附件，忽略
        }
      } else {
        const text = extractContext(msgText(msg));
        if (text) steps.push({ idx: steps.length, kind: 'user', label: 'User prompt', ts,
          text, ...(usage || {}) });
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
            steps.push({ idx: steps.length, kind: 'tool',
              label: skill ? `Skill · ${skill}` : (b.name || 'tool'), ts,
              tool: b.name, ...(skill ? { skill } : {}), input: b.input });
          } else if (b?.type === 'thinking' || b?.type === 'reasoning') {
            const think = String(b.text || b.thinking || '').trim();
            // 扩展思考被 API 加密：本地仅存 signature，无明文（参考 tokentelemetry）
            const encrypted = !think && !!b.signature;
            steps.push({ idx: steps.length, kind: 'assistant', label: 'Reasoning', ts,
              reasoning: true, text: think.slice(0, 500),
              ...(encrypted ? { encrypted: true, signature: String(b.signature).slice(0, 80) } : {}) });
          } else if (b?.type === 'text') {
            steps.push({ idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
              text: String(b.text || '').slice(0, 500) });
          }
        }
      } else {
        steps.push({ idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
          text: msgText(msg).slice(0, 500) });
      }
      // usage 属于整条 assistant 消息，附加到本轮首个步骤一次（避免按块重复计或漏计工具轮）
      if (usage && steps.length > before) Object.assign(steps[before], usage);
    }
    lineIdx++;
  }
  return steps;
}

function getClaudeTrace(sessionId) {
  const root = path.join(os.homedir(), '.claude/projects');
  let file = null;
  const find = (dir) => {
    if (file) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) find(full);
      else if (ent.name === `${sessionId}.jsonl`) file = full;
    }
  };
  find(root);
  if (!file) return { error: 'not_found', steps: [], stats: {} };

  const rawLines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const timeSpan = fileTimeSpan(file, rawLines.length);
  const steps = buildClaudeStyleSteps(rawLines, timeSpan);
  const entrypoint = dominantEntrypoint(rawLines);

  const { project, project_path } = resolveProjectName({
    projectPath: path.dirname(file),
    sessionFile: file,
    agentId: 'claude-code',
  });

  return {
    session_id: sessionId,
    agent: 'claude-code',
    entrypoint,
    client: clientFromEntrypoint(entrypoint),
    project,
    project_path,
    cwd: project_path,
    steps,
    stats: buildTraceStats(steps, { filePath: file, rawLines }),
  };
}

/** 从原始行统计出现最多的 entrypoint（cli / claude-desktop / claude-desktop-3p） */
function dominantEntrypoint(rawLines) {
  const counts = {};
  for (const line of rawLines || []) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d && d.entrypoint) counts[d.entrypoint] = (counts[d.entrypoint] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// ── Codex ───────────────────────────────────────────────────────────────────
// Codex jsonl 结构：顶层 type=event_msg/response_item，真实子类型在 payload.type（参考 tokentelemetry）

/** 从 rollout 文件名解析 session id（rollout-YYYY-...-uuid.jsonl → 末 5 段 UUID） */
function codexSessionIdFromFilename(name) {
  const stem = String(name).replace(/\.jsonl$/i, '');
  if (!stem.startsWith('rollout-')) return stem;
  const parts = stem.split('-');
  if (parts.length >= 6) return parts.slice(-5).join('-');
  return stem;
}

/** 读取 ~/.codex/session_index.jsonl → { id: thread_name }（旧版索引，可作上下文回退） */
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

/** 是否为 Codex 注入的环境上下文（非真实用户输入） */
function codexIsEnvironmentContext(text) {
  if (!text || typeof text !== 'string') return false;
  return /<environment_context>/i.test(text);
}

/** 提取 Codex user 消息文本（跳过 environment_context） */
function codexUserText(data) {
  if (data.type === 'event_msg' && data.payload?.type === 'user_message') {
    const m = data.payload.message;
    if (typeof m === 'string' && !codexIsEnvironmentContext(m)) {
      return extractContext(m);
    }
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

/** 提取 Codex assistant 消息文本 */
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
    if (p.type === 'reasoning') {
      return String(p.summary || p.content || '').slice(0, 500);
    }
  }
  return '';
}

/** 累加 Codex token_count 用量（OpenAI 语义：input 含 cached，total = input + output） */
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

/** 扫描单个 Codex rollout 文件 */
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
        // 真实用户输入在 event_msg.user_message（参考 tokentelemetry）
        if (pt === 'user_message' && !context) {
          const t = codexUserText(data);
          if (t) context = t;
        }
        if (pt === 'token_count') {
          const usage = data.payload?.info?.total_token_usage;
          acc = codexAccumulateUsage(acc, usage);
        }
      }
    }
  } catch {}

  if (!context && threadNames[sid]) {
    context = extractContext(threadNames[sid]);
  }

  const tokens = acc.inTok + acc.cached + acc.outTok;
  return {
    sid, context, cwdHint,
    calls: acc.calls, inTok: acc.inTok, outTok: acc.outTok,
    cached: acc.cached, tokens, lastTs, filePath,
  };
}

/** 同 session 多 rollout 文件合并（取较新文件路径、较大 token 峰值） */
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

function listCodexActivity({ limit = 50, sinceDays = 30 } = {}) {
  const root = path.join(os.homedir(), '.codex/sessions');
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
      agentId: 'codex',
      cwdHint: p.cwdHint,
    });
    return {
      session_id: p.sid,
      project,
      project_path,
      context: p.context || '(无用户消息)',
      calls: p.calls,
      tokens: p.tokens,
      inTok: p.inTok,
      outTok: p.outTok,
      lastTs: p.lastTs,
      agent: 'codex',
    };
  });

  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

function getCodexTrace(sessionId) {
  const root = path.join(os.homedir(), '.codex/sessions');
  let file = null;
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
          file = full;
        }
      }
    }
  };
  walk(root);
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
        steps.push({
          idx: steps.length, kind: 'tool', label: p.name || 'tool', ts,
          tool: p.name, input: p.arguments,
        });
      } else if (p.type === 'function_call_output' || p.type === 'tool_result') {
        const out = toolResultText(p.output ?? p.content);
        steps.push({
          idx: steps.length, kind: 'tool_result', label: 'Tool output', ts,
          is_error: /(\b|")error/i.test(out.slice(0, 80)), text: out.slice(0, 4000),
        });
      } else if (p.type === 'message' && p.role === 'user') {
        const t = codexUserText(data);
        if (t) {
          steps.push({ idx: steps.length, kind: 'user', label: 'User prompt', ts, text: t });
        }
      } else if (p.type === 'message' && p.role === 'assistant') {
        const t = codexAssistantText(data);
        if (t) {
          steps.push({ idx: steps.length, kind: 'assistant', label: 'Assistant', ts, text: t });
        }
      } else if (p.type === 'reasoning') {
        steps.push({
          idx: steps.length, kind: 'assistant', label: 'Reasoning', ts,
          reasoning: true, text: codexAssistantText(data),
        });
      }
    }
    lineIdx++;
  }

  const cwdHint = readSessionCwd(file, 'codex');
  const { project, project_path } = resolveProjectName({
    projectPath: path.dirname(file),
    sessionFile: file,
    agentId: 'codex',
    cwdHint,
  });

  return {
    session_id: sessionId,
    agent: 'codex',
    project,
    project_path,
    cwd: project_path,
    steps,
    stats: buildTraceStats(steps, { filePath: file, rawLines }),
  };
}

// ── Claude 3p（Cowork agent 沙箱）────────────────────────────────────────────
// Token Bank 接管 Desktop(3p) 后的 Cowork agent 会话，隔离在 Claude-3p 内部沙箱：
//   <root>/<account>/<group>/local_<uuid>.json   ← 索引（title / cliSessionId / lastActivityAt）
//   <root>/<account>/<group>/local_<uuid>/.claude/projects/<enc>/<cliSessionId>.jsonl  ← transcript
// transcript 是标准 Claude jsonl，解析复用 buildClaudeStyleSteps。

// 原生 Desktop + 3p 接管后两个 Cowork 根（B：让 Token Bank 统一查看两边 Cowork 会话）。
function coworkSessionRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') return [
    path.join(home, 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions'),   // 原生 Desktop
    path.join(home, 'AppData', 'Local', 'Claude-3p', 'local-agent-mode-sessions'),  // 3p 接管后
  ];
  if (process.platform === 'darwin') return [
    path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
    path.join(home, 'Library', 'Application Support', 'Claude-3p', 'local-agent-mode-sessions'),
  ];
  return [
    path.join(home, '.config', 'Claude', 'local-agent-mode-sessions'),
    path.join(home, '.config', 'Claude-3p', 'local-agent-mode-sessions'),
  ];
}

/** 扫原生 + 3p 沙箱索引（local_*.json），列出 Cowork agent 会话。 */
function list3pAgentActivity({ limit = 50, sinceDays = 30 } = {}) {
  const since = Date.now() / 1000 - (sinceDays || 30) * 86400;
  const out = [];
  const seen = new Set();
  for (const root of coworkSessionRoots()) {
    let accounts;
    try { accounts = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const acc of accounts) {
      if (!acc.isDirectory()) continue;
      let groups;
      try { groups = fs.readdirSync(path.join(root, acc.name), { withFileTypes: true }); } catch { continue; }
      for (const grp of groups) {
        if (!grp.isDirectory()) continue;
        const grpDir = path.join(root, acc.name, grp.name);
        let files;
        try { files = fs.readdirSync(grpDir); } catch { continue; }
        for (const f of files) {
          if (!/^local_[\w-]+\.json$/.test(f)) continue; // 只取索引文件，跳过同名目录
          let idx;
          try { idx = JSON.parse(fs.readFileSync(path.join(grpDir, f), 'utf8')); } catch { continue; }
          const sid = idx.cliSessionId || idx.sessionId; // 用 cliSessionId 才能定位 transcript
          if (!sid || seen.has(sid)) continue;
          seen.add(sid);
          const lastTs = Math.floor((idx.lastActivityAt || idx.createdAt || 0) / 1000);
          if (lastTs && lastTs < since) continue;
          out.push({
            session_id: sid,
            project: idx.title || '(无标题)',
            project_path: null,                       // 沙箱临时 cwd 无展示意义
            context: extractContext(String(idx.initialMessage || idx.title || '')) || '(无用户消息)',
            calls: 0, tokens: 0, inTok: 0, outTok: 0,
            lastTs: lastTs || 0,
            agent: 'claude-3p',
          });
        }
      }
    }
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

/** 在原生 + 3p 沙箱里按 cliSessionId 定位 transcript jsonl（有界递归）。 */
function find3pTranscript(sessionId) {
  let found = null;
  const walk = (dir, depth) => {
    if (found || depth > 7) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (found) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.name === `${sessionId}.jsonl`) found = full;
    }
  };
  for (const root of coworkSessionRoots()) { walk(root, 0); if (found) break; }
  return found;
}

function get3pAgentTrace(sessionId) {
  const file = find3pTranscript(sessionId);
  if (!file) return { error: 'not_found', steps: [], stats: {} };
  const rawLines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const timeSpan = fileTimeSpan(file, rawLines.length);
  const steps = buildClaudeStyleSteps(rawLines, timeSpan);
  return {
    session_id: sessionId,
    agent: 'claude-3p',
    project: null,
    project_path: null,
    cwd: null,
    steps,
    stats: buildTraceStats(steps, { filePath: file, rawLines }),
  };
}

// ── 统一入口 ────────────────────────────────────────────────────────────────

const HANDLERS = {
  cursor:       { list: listCursorActivity, trace: getCursorTrace },
  'claude-code': { list: listClaudeActivity, trace: getClaudeTrace },
  codex:        { list: listCodexActivity,   trace: getCodexTrace },
  'claude-3p':  { list: list3pAgentActivity, trace: get3pAgentTrace },
};

function listActivity(agentId, opts = {}) {
  const h = HANDLERS[agentId];
  if (!h) return [];
  return h.list(opts);
}

/** 跨所有 agent 聚合会话原始行（含 agent_id，按 lastTs 倒序）。不读叠加层。 */
function listAllSessions(opts = {}) {
  const { mergeAgentRows } = require('./session-manager');
  const resultsByAgent = {};
  for (const agentId of Object.keys(HANDLERS)) {
    try { resultsByAgent[agentId] = HANDLERS[agentId].list(opts) || []; }
    catch { resultsByAgent[agentId] = []; }
  }
  return mergeAgentRows(resultsByAgent);
}

function getTrace(agentId, sessionId) {
  const h = HANDLERS[agentId];
  if (!h) return { error: 'unsupported_agent', steps: [] };
  const trace = h.trace(sessionId);
  if (trace.error || !sessionId) return trace;
  // 统一修正项目名 / 路径（避免 Trace 页显示 agent-transcripts 等内部目录名）
  const sessionFile = findSessionJsonl(agentId, sessionId);
  const { project, project_path } = resolveProjectName({
    projectPath: trace.project_path || trace.project,
    sessionFile,
    agentId,
    cwdHint: trace.cwd,
  });
  return { ...trace, project, project_path, cwd: project_path };
}

/** 合并 DB 统计与会话文件扫描结果 */
function mergeActivityWithStats(activity, dbSessions = []) {
  const byId = Object.fromEntries((dbSessions || []).map(s => [s.session_id, s]));
  return activity.map(a => {
    const db = byId[a.session_id];
    if (!db) return a;
    const dbCost = Number(db.cost_usd) || 0;
    return {
      ...a,
      calls:  db.calls  || a.calls,
      tokens: db.tokens || a.tokens,
      lastTs: db.lastTs || a.lastTs,
      // DB 有费用则用 DB；否则保留行上已有估算
      cost_usd: dbCost > 0 ? dbCost : (Number(a.cost_usd) || 0),
    };
  });
}

/** 从单条 assistant/user 记录提取可读标签（用于最近明细） */
function assistantLineLabel(data) {
  if (!data || typeof data !== 'object') return 'assistant';
  const role = data.role || data.type;
  if (role === 'user' || data.type === 'user') {
    const t = extractContext(msgText(data.message));
    return t ? t.slice(0, 60) : 'User prompt';
  }
  const msg = data.message || {};
  const content = msg.content;
  if (Array.isArray(content)) {
    const tools = content
      .filter(x => x?.type === 'tool_use' || x?.type === 'tool-call')
      .map(x => x.name)
      .filter(Boolean);
    if (tools.length) {
      const uniq = [...new Set(tools)];
      return uniq.slice(0, 4).join(' · ') + (uniq.length > 4 ? ' …' : '');
    }
    const text = content.find(x => x?.type === 'text')?.text;
    if (text) {
      const t = extractContext(sanitizeCursorText(String(text)));
      if (t) return t.slice(0, 60);
    }
  }
  const plain = msgText(msg);
  if (plain) return extractContext(plain).slice(0, 60) || 'assistant';
  return 'assistant';
}

/** 定位会话 jsonl 文件路径 */
function findSessionJsonl(agentId, sessionId) {
  if (agentId === 'cursor') {
    const root = path.join(os.homedir(), '.cursor/projects');
    let found = null;
    const walk = (dir) => {
      if (found) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name === `${sessionId}.jsonl`) found = full;
      }
    };
    walk(root);
    return found;
  }
  if (agentId === 'claude-code') {
    const root = path.join(os.homedir(), '.claude/projects');
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
  if (agentId === 'codex') {
    const root = path.join(os.homedir(), '.codex/sessions');
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
  if (agentId === 'claude-3p') {
    return find3pTranscript(sessionId);
  }
  return null;
}

/** 补全最近明细：从 jsonl 解析工具名/上下文（Cursor 等无 model 字段时） */
function enrichRecentDetail(agentId, recent, activity = []) {
  const actBySid = Object.fromEntries((activity || []).map(a => [a.session_id, a]));
  const lineCache = {};  // sessionId → string[]

  return (recent || []).map(r => {
    let label = r.label || r.model;
    let context = r.context;
    let row = { ...r };

    // request_id 末段常为 jsonl 行号（如 cursor:{sid}:{index}）
    const rid = String(r.request_id || '');
    const lineIdx = /:(\d+)$/.test(rid) ? +rid.replace(/^.*:/, '') : null;

    if (lineIdx != null && r.session_id) {
      if (!lineCache[r.session_id]) {
        const f = findSessionJsonl(agentId, r.session_id);
        if (f) {
          let st;
          try { st = fs.statSync(f); } catch { st = null; }
          const lines = fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
          lineCache[r.session_id] = { lines, st };
        } else {
          lineCache[r.session_id] = { lines: [], st: null };
        }
      }
      const { lines, st } = lineCache[r.session_id];
      const line = lines[lineIdx];
      if (line) {
        try { label = assistantLineLabel(JSON.parse(line)); } catch {}
      }
      // 无独立 timestamp 时，按行号在文件时间线上分摊（避免全部同一时刻）
      if (st && lines.length > 0) {
        const span = Math.max(st.mtimeMs - st.birthtimeMs, lines.length * 500);
        row = { ...row, ts: Math.floor((st.birthtimeMs + (lineIdx / lines.length) * span) / 1000) };
      }
    }

    const act = actBySid[r.session_id];
    if (!context && act?.context) context = act.context;

    if (!label) {
      label = context ? context.slice(0, 60) : (act?.project ? `${act.project}` : null);
    }

    return { ...row, label: label || 'assistant', context: context || act?.context };
  });
}

module.exports = {
  listActivity, getTrace, mergeActivityWithStats, enrichTraceWithDb,
  enrichRecentDetail, assistantLineLabel, extractContext, sanitizeCursorText, shortProjectName, normalizeActivityRow,
  listAllSessions, buildClaudeStyleSteps, buildTraceStats, toolResultText, findSessionJsonl,
};
