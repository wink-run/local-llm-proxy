// apps-compiler.js — app_entities + 内置 handler → 运行时段 tools / api_key_apps / session_sources
'use strict';

const { expandEntity, sessionScansById } = require('./app-handlers');

function sortKey(item) {
  const n = Number(item?.sort_order);
  return Number.isFinite(n) ? n : 0;
}

function compileTool(e) {
  const out = {
    id: e.id,
    name: e.name,
    protocol: e.protocol || 'openai',
    route_bindable: e.route_bindable !== false,
    strategy: e.strategy || 'base_url-env',
    handler: e.handler,
    capabilities: e.capabilities,
    activity_agent_id: e.activity_agent_id,
    trace_agent_id: e.trace_agent_id,
    linked_data_sources: e.linked_data_sources,
    pricing_provider_id: e.pricing_provider_id,
    handoff_target: e.handoff_target,
    integrations: e.integrations,
  };
  if (e.detect_command) {
    const detect = { command: e.detect_command };
    if (e.detect_version_arg) detect['version-arg'] = e.detect_version_arg;
    if (e.detect_config_dirs?.length) detect['config-dirs'] = e.detect_config_dirs;
    out.detect = detect;
  }
  const env = e.inject_env || {};
  if (Object.keys(env).length) out.inject = { env };
  return out;
}

function compileApiKeyApp(e) {
  const out = {
    id: e.id,
    name: e.name,
    icon: e.icon || '🔧',
    config_file: e.config_file || '',
    marker: e.marker || 'tokenbank',
    route_bindable: e.route_bindable !== false,
    allow_direct: !!e.allow_direct,
    handler: e.handler,
    capabilities: e.capabilities,
    activity_agent_id: e.activity_agent_id,
    trace_agent_id: e.trace_agent_id,
    linked_data_sources: e.linked_data_sources,
    pricing_provider_id: e.pricing_provider_id,
    handoff_target: e.handoff_target,
    integrations: e.integrations,
    route_multi_select: !!e.route_multi_select,
  };
  if (e.enable_3p) out.enable_3p = true;
  if (e.detect_type === 'command') out.command = e.detect_value || '';
  else out.appx = e.detect_value || '';
  // Codex 等：appx + command 双信号（Desktop 或 CLI 任一即可）
  if (e.detect_command) out.command = e.detect_command;
  if (e.patch && Object.keys(e.patch).length) out.patch = e.patch;
  if (e.env && Object.keys(e.env).length) out.env = e.env;
  return out;
}

function compileSessionSource(e) {
  const sid = e.session_source_id || e.id;
  // 补录规则已由 expandEntity 从 handler 解析；空对象视为未解析，回落 scans 表
  const rawScan = (e.session_scan && typeof e.session_scan === 'object') ? e.session_scan : null;
  const scan = (rawScan && Object.keys(rawScan).length)
    ? rawScan
    : (sessionScansById()[sid] || {});
  const overlay = {
    id: sid,
    agent_id: e.id,
    standalone: !!e.standalone,
    app_name: e.name,
    app_icon: e.icon,
    handler: e.handler,
    ...scan,
  };
  for (const key of ['data_source', 'provider_id', 'tier', 'billing_type']) {
    if (e[key]) overlay[key] = e[key];
  }
  if (e.models?.length) overlay.models = e.models;
  const caps = e.capabilities || {};
  if ('session_trace' in caps) overlay.session_trace = !!caps.session_trace;
  if ('session_usage_import' in caps) overlay.session_usage_import = !!caps.session_usage_import;
  if (!e.gateway_proxy) {
    overlay.direct_only = !e.route_bindable;
  } else if (e.standalone === false) {
    overlay.direct_only = false;
  }
  return overlay;
}

/** app_entities → 客户端运行时段 */
function compileAppsDoc(doc) {
  const { canonicalAppEntityId } = require('./app-handlers');
  const rawEntities = (doc.app_entities || doc.entities || []).filter(e => e?.id);
  // Codex Desktop/CLI 等别名：编译前按 canonical id 去重，优先 api_key handler
  const RANK = { 'codex-desktop-api': 3, api_key: 3, 'codex-cli': 1 };
  const byCanonical = new Map();
  for (const raw of [...rawEntities].sort((a, b) => sortKey(a) - sortKey(b))) {
    const cid = canonicalAppEntityId(raw.id);
    const score = RANK[String(raw.handler || '')] || 2;
    const prev = byCanonical.get(cid);
    if (!prev || score > (RANK[String(prev.handler || '')] || 2)) {
      // 统一展示名：Codex CLI/Desktop → Codex
      const next = { ...raw, id: cid };
      if (cid === 'codex') next.name = 'Codex';
      byCanonical.set(cid, next);
    }
  }
  const entities = [...byCanonical.values()];
  const tools = [];
  const api_key_apps = [];
  const session_sources = [];
  const expanded = [];

  for (const raw of entities) {
    let e;
    try {
      e = expandEntity(raw);
    } catch (err) {
      console.warn('[apps-compiler] skip entity', raw.id, err.message);
      continue;
    }
    expanded.push(e);
    if (e.gateway_proxy) {
      if (e.proxy_mode === 'cli') tools.push(compileTool(e));
      else if (e.proxy_mode === 'api_key') api_key_apps.push(compileApiKeyApp(e));
    }
    if (e.session_import && e.session_source_id) {
      session_sources.push(compileSessionSource(e));
    }
  }

  return {
    version: doc.version || 1,
    app_entities: entities,
    entities_expanded: expanded,
    tools,
    api_key_apps,
    session_sources,
  };
}

/** 从 tokenbank.yaml 解析运行时段；无 app_entities 时回退内置 default_entities（离线百宝箱） */
function resolveAppsRuntime(doc) {
  const entities = doc.app_entities || doc.entities;
  if (Array.isArray(entities) && entities.length) {
    return compileAppsDoc({ ...doc, entities });
  }
  const { loadDoc } = require('./app-handlers');
  const fallback = (loadDoc().default_entities || []).filter(e => e?.id && e?.handler);
  if (fallback.length) {
    return compileAppsDoc({ ...doc, entities: fallback, app_entities: fallback });
  }
  return {
    version: doc.version || 1,
    app_entities: [],
    entities_expanded: [],
    tools: [],
    api_key_apps: [],
    session_sources: [],
  };
}

module.exports = {
  compileAppsDoc,
  resolveAppsRuntime,
  compileTool,
  compileApiKeyApp,
  compileSessionSource,
};
