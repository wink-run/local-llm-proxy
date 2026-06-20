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

module.exports = {
  mergeAgentRows, joinSessionsWithMeta, buildSessionPackJSON, renderSessionPackMarkdown,
};
