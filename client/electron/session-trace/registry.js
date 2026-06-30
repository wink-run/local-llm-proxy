// session-trace/registry.js — trace profile 注册表（由 handler.session.trace.profile 路由）
'use strict';

const claudeJsonl = require('./claude-jsonl');
const codexRollout = require('./codex-rollout');
const cursorTranscript = require('./cursor-transcript');
const claude3pSandbox = require('./claude-3p-sandbox');
const workbuddyTrace = require('./workbuddy-trace');

/** profile id → 适配器模块 */
const PROFILE_ADAPTERS = {
  [claudeJsonl.profile]: claudeJsonl,
  [codexRollout.profile]: codexRollout,
  [cursorTranscript.profile]: cursorTranscript,
  [claude3pSandbox.profile]: claude3pSandbox,
  [workbuddyTrace.profile]: workbuddyTrace,
};

/** 兼容旧 trace_agent_id 调用 */
const AGENT_ID_TO_PROFILE = {
  [claudeJsonl.agentId]: claudeJsonl.profile,
  [codexRollout.agentId]: codexRollout.profile,
  [cursorTranscript.agentId]: cursorTranscript.profile,
  [claude3pSandbox.agentId]: claude3pSandbox.profile,
  [workbuddyTrace.agentId]: workbuddyTrace.profile,
};

function adapterByProfile(profile) {
  return profile ? PROFILE_ADAPTERS[profile] || null : null;
}

function adapterByAgentId(agentId) {
  const profile = AGENT_ID_TO_PROFILE[agentId];
  return profile ? PROFILE_ADAPTERS[profile] : null;
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

function listForAdapter(adapter, opts = {}) {
  if (!adapter?.list) return [];
  return adapter.list(opts);
}

function traceForAdapter(adapter, sessionId) {
  if (!adapter?.trace) return { error: 'unsupported_agent', steps: [] };
  return adapter.trace(sessionId);
}

function listActivityForEntity(entity, opts = {}) {
  const adapter = resolveTraceAdapter(entity);
  if (!adapter) return [];
  const entrypointMatch = opts.entrypointMatch ?? entrypointMatchForEntity(entity) ?? undefined;
  const agentId = entity.trace_agent_id || entity.activity_agent_id || entity.id;
  return listForAdapter(adapter, { ...opts, entrypointMatch })
    .map(row => ({ ...row, agent: row.agent || adapter.agentId || agentId }));
}

function getTraceForEntity(entity, sessionId) {
  return traceForAdapter(resolveTraceAdapter(entity), sessionId);
}

function listActivity(agentId, opts = {}) {
  return listForAdapter(adapterByAgentId(agentId), opts);
}

function getTrace(agentId, sessionId) {
  return traceForAdapter(adapterByAgentId(agentId), sessionId);
}

function findSessionFile(agentId, sessionId) {
  const adapter = adapterByAgentId(agentId);
  return adapter?.findSessionFile ? adapter.findSessionFile(sessionId) : null;
}

/** 跨所有已注册适配器聚合（会话管理页） */
function listAllFromAdapters(opts = {}) {
  const { mergeAgentRows } = require('../session-manager');
  const resultsByAgent = {};
  const seen = new Set();
  for (const adapter of Object.values(PROFILE_ADAPTERS)) {
    if (!adapter?.agentId || seen.has(adapter.agentId)) continue;
    seen.add(adapter.agentId);
    try { resultsByAgent[adapter.agentId] = adapter.list(opts) || []; }
    catch { resultsByAgent[adapter.agentId] = []; }
  }
  return mergeAgentRows(resultsByAgent);
}

module.exports = {
  PROFILE_ADAPTERS,
  AGENT_ID_TO_PROFILE,
  adapterByProfile,
  adapterByAgentId,
  resolveTraceAdapter,
  entrypointMatchForEntity,
  listActivityForEntity,
  getTraceForEntity,
  listActivity,
  getTrace,
  findSessionFile,
  listAllFromAdapters,
  traceForAdapter,
};
