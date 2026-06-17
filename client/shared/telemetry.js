// client/shared/telemetry.js
// Electron 与 CLI 共用的 local-stats + 会话补录初始化。
'use strict';

const path = require('path');
const os   = require('os');

const localStats    = require('../electron/local-stats');
const sessionImport = require('../electron/session-import');
const { readLocalConfig } = require('./config-loader');

/** 与 Electron 统一的数据目录（local-stats.db） */
const STATS_DIR = path.join(os.homedir(), '.tokenbank');

// agent_id → data_source（从 tokenbank.default.yaml 的 session_sources 派生）
function buildAgentDataSource() {
  const m = {};
  try {
    for (const s of (require('../electron/config-loader').sessionSources() || [])) {
      if (s && s.agent_id && s.data_source) m[s.agent_id] = s.data_source;
    }
  } catch {}
  return m;
}

// 带 proxy_dedup 的 data_source 集合（Claude 等：网关与会话 request_id 可对齐去重）
function buildProxyDedupDs() {
  const s = new Set();
  try {
    for (const src of (require('../electron/config-loader').sessionSources() || [])) {
      if (src && src.proxy_dedup) {
        if (src.data_source) s.add(src.data_source);
        const m = src.data_source_map && src.data_source_map.map;
        if (m) for (const v of Object.values(m)) s.add(v);
      }
    }
  } catch {}
  return s;
}

const SESSION_DS_BY_PRESET = {
  'claude-desktop': 'session-claude-desktop',
  'codex-desktop':  'session-codex',
};

/** 取消纳管 / 已走网关且无法去重的源 → 跳过会话扫描 */
function computeImportSkip() {
  const skip = new Set();
  const AGENT_DATA_SOURCE = buildAgentDataSource();
  const PROXY_DEDUP_DS    = buildProxyDedupDs();
  try {
    for (const app of ((readLocalConfig() || {}).apps || [])) {
      const ds = AGENT_DATA_SOURCE[app.agent_id] || SESSION_DS_BY_PRESET[app.preset_id];
      if (!ds) continue;
      if (app.hosted === false) { skip.add(ds); continue; }
      if (app.hosted && app.route_id && !PROXY_DEDUP_DS.has(ds)) skip.add(ds);
    }
  } catch {}
  return skip;
}

/**
 * 初始化 SQLite 统计、网关落账回调、定时会话补录。
 * @returns {{ shutdown: function }} 进程退出时调用
 */
function initGatewayTelemetry(gateway) {
  localStats.init(STATS_DIR);
  gateway.setStatsRecorder(localStats.record);
  gateway.setLocalStats(localStats);

  const runImport = () => {
    try { sessionImport.run(localStats, { skip: computeImportSkip() }); }
    catch (e) { console.error('[session-import]', e.message); }
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
