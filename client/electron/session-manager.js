// client/electron/session-manager.js
// 跨 agent 会话聚合 + 叠加层合并 + 会话包导出（纯逻辑可单测；IO 在 orchestration 段）。
'use strict';

/** 将 {agentId: rows[]} 展平为单数组，打上 agent_id，按 lastTs 倒序。 */
function mergeAgentRows(resultsByAgent = {}) {
  const out = [];
  for (const [agentId, rows] of Object.entries(resultsByAgent)) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      out.push({ ...r, agent_id: r.agent_id || r.agent || agentId });
    }
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out;
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean);
  if (typeof tags === 'string' && tags.trim()) {
    return tags.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/** 用叠加层元数据 left-join 会话行；默认过滤 archived。 */
function joinSessionsWithMeta(rows = [], metaRows = [], { showArchived = false } = {}) {
  const byKey = new Map();
  for (const m of metaRows || []) byKey.set(`${m.agent_id}::${m.session_id}`, m);
  const out = [];
  for (const r of rows) {
    const m = byKey.get(`${r.agent_id}::${r.session_id}`) || {};
    const archived = !!m.archived;
    if (archived && !showArchived) continue;
    out.push({
      ...r,
      favorite: !!m.favorite,
      tags: parseTags(m.tags),
      note: m.note || '',
      archived,
    });
  }
  return out;
}

const ROLE_BY_KIND = { user: 'user', tool: 'tool' };

/** trace.steps → 可移植会话包（JSON）。 */
function buildSessionPackJSON({ trace = {}, agent_id, session_id } = {}) {
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  return {
    version: 1,
    kind: 'tokenbank.session-pack',
    exported_at: new Date().toISOString(),
    source: {
      agent_id: agent_id || null,
      session_id: session_id || null,
      project: trace.project || null,
      project_path: trace.project_path || trace.cwd || null,
    },
    stats: trace.stats || {},
    messages: steps.map(s => {
      const role = ROLE_BY_KIND[s.kind] || 'assistant';
      const msg = { role, ts: s.ts ?? null, text: s.text || '' };
      if (s.kind === 'tool') {
        msg.tool = s.tool || s.label || null;
        if (s.input != null) msg.input = s.input;
      }
      return msg;
    }),
  };
}

function roleHeading(role) {
  if (role === 'user') return '## USER';
  if (role === 'tool') return '## TOOL';
  return '## AI';
}

/** 会话包 → 人可读 Markdown transcript。 */
function renderSessionPackMarkdown(pack = {}) {
  const src = pack.source || {};
  const lines = [`# ${src.project || src.session_id || 'session'}`, ''];
  if (src.agent_id) lines.push(`> agent: \`${src.agent_id}\``, '');
  for (const m of pack.messages || []) {
    lines.push(roleHeading(m.role));
    if (m.role === 'tool') {
      lines.push('', '```', `${m.tool || 'tool'}`,
        typeof m.input === 'string' ? m.input : JSON.stringify(m.input ?? '', null, 2), '```', '');
    } else {
      lines.push('', m.text || '', '');
    }
  }
  return lines.join('\n');
}

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 聚合会话 + 叠加层 + 过滤。返回供 UI 渲染的会话数组。 */
function getSessions(deps, opts = {}) {
  const { sessionBrowser, localStats } = deps;
  const rows = sessionBrowser.listAllSessions(opts);
  const meta = localStats.listSessionMeta();
  return joinSessionsWithMeta(rows, meta, { showArchived: !!opts.showArchived });
}

/** 导出单会话为 JSON 包或 Markdown，写入默认目录，返回落盘信息。 */
function exportSession(deps, { agent_id, session_id, format = 'json' } = {}) {
  const { sessionBrowser } = deps;
  if (!agent_id || !session_id) return { error: 'missing_params' };
  const trace = sessionBrowser.getTrace(agent_id, session_id);
  if (!trace || trace.error) return { error: 'trace_unavailable' };

  const pack = buildSessionPackJSON({ trace, agent_id, session_id });
  const dir = path.join(os.homedir(), '.tokenbank', 'session-packs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const base = `${(pack.source.project || 'session')}-${session_id.slice(0, 8)}`.replace(/[^\w.-]+/g, '_');
  if (format === 'copy') {
    // 仅返回 Markdown 内容供渲染进程复制到剪贴板，不落盘。
    return { ok: true, format, content: renderSessionPackMarkdown(pack) };
  }
  if (format === 'markdown') {
    const content = renderSessionPackMarkdown(pack);
    const file = path.join(dir, `${base}.md`);
    fs.writeFileSync(file, content, 'utf8');
    return { ok: true, file, format, content };
  }
  const content = JSON.stringify(pack, null, 2);
  const file = path.join(dir, `${base}.json`);
  fs.writeFileSync(file, content, 'utf8');
  return { ok: true, file, format, content };
}

// ── 跨智能体续聊（handoff）────────────────────────────────────────────────

function _trunc(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 从工具 input 里尽力提取文件路径。 */
function filePathFromInput(input) {
  if (!input) return null;
  if (typeof input === 'object') {
    return input.path || input.file || input.file_path || input.filename || null;
  }
  if (typeof input === 'string') {
    const m = input.match(/[\w./-]+\.\w{1,8}/);
    return m ? m[0] : null;
  }
  return null;
}

/** 把一段 trace 压成可喂给模型的纯文本摘要素材（纯函数，可单测）。 */
function buildSessionDigest(trace = {}, { maxSteps = 24, maxChars = 6000 } = {}) {
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const recent = steps.slice(-maxSteps);
  const files = new Set();
  const lines = [];
  for (const s of recent) {
    if (s.kind === 'user') {
      lines.push(`USER: ${_trunc(s.text, 500)}`);
    } else if (s.kind === 'tool') {
      const f = filePathFromInput(s.input);
      if (f) files.add(f);
      lines.push(`TOOL ${s.tool || s.label || ''}${f ? ` (${f})` : ''}`.trim());
    } else if (s.text) {
      lines.push(`AI: ${_trunc(s.text, 500)}`);
    }
  }
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(-maxChars);
  const header =
    `项目: ${trace.project || '?'}\n` +
    `路径: ${trace.project_path || trace.cwd || '?'}\n` +
    `关键文件: ${[...files].slice(0, 20).join(', ') || '—'}\n\n`;
  return header + body;
}

/** 组装最终交接文档（brief 已是模型产出或确定性兜底）。 */
function composeHandoffDoc({ brief, project, sourceAgent } = {}) {
  return [
    `# 接续工作 — ${project || 'session'}`,
    `> 来源：${sourceAgent || '?'} 会话`,
    '',
    brief || '',
    '',
    '---',
    `以上是之前在 ${sourceAgent || '另一个 agent'} 上的工作交接。请在当前项目继续：先简述你的理解，再接着推进未完成的部分。`,
  ].join('\n');
}

const HANDOFF_MODELS = ['deepseek-v4-flash', 'glm-4.7', 'claude-haiku-4-5'];

/** 调用本地网关把 digest 总结成交接 brief；任一模型成功即返回，全失败返回 null。 */
async function summarizeViaGateway(digest, {
  base = 'http://127.0.0.1:11430', models = HANDOFF_MODELS, fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const system = '你是“会话交接”助手。基于以下某 AI 编码会话的记录，生成一份简洁的中文交接 brief，包含四节：' +
    '【做了什么】【当前状态】【下一步】【关键文件】。只输出 brief 本身，不要寒暄。';
  for (const model of models) {
    try {
      const resp = await fetchImpl(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 900,
          messages: [{ role: 'system', content: system }, { role: 'user', content: digest }],
        }),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return { brief: text.trim(), model };
    } catch { /* 试下一个模型 */ }
  }
  return null;
}

/** 生成交接：取 trace → digest → 模型 brief（失败兜底）→ 写文件 → 返回供 UI。 */
async function continueSession(deps, { source_agent, session_id, target_agent } = {}) {
  const { sessionBrowser } = deps;
  if (!source_agent || !session_id) return { error: 'missing_params' };
  const trace = sessionBrowser.getTrace(source_agent, session_id);
  if (!trace || trace.error) return { error: 'trace_unavailable' };

  const digest = buildSessionDigest(trace);
  const summary = await summarizeViaGateway(digest);
  const aiGenerated = !!summary;
  const brief = summary ? summary.brief : digest;
  const doc = composeHandoffDoc({ brief, project: trace.project, sourceAgent: source_agent });

  const dir = path.join(os.homedir(), '.tokenbank', 'handoffs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const base = `${(trace.project || 'session')}-${session_id.slice(0, 8)}-${Date.now()}`.replace(/[^\w.-]+/g, '_');
  const handoffFile = path.join(dir, `${base}.md`);
  try { fs.writeFileSync(handoffFile, doc, 'utf8'); } catch {}

  return {
    ok: true,
    target_agent,
    source_agent,
    cwd: trace.project_path || trace.cwd || null,
    aiGenerated,
    model: summary?.model || null,
    brief: doc,
    handoffFile,
  };
}

module.exports = {
  mergeAgentRows, joinSessionsWithMeta, buildSessionPackJSON, renderSessionPackMarkdown,
  getSessions, exportSession,
  buildSessionDigest, filePathFromInput, composeHandoffDoc, summarizeViaGateway,
  continueSession,
};
