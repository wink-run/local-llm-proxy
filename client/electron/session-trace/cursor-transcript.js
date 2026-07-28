// session-trace/cursor-transcript.js — Cursor agent-transcripts trace 适配器
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  extractContext, clipTraceText, msgText, sanitizeCursorText, projectLabel,
  pathFromEncodedSlug, nameFromGithubprojectsSlug, pickUsage,
  buildTraceStats, fileTimeSpan, stepTs,
  readBoundedLines, traceCacheKey, createTraceCache, MAX_JSONL_FILE_BYTES,
} = require('./shared');
const { iterFileLines } = require('../jsonl-lines');
const { extractSkillsFromCursorTool, extractSkillsFromCursorRecord } = require('../skill-signals');

const AGENT_ID = 'cursor';
const PROFILE = 'cursor-transcript';
const ROOT = () => path.join(os.homedir(), '.cursor/projects');
const traceCache = createTraceCache();

function projectFromCursorSlug(slug) {
  const gh = nameFromGithubprojectsSlug(slug);
  if (gh) return gh;
  const decoded = pathFromEncodedSlug(slug);
  if (decoded) return projectLabel(decoded);
  const parts = String(slug || '').split('-');
  if (parts.length >= 2) return parts[parts.length - 1];
  return slug || 'unknown';
}

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
  if (!project || project === slug || project === project_path
      || project.includes('/') || /^Users-/i.test(project)) {
    project = projectFromCursorSlug(slug);
  }
  if (project_path && !project_path.startsWith('/') && !/^[A-Za-z]:\\/.test(project_path)) {
    const decoded = pathFromEncodedSlug(project_path) || pathFromEncodedSlug(slug);
    if (decoded) project_path = decoded;
  }
  return { project, project_path };
}

function buildCursorProjectMap() {
  const map = {};
  const root = ROOT();
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

function cursorProjectSlugFromFile(jsonlPath) {
  const normalized = String(jsonlPath).replace(/\\/g, '/');
  const marker = '/agent-transcripts/';
  const i = normalized.indexOf(marker);
  if (i > 0) return path.basename(normalized.slice(0, i));
  return path.basename(path.dirname(path.dirname(path.dirname(jsonlPath))));
}

function findSessionFile(sessionId) {
  const root = ROOT();
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

function list({ limit = 50, sinceDays = 30 } = {}) {
  const root = ROOT();
  const projMap = buildCursorProjectMap();
  const since = Date.now() / 1000 - (sinceDays || 30) * 86400;
  const candidates = [];
  let projectDirs;
  try { projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return []; }

  for (const pd of projectDirs) {
    const { project: projectName, project_path: projectPath } = resolveCursorProject(pd.name, projMap);
    const transRoot = path.join(root, pd.name, 'agent-transcripts');
    let sessDirs;
    try { sessDirs = fs.readdirSync(transRoot, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }

    for (const sd of sessDirs) {
      const sid = sd.name;
      const cf = path.join(transRoot, sid, `${sid}.jsonl`);
      let st;
      try { st = fs.statSync(cf); } catch { continue; }
      const lastTs = Math.floor(st.mtimeMs / 1000);
      if (lastTs < since) continue;
      candidates.push({ sid, cf, lastTs, projectName, projectPath });
    }
  }

  candidates.sort((a, b) => b.lastTs - a.lastTs);
  const parseBudget = Math.max(limit * 3, limit);
  const out = [];
  for (const c of candidates.slice(0, parseBudget)) {
    let cSize = 0;
    try { cSize = fs.statSync(c.cf).size; } catch {}
    if (cSize > MAX_JSONL_FILE_BYTES) {
      out.push({
        session_id: c.sid, project: c.projectName, project_path: c.projectPath,
        context: '(会话过大，跳过预览)',
        calls: 0, tokens: 0, inTok: 0, outTok: 0, lastTs: c.lastTs, agent: AGENT_ID,
      });
      if (out.length >= limit) break;
      continue;
    }
    let context = '', calls = 0, inTok = 0, outTok = 0;
    try {
      for (const line of iterFileLines(c.cf)) {
        const s = line.trim();
        if (!s) continue;
        let data;
        try { data = JSON.parse(s); } catch { continue; }
        const role = data.role;
        const msg = data.message || {};
        if (role === 'user' && !context) context = extractContext(msgText(msg));
        else if (role === 'assistant') {
          calls++;
          const u = msg.usage || {};
          inTok += u.input_tokens || 0;
          outTok += u.output_tokens || 0;
        }
      }
    } catch {}

    out.push({
      session_id: c.sid, project: c.projectName, project_path: c.projectPath,
      context: context || '(无用户消息)',
      calls, tokens: inTok + outTok, inTok, outTok, lastTs: c.lastTs,
      agent: AGENT_ID,
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

function trace(sessionId) {
  const files = [];
  try {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name === `${sessionId}.jsonl`) files.push(full);
      }
    };
    walk(ROOT());
  } catch {}

  if (!files.length) return { error: 'not_found', steps: [], meta: {} };

  const cf = files[0];
  let st;
  try { st = fs.statSync(cf); } catch { return { error: 'not_found', steps: [], stats: {} }; }
  const cacheKey = traceCacheKey(cf, st);
  const cachedTrace = traceCache.get(cacheKey);
  if (cachedTrace) return cachedTrace;

  const slug = cursorProjectSlugFromFile(cf);
  const { project: projectName, project_path: projectPath } = resolveCursorProject(slug, buildCursorProjectMap());
  const { lines, lineCount, truncated, rawErrorCount } = readBoundedLines(cf);
  const timeSpan = fileTimeSpan(cf, lineCount);
  const steps = [];
  let lineIdx = 0;
  let agentTurns = 0;

  try {
    for (const line of lines) {
      let data;
      try { data = JSON.parse(line); } catch { lineIdx++; continue; }
      if (data.type === 'turn_ended') { lineIdx++; continue; }

      const role = data.role;
      const msg = data.message || {};
      const ts = stepTs(timeSpan, lineIdx);
      const usage = pickUsage(data) || pickUsage(msg);

      if (role === 'user') {
        const userText = extractContext(msgText(msg), { forTrace: true }) || msgText(msg);
        steps.push({
          idx: steps.length, kind: 'user', label: 'User prompt', ts,
          text: clipTraceText(userText),
          ...(usage || {}),
        });
        // /slash 手动附加 Skill：正文内联，无 Read/Skill 工具，仍计入生态用量
        const attached = extractSkillsFromCursorRecord(data);
        for (const sk of attached) {
          steps.push({
            idx: steps.length, kind: 'tool',
            label: `Skill · ${sk.raw}`, ts,
            tool: 'attach_skill', skill: sk.raw, signal: sk.signal,
          });
        }
      } else if (role === 'assistant') {
        agentTurns++;
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            const t = item?.type;
            if (t === 'tool_use' || t === 'tool-call') {
              const toolInput = item.input || item.arguments;
              const skillHits = extractSkillsFromCursorTool(item.name, toolInput);
              // 保留原工具名，挂上 skill（与 Codex 路径面包屑一致）
              if (skillHits.length) {
                for (const sk of skillHits) {
                  steps.push({
                    idx: steps.length, kind: 'tool',
                    label: `Skill · ${sk.raw}`, ts,
                    tool: item.name, skill: sk.raw, signal: sk.signal,
                    input: toolInput,
                  });
                }
              } else {
                steps.push({
                  idx: steps.length, kind: 'tool', label: item.name || 'tool', ts,
                  tool: item.name, input: toolInput,
                });
              }
            } else if (t === 'thinking' || t === 'reasoning') {
              const think = sanitizeCursorText(String(item.text || item.thinking || ''));
              if (think) {
                steps.push({
                  idx: steps.length, kind: 'assistant', label: 'Reasoning', ts,
                  reasoning: true, text: clipTraceText(think),
                });
              }
            } else if (t === 'text' && item.text) {
              const text = sanitizeCursorText(String(item.text));
              if (text) {
                steps.push({
                  idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
                  text: clipTraceText(text), ...(usage || {}),
                });
              }
            }
          }
        } else {
          const text = sanitizeCursorText(msgText(msg));
          if (text) {
            steps.push({
              idx: steps.length, kind: 'assistant', label: 'Assistant', ts,
              text: clipTraceText(text), ...(usage || {}),
            });
          }
        }
      }
      lineIdx++;
    }
  } catch (e) {
    return { error: e.message, steps: [], stats: {} };
  }

  const stats = buildTraceStats(steps, { filePath: cf, rawErrorCount });
  if (agentTurns > 0) stats.turns = agentTurns;
  if (truncated) stats.truncated = true;

  return traceCache.set(cacheKey, {
    session_id: sessionId,
    agent: AGENT_ID,
    project: projectName,
    project_path: projectPath,
    cwd: projectPath,
    session_file: cf,
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
};
