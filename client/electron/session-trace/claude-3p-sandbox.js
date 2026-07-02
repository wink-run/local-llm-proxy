// session-trace/claude-3p-sandbox.js — Claude Desktop Cowork 3p 沙箱 trace 适配器
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractContext, buildTraceStats, fileTimeSpan, pickUsage, msgText } = require('./shared');
const { buildClaudeStyleSteps } = require('./claude-jsonl');

const AGENT_ID = 'claude-3p';
const PROFILE = 'claude-3p-sandbox';

function coworkSessionRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') return [
    path.join(home, 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions'),
    path.join(home, 'AppData', 'Local', 'Claude-3p', 'local-agent-mode-sessions'),
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

function findSessionFile(sessionId) {
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

/** 从 session jsonl 汇总 token（list 用；索引 JSON 不含 usage） */
function scanSessionJsonlUsage(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return { calls: 0, inTok: 0, outTok: 0, tokens: 0 };
  let calls = 0;
  let inTok = 0;
  let outTok = 0;
  let userChars = 0; // user 行字符数，用于 jsonl 无 input_tokens 时粗估
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let data;
      try { data = JSON.parse(s); } catch { continue; }
      if (data.type === 'user') {
        userChars += extractContext(msgText(data.message || {})).length;
      }
      if (data.type !== 'assistant') continue;
      calls++;
      const u = pickUsage(data);
      if (u) {
        inTok += u.inTok;
        outTok += u.outTok;
      }
    }
    // Cowork jsonl 常只记 output；有输出无输入时按 user 文本粗估（约 4 字符/token）
    if (outTok > 0 && !inTok && userChars > 0) inTok = Math.ceil(userChars / 4);
  } catch { /* 单文件损坏不影响列表 */ }
  return { calls, inTok, outTok, tokens: inTok + outTok };
}

function list({ limit = 50, sinceDays = 30 } = {}) {
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
          if (!/^local_[\w-]+\.json$/.test(f)) continue;
          let idx;
          try { idx = JSON.parse(fs.readFileSync(path.join(grpDir, f), 'utf8')); } catch { continue; }
          const sid = idx.cliSessionId || idx.sessionId;
          if (!sid || seen.has(sid)) continue;
          seen.add(sid);
          const lastTs = Math.floor((idx.lastActivityAt || idx.createdAt || 0) / 1000);
          if (lastTs && lastTs < since) continue;
          const usage = scanSessionJsonlUsage(sid);
          out.push({
            session_id: sid,
            project: idx.title || '(无标题)',
            project_path: null,
            context: extractContext(String(idx.initialMessage || idx.title || '')) || '(无用户消息)',
            calls: usage.calls,
            tokens: usage.tokens,
            inTok: usage.inTok,
            outTok: usage.outTok,
            lastTs: lastTs || 0,
            agent: AGENT_ID,
            client: 'claude-desktop',
            trace_agent_id: AGENT_ID,
          });
        }
      }
    }
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
  return {
    session_id: sessionId,
    agent: AGENT_ID,
    client: 'claude-desktop',
    project: null,
    project_path: null,
    cwd: null,
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
};
