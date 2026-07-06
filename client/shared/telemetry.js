// client/shared/telemetry.js
// Electron 与 CLI 共用的 local-stats + 会话补录初始化。
'use strict';

const path = require('path');
const os   = require('os');

const localStats    = require('../electron/local-stats');
const sessionImport = require('../electron/session-import');
const cursorHooks   = require('../electron/cursor-hooks');
const { readLocalConfig } = require('./config-loader');

/** 与 Electron 统一的数据目录（local-stats.db） */
const STATS_DIR = path.join(os.homedir(), '.tokenbank');

function configLoader() {
  return require('../electron/config-loader');
}

// agent_id → data_source（从展开的 session_sources 派生）
function buildAgentDataSource() {
  const m = {};
  try {
    for (const s of (configLoader().sessionSources() || [])) {
      if (s && s.agent_id && s.data_source) m[s.agent_id] = s.data_source;
    }
  } catch {}
  return m;
}

function buildProxyDedupDs() {
  const s = new Set();
  try {
    for (const src of (configLoader().sessionSources() || [])) {
      if (src && src.proxy_dedup) {
        if (src.data_source) s.add(src.data_source);
        const m = src.data_source_map && src.data_source_map.map;
        if (m) for (const v of Object.values(m)) s.add(v);
      }
    }
  } catch {}
  return s;
}

/** 应用关联的会话 data_source 列表（handler.linked_data_sources 或 agent 主源） */
function dataSourcesForApp(app) {
  if (!app) return [];
  if (app.linked_data_sources?.length) return [...app.linked_data_sources];
  const aid = app.agent_id || app.preset_id;
  if (!aid) return [];
  try {
    const ent = configLoader().appEntityById(aid);
    if (ent?.linked_data_sources?.length) return [...ent.linked_data_sources];
  } catch {}
  const AGENT_DATA_SOURCE = buildAgentDataSource();
  const ds = AGENT_DATA_SOURCE[app.agent_id];
  return ds ? [ds] : [];
}

/** 取消纳管 / 已走网关且无法去重的源 → 跳过会话扫描 */
function computeImportSkip() {
  const skip = new Set();
  const PROXY_DEDUP_DS = buildProxyDedupDs();
  try {
    for (const app of ((readLocalConfig() || {}).apps || [])) {
      for (const ds of dataSourcesForApp(app)) {
        if (app.hosted === false) { skip.add(ds); continue; }
        const hasRoute = !!(app.route_id || (Array.isArray(app.route_ids) && app.route_ids.length));
        if (app.hosted && hasRoute && !PROXY_DEDUP_DS.has(ds)) skip.add(ds);
      }
    }
    // editor hook 纳管：由 handler.integrations.editor_hook 声明
    for (const app of ((readLocalConfig() || {}).apps || [])) {
      if (app.link_method !== 'direct' || !app.agent_id || !app.hosted) continue;
      const ent = configLoader().appEntityById(app.agent_id);
      if (ent?.integrations?.editor_hook && cursorHooks.isInstalled()) {
        const ds = buildAgentDataSource()[app.agent_id];
        if (ds) skip.add(ds);
      }
    }
  } catch {}
  return skip;
}

function initGatewayTelemetry(gateway) {
  localStats.init(STATS_DIR);
  gateway.setStatsRecorder(localStats.record);
  gateway.setLocalStats(localStats);

  const runImport = () => {
    try {
      cursorHooks.importEvents(localStats);
      sessionImport.run(localStats, { skip: computeImportSkip() });
    } catch (e) { console.error('[session-import]', e.message); }
  };
  runImport();
  const timer = setInterval(runImport, 30_000);

  return {
    shutdown() {
      clearInterval(timer);
      localStats.close();
    },
  };
}

module.exports = { STATS_DIR, computeImportSkip, initGatewayTelemetry, localStats };
