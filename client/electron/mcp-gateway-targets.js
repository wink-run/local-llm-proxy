// mcp-gateway-targets.js
// MCP 网关可绑定目标：Agent（写盘投射）+ Gateway「API 应用」+ 通用 api 档
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { listSyncEnabledClientIds, CLIENT_TARGETS } = require('./mcp-agent-targets');

/** 通用配置档：未单独建 API 应用时的兜底 */
const GENERIC_API_PROFILE = {
  id: 'api',
  label: '通用 API / 其他',
  kind: 'generic',
};

/** @type {null | (() => object[])} */
let appsGetter = null;

/** 由 main.js 注入 getApps，保证与 Gateway 列表同源 */
function setAppsGetter(fn) {
  appsGetter = typeof fn === 'function' ? fn : null;
}

function readLocalConfigCandidates() {
  const paths = [];
  try {
    const electron = require('electron');
    const app = electron.app || electron.default?.app;
    if (app && typeof app.getPath === 'function') {
      paths.push(path.join(app.getPath('userData'), 'local-config.json'));
    }
  } catch { /* ignore */ }
  // 回退：常见 userData 目录（开发/正式包名不一致时）
  const home = os.homedir();
  if (process.platform === 'darwin') {
    paths.push(
      path.join(home, 'Library/Application Support/Token Bank/local-config.json'),
      path.join(home, 'Library/Application Support/Token Bank-dev/local-config.json'),
      path.join(home, 'Library/Application Support/llm-proxy-client/local-config.json'),
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
    paths.push(
      path.join(appData, 'Token Bank/local-config.json'),
      path.join(appData, 'Token Bank-dev/local-config.json'),
      path.join(appData, 'llm-proxy-client/local-config.json'),
    );
  } else {
    paths.push(
      path.join(home, '.config/Token Bank/local-config.json'),
      path.join(home, '.config/token-bank/local-config.json'),
      path.join(home, '.config/llm-proxy-client/local-config.json'),
    );
  }
  return [...new Set(paths)];
}

function readLocalApps() {
  // 优先：main 注入的 getApps（与 apps:list 同源）
  if (appsGetter) {
    try {
      const apps = appsGetter();
      if (Array.isArray(apps)) return apps;
    } catch (e) {
      console.warn('[mcp-gateway-targets] appsGetter failed:', e.message);
    }
  }
  for (const p of readLocalConfigCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(cfg.apps)) return cfg.apps;
    } catch { /* try next */ }
  }
  return [];
}

/**
 * 是否为 Gateway 列表中「接入 = API」的应用
 * 与 Gateway.jsx linkMethodLabel 一致：仅 link_method === 'manual'
 *（api-key / shim 等显示为「应用」，不进此分组，避免与桌面/CLI 重复）
 */
function isApiAppRecord(a) {
  if (!a || a.draft) return false;
  return a.link_method === 'manual';
}

/** 已纳管的 API 应用列表（供网关绑定与 UI） */
function listGatewayApiApps() {
  return readLocalApps()
    .filter(isApiAppRecord)
    .filter((a) => typeof a.id === 'string' && /^[\w.-]{1,64}$/.test(a.id))
    .map((a) => ({
      id: a.id,
      label: a.name || a.id,
      kind: 'api-app',
      link_method: a.link_method,
      icon: a.icon || null,
    }));
}

/** Agent 目标（Cursor / Claude Code 等） */
function listGatewayAgentTargets() {
  return listSyncEnabledClientIds().map((id) => ({
    id,
    label: CLIENT_TARGETS[id]?.label || id,
    kind: 'agent',
  }));
}

/**
 * 全部可绑定目标：通用 api → Agent → API 应用
 * @returns {{ id: string, label: string, kind: string }[]}
 */
function listGatewayBindTargets() {
  const apiApps = listGatewayApiApps();
  return [GENERIC_API_PROFILE, ...listGatewayAgentTargets(), ...apiApps];
}

/** 写入时允许的 client id 集合 */
function listGatewayBindClientIds() {
  return listGatewayBindTargets().map((t) => t.id);
}

/** 是否允许绑定到该 id（含尚未扫到列表的 app-*） */
function isAllowedGatewayClientId(id) {
  if (typeof id !== 'string' || !/^[\w.-]{1,64}$/.test(id)) return false;
  if (id === 'api') return true;
  if (listGatewayBindClientIds().includes(id)) return true;
  // Gateway 新建的 API 应用 id 形如 app-xxxxxxxx
  if (/^app-[\w.-]+$/.test(id)) return true;
  return listSyncEnabledClientIds().includes(id);
}

module.exports = {
  GENERIC_API_PROFILE,
  setAppsGetter,
  isApiAppRecord,
  isAllowedGatewayClientId,
  listGatewayApiApps,
  listGatewayAgentTargets,
  listGatewayBindTargets,
  listGatewayBindClientIds,
};
