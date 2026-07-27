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

/**
 * 已纳管(hosted)的 Agent id 集合 —— 与 Gateway apps:list「已纳管」口径一致：
 *   shim 默认纳管(hosted !== false)，其余须 hosted === true；needs_dev_mode 视为未纳管。
 * 供资源投射目标使用（可投射 = 已纳管，而非「机器上装了」）。
 * @returns {Set<string>}
 */
function listHostedAgentIds() {
  const { MCP_SYNC_ID_ALIASES } = require('./mcp-agent-targets');
  const ids = new Set();
  for (const a of readLocalApps()) {
    if (!a || a.draft) continue;
    const isShim = a.link_method === 'shim';
    const managed = isShim ? a.hosted !== false : a.hosted === true;
    if (!managed) continue;
    if (a.needs_dev_mode) continue;
    const raw = a.agent_id || a.preset_id;
    if (!raw) continue;
    const id = String(raw);
    ids.add(id);
    // 别名：codex-desktop→codex、claude-desktop→claude-code（与 MCP 写盘口径一致）
    if (MCP_SYNC_ID_ALIASES[id]) ids.add(MCP_SYNC_ID_ALIASES[id]);
  }
  return ids;
}

/**
 * 全部「已纳管」应用的投射目标 id 集合（prompt / 智能体投射用，非 skill）——
 * = 已纳管 agent（含 Trae 等，来自 listHostedAgentIds）∪ 已纳管的 manual/API 应用（New app）。
 * 这些 id 即投射 / 中转交付的 cid：能映射 stdio sync client 的（codex-desktop→codex）已含别名，
 * 其余（trae-work / app-xxx）以自身 id 经内置中转 MCP 交付。
 * 说明：安装过滤交由展示层（apps:list 已滤）；此处从宽，仅作投射入参的安全白名单。
 * @returns {Set<string>}
 */
function listManagedAppTargetIds() {
  const ids = new Set(listHostedAgentIds());
  for (const a of readLocalApps()) {
    if (!a || a.draft) continue;
    if (a.link_method === 'manual' && a.hosted === true && typeof a.id === 'string') {
      ids.add(a.id);
    }
  }
  return ids;
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
  listHostedAgentIds,
  listManagedAppTargetIds,
  listGatewayApiApps,
  listGatewayAgentTargets,
  listGatewayBindTargets,
  listGatewayBindClientIds,
};
