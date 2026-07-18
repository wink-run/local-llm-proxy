// client/electron/skill-demand-miner.js
// 从「已纳管智能体」的 session_trace 抽取用户与 Agent 的对话素材,
// 供发现智能体推测「用户是谁、在追求什么目标」,再推荐资源。
'use strict';

const fs = require('fs');
const path = require('path');

/** 最多翻多少个会话文件(取最近的)。 */
const DEFAULT_MAX_SESSIONS = 80;
/** 写入 digest 的对话条数上限(控制分析 prompt 体积)。 */
const DEFAULT_MAX_DIALOGUES = 40;
/** 单条用户话语截断长度。 */
const USER_MSG_MAX = 280;
/** 每个会话除「首条目标」外再附带的后续用户话条数。 */
const EXTRA_MSGS_PER_SESSION = 2;

/** agent/harness 注入的系统前言(以 user 角色混入,非用户本人)。 */
const BOILERPLATE_PREFIXES = [
  /^Caveat:/i,
  /^If the available MCP tools/i,
  /^Briefly inform the user/i,
  /^You are /i,
  /^<system-reminder>/i,
  /^The user (opened|sent|has)/i,
  /^Here (is|are) the/i,
  /DO NOT respond to these messages/i,
  /Implement the plan as specified/i,
  /it is attached for your reference/i,
  /^\[Image\]/i,
  /^<image>/i,
];

/**
 * Token Bank 自身生成的「发现/分析」提示词特征。
 * 这些会以 user 角色落入 Claude Code 等会话,若再采进画像会污染决策。
 */
const META_PROMPT_MARKERS = [
  /以下是我与纳管智能体近\s*\d+\s*个会话/,
  /对话只是证据[:：].*认出/,
  /核心原则[（(]必守[）)]/,
  /画像看稳定身份/,
  /辅助透镜[（(]提升挖掘质量/,
  /只输出唯一一个\s*```json/,
  /我的稳定主身份[:：]/,
  /我大概是[:：].*下一步值得投入的方向/,
  /请用 skillhub install/,
  /用 find-skill\s*\/\s*`skillhub search/,
  /category 只能取以下英文 slug/,
  /此步先不要推荐具体资源/,
  /Past ≠ future|过去不代表未来/,
  /personalized-recommend/i,
  /## 推断要求|## 请输出|## 输出格式/,
  /稳定主身份一句话|可延伸的相邻人设/,
];

/** 寒暄 / 无目标短句。 */
const GREETING_RE = /^(谢谢|thanks|thank you|ok|好的|可以|继续|go on|嗯|哦|收到|明白了?|继续吧)[.!。！…]*$/i;

/** 粘贴日志特征。 */
const PASTED_LOG_RE = [
  /\.js\?v=/,
  /Warning: Encountered/i,
  /\n\s*at\s+\S+\s+\(/,
  /\b(TypeError|ReferenceError|Uncaught|Traceback)\b/,
];

function bump(map, key, n = 1) { if (key) map[key] = (map[key] || 0) + n; }

function clip(text, max = USER_MSG_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 是否为 TB 画像/发现流程注入的提示词(非真人用户说的话)。 */
function isMetaPromptUtterance(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  let hits = 0;
  for (const p of META_PROMPT_MARKERS) {
    if (p.test(t)) {
      hits += 1;
      if (hits >= 1 && t.length > 120) return true; // 长提示命中一条即排除
      if (hits >= 2) return true;
    }
  }
  return false;
}

/** 是否为可作画像素材的用户话语(目标/意图),过滤注入与噪声。 */
function isUsefulUserUtterance(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 4 || t.length > 2000) return false;
  if (GREETING_RE.test(t)) return false;
  if (isMetaPromptUtterance(text)) return false;
  for (const p of BOILERPLATE_PREFIXES) if (p.test(t)) return false;
  for (const p of PASTED_LOG_RE) if (p.test(t)) return false;
  // 大段英文系统前言:无中文且含 you/tool/user
  if (t.length > 160 && !/[一-龥]/.test(t) && /\b(you|the|tool|user|task|assistant)\b/i.test(t)
    && /^(please |make sure |important:|note:)/i.test(t)) {
    return false;
  }
  return true;
}

/** 与托盘/网关一致：shim 默认纳管；其余须 hosted===true。 */
function isManagedApp(app) {
  if (!app || app.draft) return false;
  if (app.hosted === false) return false;
  if (app.link_method === 'shim') return app.hosted !== false;
  return app.hosted === true;
}

/** 读取本机已纳管应用列表(Electron userData → CLI local-config)。 */
function loadManagedApps(appsOverride) {
  if (Array.isArray(appsOverride)) return appsOverride.filter(isManagedApp);
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const p = path.join(app.getPath('userData'), 'local-config.json');
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (cfg.apps || []).filter(isManagedApp);
    }
  } catch { /* 非 Electron 或文件缺失 */ }
  try {
    const { readLocalConfig } = require('../shared/config-loader');
    return ((readLocalConfig() || {}).apps || []).filter(isManagedApp);
  } catch {
    return [];
  }
}

/**
 * 解析具备 session_trace 的已纳管实体。
 * @returns {object[]} 展开后的 app entity
 */
function resolveTraceEntities(options = {}) {
  const configLoader = options.configLoader || require('./config-loader');
  const appsExplicit = Array.isArray(options.apps);
  const idsExplicit = Array.isArray(options.managedAgentIds);
  const managedApps = loadManagedApps(appsExplicit ? options.apps : undefined);
  const agentIds = new Set();

  if (idsExplicit) {
    for (const id of options.managedAgentIds) {
      if (id) agentIds.add(String(id));
    }
  } else if (managedApps.length) {
    for (const app of managedApps) {
      const aid = app.agent_id || app.preset_id || app.activity_agent_id || app.trace_agent_id;
      if (!aid) continue;
      const caps = configLoader.appCapabilities(aid) || {};
      const ent = configLoader.appEntityById(aid);
      const hasTrace = !!(caps.session_trace ?? ent?.session_trace ?? app.session_trace);
      if (hasTrace) agentIds.add(String(aid));
    }
  } else if (!appsExplicit) {
    let list = [];
    try { list = configLoader.appEntitiesExpanded?.() || []; } catch { list = []; }
    if (!list.length) {
      try { list = configLoader.appEntities?.() || []; } catch { list = []; }
    }
    for (const e of list) {
      if (!e?.id) continue;
      const caps = e.capabilities || configLoader.appCapabilities(e.id) || {};
      if (caps.session_trace || e.session_trace) agentIds.add(String(e.id));
    }
  }

  const entities = [];
  const seen = new Set();
  for (const id of agentIds) {
    if (seen.has(id)) continue;
    const ent = configLoader.appEntityById(id);
    if (!ent) continue;
    seen.add(id);
    entities.push(ent);
  }
  return entities;
}

/**
 * 从单条 trace 抽出对话素材:首条用户话=会话目标,后续若干条=补充意图。
 * @returns {{goal:string, notes:string[], project:string}|null}
 */
function extractDialogueFromTrace(trace, row) {
  if (!trace || trace.error || !Array.isArray(trace.steps)) return null;
  const project = (trace.project || row?.project || '').trim();
  const userTexts = [];
  for (const step of trace.steps) {
    if (!step || step.kind !== 'user') continue;
    // 先对原文判 meta/噪声,再截断入库(避免长提示词被 clip 后漏检)
    if (!isUsefulUserUtterance(step.text)) continue;
    const t = clip(step.text);
    if (!t) continue;
    // 会话内去重
    if (userTexts.some((u) => u === t || (u.length > 20 && t.startsWith(u.slice(0, 20))))) continue;
    userTexts.push(t);
    if (userTexts.length > 1 + EXTRA_MSGS_PER_SESSION) break;
  }
  // activity.context 兜底(列表扫描时已抽过首条用户话)
  if (!userTexts.length) {
    const rawCtx = row?.context || '';
    if (isUsefulUserUtterance(rawCtx)) {
      const ctx = clip(rawCtx);
      if (ctx) userTexts.push(ctx);
    }
  }
  if (!userTexts.length) return null;
  return {
    goal: userTexts[0],
    notes: userTexts.slice(1),
    project: project && project !== 'unknown' ? project : '',
  };
}

/**
 * 扫描已纳管智能体的 session_trace,采集对话素材(+轻量项目分布)。
 * @returns {{dialogues:object[], projects:Object, sessions:number, agents:string[]}}
 */
function collectWorkSignals(options = {}) {
  const sinceDays = options.sinceDays ?? 30;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxDialogues = options.maxDialogues ?? DEFAULT_MAX_DIALOGUES;
  const sessionBrowser = options.sessionBrowser || require('./session-browser');
  const entities = options.entities || resolveTraceEntities(options);

  const projects = {};
  const dialogues = [];
  const agentIds = [];

  const rows = [];
  const seenSid = new Set();
  for (const ent of entities) {
    agentIds.push(ent.id);
    let activity = [];
    try {
      activity = sessionBrowser.listActivityForEntity(ent, {
        sinceDays,
        limit: maxSessions,
      }) || [];
    } catch { continue; }
    for (const row of activity) {
      if (!row?.session_id || seenSid.has(row.session_id)) continue;
      seenSid.add(row.session_id);
      rows.push({ ...row, _entity: ent, _agent: ent.id });
    }
  }

  rows.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const capped = rows.slice(0, maxSessions);

  let sessions = 0;
  for (const row of capped) {
    let trace;
    try {
      trace = sessionBrowser.getTraceForEntity(row._entity, row.session_id);
    } catch { continue; }
    if (!trace || trace.error) continue;
    sessions += 1;

    const dlg = extractDialogueFromTrace(trace, row);
    if (dlg) {
      if (dlg.project) bump(projects, dlg.project);
      if (dialogues.length < maxDialogues) {
        dialogues.push({
          agent: row._agent || row._entity?.id || '',
          project: dlg.project,
          goal: dlg.goal,
          notes: dlg.notes,
        });
      }
    } else {
      const project = (trace.project || row.project || '').trim();
      if (project && project !== 'unknown') bump(projects, project);
    }
  }

  return { dialogues, projects, sessions, agents: agentIds };
}

function topEntries(map, n) {
  return Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

/**
 * 对话素材 → 画像摘要(供发现智能体推测 persona / 目标 / 资源需求)。
 * 核心是 dialogues(用户原话),不含分类结论。
 */
function buildDigest(signals, opts = {}) {
  return {
    sessions: signals.sessions || 0,
    dialogues: Array.isArray(signals.dialogues) ? signals.dialogues : [],
    projects: topEntries(signals.projects, opts.topProjects ?? 8),
    agents: Array.isArray(signals.agents) ? signals.agents : [],
  };
}

module.exports = {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_DIALOGUES,
  collectWorkSignals,
  buildDigest,
  resolveTraceEntities,
  isManagedApp,
  isUsefulUserUtterance,
  isMetaPromptUtterance,
  extractDialogueFromTrace,
  // 测试辅助
  _clip: clip,
};
