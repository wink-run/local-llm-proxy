// client/electron/session-manager.js
// 跨 agent 会话聚合 + 叠加层合并 + 会话包导出（纯逻辑可单测；IO 在 orchestration 段）。
'use strict';

const { isSignal, looksLikeNoise } = require('./learn-mine');

/** 将 {agentId: rows[]} 展平为单数组，打上 agent_id，按 (agent_id, session_id) 去重
 *  （同一会话可能被多次列出，如跨工作区/重复解析；去重保留 lastTs 最新一条），按 lastTs 倒序。
 *  去重很关键：会话元数据（收藏/标签/归档）按 agent_id::session_id 存，重复行会让收藏“串味”到同 id 的另一行。 */
function mergeAgentRows(resultsByAgent = {}) {
  const byKey = new Map();
  for (const [agentId, rows] of Object.entries(resultsByAgent)) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const row = { ...r, agent_id: r.agent_id || r.agent || agentId };
      const key = `${row.agent_id}::${row.session_id}`;
      const prev = byKey.get(key);
      if (!prev || (row.lastTs || 0) > (prev.lastTs || 0)) byKey.set(key, row);
    }
  }
  const out = [...byKey.values()];
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

const ROLE_BY_KIND = { user: 'user', tool: 'tool', tool_result: 'tool' };

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
      } else if (s.kind === 'tool_result') {
        msg.tool = s.tool || null;
        msg.output = true;
        if (s.is_error) msg.is_error = true;
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
const { execFileSync } = require('child_process');
const { estimateCost } = require('./pricing');
const { resolvePricingProviderId } = require('./billing-config');

/** agent → 刊例价 provider（jsonl 有 token 但 DB 未落账时的费用兜底） */
const AGENT_PRICING_ID = {
  'claude-code': 'anthropic',
  'claude-3p': 'anthropic',
  cursor: 'cursor',
  codex: 'openai',
};

/** DB 无费用时，用 jsonl 扫到的 inTok/outTok 按 agent 刊例价估算 */
function enrichSessionCosts(rows = []) {
  return rows.map(r => {
    const existing = Number(r.cost_usd) || 0;
    if (existing > 0) return r;
    const inTok = r.inTok || 0;
    const outTok = r.outTok || 0;
    if (!inTok && !outTok) return r;
    const agent = r.agent_id || r.agent;
    const cost = estimateCost(
      null, inTok, outTok, 0, 0,
      resolvePricingProviderId(AGENT_PRICING_ID[agent]),
    );
    return cost > 0 ? { ...r, cost_usd: cost } : r;
  });
}

/** 聚合会话 + 叠加层 + 过滤。返回供 UI 渲染的会话数组。 */
function getSessions(deps, opts = {}) {
  const { sessionBrowser, localStats } = deps;
  const raw = sessionBrowser.listAllSessions(opts);
  // 合并本地网关记录的用量/费用（经代理的请求才有 cost_usd）
  const dbMap = typeof localStats.querySessionStatsMap === 'function'
    ? localStats.querySessionStatsMap()
    : {};
  const dbSessions = Object.entries(dbMap).map(([session_id, s]) => ({ session_id, ...s }));
  const rows = sessionBrowser.mergeActivityWithStats(raw, dbSessions);
  const meta = localStats.listSessionMeta();
  return enrichSessionCosts(joinSessionsWithMeta(rows, meta, { showArchived: !!opts.showArchived }));
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

/** 把一段 trace 压成可喂给模型的纯文本摘要素材（纯函数，可单测）。
 *  同时保留「原始目标」（最早的 user 消息）与「最近进展」，避免只看结尾丢失用户意图。 */
function buildSessionDigest(trace = {}, { maxSteps = 28, maxChars = 7000, headUserMsgs = 2 } = {}) {
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const files = new Set();
  for (const s of steps) {
    if (s.kind === 'tool') { const f = filePathFromInput(s.input); if (f) files.add(f); }
  }

  // 原始目标：最早的若干条 user 消息（用户真正想达成什么通常在这里）
  const head = steps.filter(s => s.kind === 'user')
    .slice(0, headUserMsgs)
    .map(s => `USER(原始请求): ${_trunc(s.text, 900)}`);

  // 最近进展：末尾若干步
  const recent = steps.slice(-maxSteps);
  const lines = [];
  for (const s of recent) {
    if (s.kind === 'user') {
      lines.push(`USER: ${_trunc(s.text, 500)}`);
    } else if (s.kind === 'tool') {
      const f = filePathFromInput(s.input);
      lines.push(`TOOL ${s.tool || s.label || ''}${f ? ` (${f})` : ''}`.trim());
    } else if (s.kind === 'tool_result') {
      if (s.text) lines.push(`OUT${s.is_error ? '(err)' : ''}: ${_trunc(s.text, 200)}`);
    } else if (s.text) {
      lines.push(`AI: ${_trunc(s.text, 500)}`);
    }
  }
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(-maxChars);

  const header =
    `项目: ${trace.project || '?'}\n` +
    `路径: ${trace.project_path || trace.cwd || '?'}\n` +
    `关键文件: ${[...files].slice(0, 25).join(', ') || '—'}\n`;
  return `${header}\n[原始目标]\n${head.join('\n') || '（无）'}\n\n[最近进展]\n${body}`;
}

/** 组装最终交接文档（brief 已是模型产出或确定性兜底）。 */
function composeHandoffDoc({ brief, project, sourceAgent } = {}) {
  return [
    `# 交接工作 — ${project || 'session'}`,
    `> 来源：${sourceAgent || '?'} 会话`,
    '',
    brief || '',
    '',
    '---',
    `以上是之前在 ${sourceAgent || '另一个 agent'} 上的工作交接。请在当前项目继续：先简述你的理解，再接着推进未完成的部分。`,
  ].join('\n');
}

const HANDOFF_MODELS = ['deepseek-v4-flash', 'glm-4.7', 'claude-haiku-4-5'];

/** 调本地网关跑一次 system+user 补全；逐个模型 failover，全失败返回 null。 */
async function _callModel(system, userText, {
  base = 'http://127.0.0.1:11430', models = HANDOFF_MODELS, fetchImpl = globalThis.fetch, maxTokens = 1600,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  for (const model of models) {
    try {
      const resp = await fetchImpl(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
        }),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return { text: text.trim(), model };
    } catch { /* 试下一个模型 */ }
  }
  return null;
}

const HANDOFF_SYSTEM = [
  '你是“会话交接”助手。下面是某 AI 编码会话的记录（含原始目标与最近进展）。',
  '请生成一份结构清晰、可直接交给另一个 AI 接手的中文交接文档，必须包含以下 markdown 小节；',
  '信息不足时基于上下文合理推断，并在该处标注「(推断)」：',
  '## 用户目标 — 用户最终想达成什么（从原始请求提炼，不要只复述最近的动作）',
  '## 验收标准 — 怎样算完成、用户期望的效果或行为（显式或推断）',
  '## 完成状态 — 已完成 vs 未完成，并给出大致完成度（如 70%）',
  '## 已完成的工作 — 关键改动、结论、已验证的事项',
  '## 下一步待办 — 接手者应立即着手的具体事项（有序列表）',
  '## 关键文件 — 涉及的文件及其作用',
  '## 关键决策与注意事项 — 重要约定、约束、坑、用户偏好',
  '只输出交接文档本身，不要寒暄或额外解释。',
].join('\n');

/** 调用本地网关把 digest 总结成交接 brief；成功返回 {brief, model}，全失败返回 null。 */
async function summarizeViaGateway(digest, opts = {}) {
  const r = await _callModel(HANDOFF_SYSTEM, digest, { maxTokens: 1600, ...opts });
  return r ? { brief: r.text, model: r.model } : null;
}

/** 采集项目仓库的 git 上下文（未提交改动 + 最近提交）作为交接素材。
 *  纯只读；任何失败（非 git 仓库 / git 不可用 / cwd 不存在）都静默返回 ''，
 *  绝不抛出——交接流程不能因 git 失败而中断。 */
function collectGitContext(cwd, { execImpl = execFileSync, maxStatusLines = 40, logN = 10 } = {}) {
  if (!cwd) return '';
  // 只去尾部空白：status --short 的首列空格（如 " M" 表示未暂存改动）有语义，不能 trim 行首。
  const run = (args) => {
    try {
      return String(execImpl('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).replace(/\s+$/, '');
    } catch { return ''; }
  };
  const log = run(['log', `-${logN}`, '--pretty=format:%h %s']);
  const status = run(['status', '--short']);
  // 两条都为空（多半是非 git 仓库）→ 不提供 git 段。
  if (!log && !status) return '';

  const statusLines = status ? status.split('\n').slice(0, maxStatusLines).join('\n') : '';
  return [
    '[Git 状态]',
    '未提交改动:',
    statusLines || '（无未提交改动）',
    '最近提交:',
    log || '（无提交记录）',
  ].join('\n');
}

/** 生成交接：取 trace → digest(+git) → 模型 brief（失败兜底）→ 写文件 → 返回供 UI。 */
async function continueSession(deps, { source_agent, session_id, target_agent } = {}) {
  const { sessionBrowser } = deps;
  if (!source_agent || !session_id) return { error: 'missing_params' };
  const trace = sessionBrowser.getTrace(source_agent, session_id);
  if (!trace || trace.error) return { error: 'trace_unavailable' };

  const digest = buildSessionDigest(trace);
  const gitCtx = collectGitContext(trace.project_path || trace.cwd || null);
  const enrichedDigest = gitCtx ? `${digest}\n\n${gitCtx}` : digest;
  const summary = await summarizeViaGateway(enrichedDigest);
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

// ── 知识提炼（LLM 合成）─────────────────────────────────────────────────────
// 不按频次抽“偏好”，而是让本地模型从跨会话语料里提炼可【长期作上下文】的知识：
// 开发规则 / 人格定义 / 最佳实践 / 避坑指南 / 概念与黑话；并标注项目级 vs 全局级。

const KNOWLEDGE_MODELS = ['deepseek-v4-flash', 'glm-4.7', 'kimi-k2.6', 'claude-haiku-4-5'];

const KNOWLEDGE_SYSTEM = [
  '你是“项目知识提炼”助手。下面是来自多个项目的真实会话片段（每行前缀 [项目名]，多为用户的指示/纠正/讨论）。',
  '请提炼可【长期作为 AI 编码助手上下文】的知识，只保留这几类，其它一律忽略：',
  '1) 开发规则（约定、流程、工具链、命令）',
  '2) 人格/角色定义（希望 AI 以什么角色、什么风格工作）',
  '3) 最佳实践',
  '4) 避坑指南（踩过的坑、易错点、注意事项）',
  '5) 概念与黑话（项目特有术语、缩写、领域概念的含义）',
  '忽略：一次性任务指令、bug 复现、具体数值/路径/文件名、寒暄。出现几次不重要，重要的是它是否属于上面五类。',
  '为每条判断作用域：全局级（任何项目都适用，如通用编码习惯、沟通风格、人格）/ 项目级（某项目特有）。',
  '用简洁的祈使句或定义句改写每条，不要照抄原文；同义合并去重。',
  '输出 markdown，严格用以下结构，没有内容的小节直接省略：',
  '# 全局级',
  '## 开发规则 / ## 人格定义 / ## 最佳实践 / ## 避坑指南 / ## 概念与黑话',
  '# 项目级',
  '## <项目名>（其下同样分小类）',
  '只输出文档本身，不要解释或寒暄。',
].join('\n');

/** 扫聚合会话 → 构建“知识语料”：清洗后的用户指示行，按项目标注，强信号优先，限长。 */
function buildKnowledgeCorpus(deps, { limit = 300, maxChars = 9000 } = {}) {
  const { sessionBrowser } = deps;
  const rows = sessionBrowser.listAllSessions() || [];
  const byProject = new Map(); // project -> { strong:[], weak:[] }
  const projectPaths = {};     // project -> 本机路径（供「保存到该项目 AGENTS.md」定位默认目录）
  const seen = new Set();
  let scanned = 0;
  for (const r of rows.slice(0, limit)) {
    let tr; try { tr = sessionBrowser.getTrace(r.agent_id, r.session_id); } catch { continue; }
    scanned += 1;
    if (!tr || !Array.isArray(tr.steps)) continue;
    const project = tr.project || r.project || 'unknown';
    const ppath = tr.project_path || tr.cwd || r.project_path || null;
    if (ppath && !projectPaths[project]) projectPaths[project] = ppath;
    let g = byProject.get(project); if (!g) { g = { strong: [], weak: [] }; byProject.set(project, g); }
    for (const s of tr.steps) {
      if (!s || s.kind !== 'user') continue;
      const t = (s.text || '').replace(/\s+/g, ' ').trim();
      if (t.length < 3 || t.length > 400) continue;
      if (looksLikeNoise(t)) continue;
      const strong = isSignal(t);            // 祈使型规则
      if (!strong && t.length < 6) continue; // 非祈使的短句多为寒暄/碎语，丢弃
      const dk = project + '|' + t.toLowerCase().slice(0, 80);
      if (seen.has(dk)) continue;
      seen.add(dk);
      (strong ? g.strong : g.weak).push(t);
    }
  }
  const lines = [];
  let used = 0;
  const projects = [...byProject.keys()];
  const push = (project, t) => {
    const line = `[${project}] ${t}`;
    if (used + line.length + 1 > maxChars) return false;
    lines.push(line); used += line.length + 1; return true;
  };
  outer: for (const pass of ['strong', 'weak']) {
    for (const project of projects) {
      for (const t of byProject.get(project)[pass]) if (!push(project, t)) break outer;
    }
  }
  return { corpus: lines.join('\n'), projects, projectPaths, scanned, sessions: rows.length, lineCount: lines.length };
}

/** 兜底：模型不可用时，把原始候选行包成基础 markdown，至少让用户看到素材。 */
function _fallbackMd(corpus) {
  const date = new Date().toISOString().slice(0, 10);
  return [
    `<!-- ${date} 本地模型不可用，以下为未经提炼的原始候选；请确认网关已运行并配置了可用模型后重试。 -->`,
    '', '# 原始候选（未提炼）', '',
    ...corpus.split('\n').filter(Boolean).map(l => `- ${l}`),
    '',
  ].join('\n');
}

/** 构建语料 → 让本地模型合成知识文档（AGENTS.md 内容）。 */
async function synthesizeKnowledge(deps, opts = {}) {
  const { corpus, projects, projectPaths, scanned, sessions, lineCount } = buildKnowledgeCorpus(deps, opts);
  if (!corpus.trim()) return { ok: false, error: 'no_corpus', content: '', scanned, sessions };
  const r = await _callModel(KNOWLEDGE_SYSTEM, corpus, { models: KNOWLEDGE_MODELS, maxTokens: 2400, ...opts });
  if (!r) return { ok: false, error: 'model_unavailable', content: _fallbackMd(corpus), projects, projectPaths, scanned, sessions, lineCount };
  const date = new Date().toISOString().slice(0, 10);
  const header = `<!-- 由 Token Bank 记忆提炼生成于 ${date}（模型 ${r.model}，扫描 ${scanned} 会话）。可自由编辑。 -->\n\n`;
  return { ok: true, content: header + r.text, model: r.model, projects, projectPaths, scanned, sessions, lineCount };
}

module.exports = {
  mergeAgentRows, joinSessionsWithMeta, buildSessionPackJSON, renderSessionPackMarkdown,
  getSessions, exportSession,
  buildSessionDigest, filePathFromInput, composeHandoffDoc, summarizeViaGateway,
  collectGitContext, continueSession, buildKnowledgeCorpus, synthesizeKnowledge,
};
