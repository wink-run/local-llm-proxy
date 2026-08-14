// session-trace/registry.js — trace profile 注册表（由 handler.session.trace.profile 路由）
'use strict';

const claudeJsonl = require('./claude-jsonl');
const codexRollout = require('./codex-rollout');
const cursorTranscript = require('./cursor-transcript');
const claude3pSandbox = require('./claude-3p-sandbox');
const workbuddyTrace = require('./workbuddy-trace');
const traeWorkTrace = require('./trae-work-trace');
const kimiCodeTrace = require('./kimi-code-trace');
const dshTrace = require('./dsh-trace');

/** profile id → 适配器模块 */
const PROFILE_ADAPTERS = {
  [claudeJsonl.profile]: claudeJsonl,
  [codexRollout.profile]: codexRollout,
  [cursorTranscript.profile]: cursorTranscript,
  [claude3pSandbox.profile]: claude3pSandbox,
  [workbuddyTrace.profile]: workbuddyTrace,
  [traeWorkTrace.profile]: traeWorkTrace,
  [kimiCodeTrace.profile]: kimiCodeTrace,
  [dshTrace.profile]: dshTrace,
};

/** 兼容旧 trace_agent_id 调用 */
const AGENT_ID_TO_PROFILE = {
  [claudeJsonl.agentId]: claudeJsonl.profile,
  [codexRollout.agentId]: codexRollout.profile,
  [cursorTranscript.agentId]: cursorTranscript.profile,
  [claude3pSandbox.agentId]: claude3pSandbox.profile,
  [workbuddyTrace.agentId]: workbuddyTrace.profile,
  [traeWorkTrace.agentId]: traeWorkTrace.profile,
  [kimiCodeTrace.agentId]: kimiCodeTrace.profile,
  [dshTrace.agentId]: dshTrace.profile,
};

/** Cowork 3p 会话在 UI 上归属 Claude Desktop（trace 仍走 claude-3p 适配器） */
const AGENT_DISPLAY_PARENT = {
  [claude3pSandbox.agentId]: 'claude-desktop',
};

const TRACE_AGENT_FALLBACKS = {
  'claude-code': [claude3pSandbox.agentId],
  'claude-desktop': [claude3pSandbox.agentId],
};

function adapterByProfile(profile) {
  return profile ? PROFILE_ADAPTERS[profile] || null : null;
}

function adapterByAgentId(agentId) {
  const profile = AGENT_ID_TO_PROFILE[agentId];
  return profile ? PROFILE_ADAPTERS[profile] : null;
}

function attachSessionOwnership(row, adapterAgentId) {
  const parent = AGENT_DISPLAY_PARENT[adapterAgentId];
  if (!parent) return row;
  return {
    ...row,
    agent_id: parent,
    trace_agent_id: row.trace_agent_id || adapterAgentId,
    client: row.client || 'claude-desktop',
  };
}

function listForAdapter(adapter, opts = {}) {
  if (!adapter?.list) return [];
  return adapter.list(opts);
}

function traceForAdapter(adapter, sessionId) {
  if (!adapter?.trace) return { error: 'unsupported_agent', steps: [] };
  return adapter.trace(sessionId);
}

function getTraceWithFallback(agentId, sessionId, primaryAdapter = null) {
  const tried = new Set();
  const candidates = [];
  const push = (a) => {
    if (!a || tried.has(a)) return;
    tried.add(a);
    candidates.push(a);
  };
  if (primaryAdapter) push(primaryAdapter);
  else push(adapterByAgentId(agentId));
  for (const fb of TRACE_AGENT_FALLBACKS[agentId] || []) push(adapterByAgentId(fb));
  if (agentId === claude3pSandbox.agentId) push(claude3pSandbox);

  for (const adapter of candidates) {
    const raw = traceForAdapter(adapter, sessionId);
    if (!raw.error) return { raw, adapter };
  }
  return { raw: { error: 'not_found', steps: [] }, adapter: null };
}

/** 实体展开结果 → trace 适配器 */
function resolveTraceAdapter(entity) {
  if (!entity) return null;
  if (entity.trace_profile) return adapterByProfile(entity.trace_profile);
  const agentId = entity.trace_agent_id || entity.activity_agent_id || entity.id;
  return adapterByAgentId(agentId);
}

/** Claude entrypoint 过滤（由实体 trace_entrypoint_data_source 驱动） */
function entrypointMatchForEntity(entity) {
  const ds = entity?.trace_entrypoint_data_source;
  if (!ds) return null;
  const { claudeDataSourceForEntrypoint } = require('../session-import');
  return (ep) => claudeDataSourceForEntrypoint(ep) === ds;
}

function listActivityForEntity(entity, opts = {}) {
  const adapter = resolveTraceAdapter(entity);
  const out = [];
  const seen = new Set();
  const pushRows = (rows, adapterAgentId) => {
    for (const row of rows || []) {
      const owned = attachSessionOwnership(
        { ...row, agent: row.agent || adapterAgentId },
        adapterAgentId,
      );
      if (seen.has(owned.session_id)) continue;
      seen.add(owned.session_id);
      out.push(owned);
    }
  };

  if (adapter) {
    const entrypointMatch = opts.entrypointMatch ?? entrypointMatchForEntity(entity) ?? undefined;
    const agentId = entity.trace_agent_id || entity.activity_agent_id || entity.id;
    pushRows(listForAdapter(adapter, { ...opts, entrypointMatch }), agentId);
  }
  // Claude Desktop：合并 Cowork 3p 沙箱 chat 会话
  if (entity?.id === 'claude-desktop') {
    pushRows(listForAdapter(claude3pSandbox, opts), claude3pSandbox.agentId);
  }
  return out;
}

function getTraceForEntity(entity, sessionId) {
  const primary = resolveTraceAdapter(entity);
  const agentId = entity?.trace_agent_id || entity?.activity_agent_id || entity?.id;
  return getTraceWithFallback(agentId, sessionId, primary).raw;
}

function listActivity(agentId, opts = {}) {
  return listForAdapter(adapterByAgentId(agentId), opts);
}

function getTrace(agentId, sessionId) {
  return getTraceWithFallback(agentId, sessionId, null).raw;
}

function findSessionFile(agentId, sessionId) {
  const order = [agentId, ...(TRACE_AGENT_FALLBACKS[agentId] || [])];
  for (const aid of order) {
    const adapter = adapterByAgentId(aid);
    if (adapter?.findSessionFile) {
      const f = adapter.findSessionFile(sessionId);
      if (f) return f;
    }
  }
  return null;
}

/** 跨所有已注册适配器聚合（会话管理页） */
function listAllFromAdapters(opts = {}) {
  const { mergeAgentRows } = require('../session-manager');
  const resultsByAgent = {};
  const seen = new Set();
  for (const adapter of Object.values(PROFILE_ADAPTERS)) {
    if (!adapter?.agentId || seen.has(adapter.agentId)) continue;
    seen.add(adapter.agentId);
    try {
      const rows = (adapter.list(opts) || []).map(r => attachSessionOwnership(r, adapter.agentId));
      resultsByAgent[adapter.agentId] = rows;
    } catch {
      resultsByAgent[adapter.agentId] = [];
    }
  }
  return mergeAgentRows(resultsByAgent);
}

module.exports = {
  PROFILE_ADAPTERS,
  AGENT_ID_TO_PROFILE,
  AGENT_DISPLAY_PARENT,
  adapterByProfile,
  adapterByAgentId,
  attachSessionOwnership,
  resolveTraceAdapter,
  entrypointMatchForEntity,
  listActivityForEntity,
  getTraceForEntity,
  listActivity,
  getTrace,
  getTraceWithFallback,
  findSessionFile,
  listAllFromAdapters,
  traceForAdapter,
};
