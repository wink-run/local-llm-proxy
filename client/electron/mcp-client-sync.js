// client/electron/mcp-client-sync.js
// 将 Token Bank 已纳管 MCP 同步到各 Agent 客户端，并扫描客户端已有 MCP 配置
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const shim = require('./shim-installer');
const { BUILTIN_BRIDGE_ID } = require('./mcp-manager');
const { CLIENT_TARGETS } = require('./mcp-agent-targets');

const STATE_PATH = path.join(os.homedir(), '.tokenbank', 'mcp', 'client-sync-state.json');
const TB_MCP_MARKER = 'tokenbank-mcp';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 解析 Agent MCP 配置文件路径（优先已存在的文件；WorkBuddy 固定为 ~/.workbuddy/mcp.json） */
function resolveTargetConfigPath(target) {
  const paths = target.getPaths ? target.getPaths() : [target.getPath()];
  return paths.find(p => fs.existsSync(p)) || paths[0];
}

function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch {}
  return { clients: {} };
}

function writeState(state) {
  ensureDir(STATE_PATH);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/** 将 DB 中的 server 转为 MCP JSON 条目（跳过内置 bridge） */
function serverToEntry(serverRow) {
  if (!serverRow || serverRow.status !== 'active') return null;
  if (serverRow.id === BUILTIN_BRIDGE_ID || serverRow.builtin && serverRow.id === BUILTIN_BRIDGE_ID) {
    return null;
  }

  let command = serverRow.command;
  if (command === '__DYNAMIC_ELECTRON__') return null;
  if (command === 'npx') {
    command = shim.resolveRealCommand('npx') || 'npx';
  }

  let args = [];
  let env = {};
  if (Array.isArray(serverRow.args)) args = serverRow.args;
  else {
    try { args = JSON.parse(serverRow.args || '[]'); } catch {}
  }
  if (serverRow.env && typeof serverRow.env === 'object' && !Array.isArray(serverRow.env)) {
    env = serverRow.env;
  } else {
    try { env = JSON.parse(serverRow.env || '{}'); } catch {}
  }

  if (!command) return null;

  const entry = { command, args: Array.isArray(args) ? args : [] };
  if (env && Object.keys(env).length) entry.env = env;
  return entry;
}

/** 客户端里使用的 server 键名（避免覆盖用户自配 MCP） */
function clientKeyForServer(serverRow, existingKeys, prevTbKeys) {
  const base = serverRow.name || serverRow.id;
  if (prevTbKeys.includes(base)) return base;
  if (!existingKeys.has(base)) return base;
  const alt = `tb-${base}`;
  if (!existingKeys.has(alt)) return alt;
  return `tb-${serverRow.id}`;
}

function loadJsonMcp(filePath) {
  if (!fs.existsSync(filePath)) return { mcpServers: {} };
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (raw.mcpServers && typeof raw.mcpServers === 'object') return raw;
  if (raw.servers && typeof raw.servers === 'object') {
    return { mcpServers: raw.servers };
  }
  return { mcpServers: {} };
}

function syncJsonClient(clientId, filePath, servers) {
  ensureDir(filePath);
  const prev = readState().clients[clientId]?.keys || [];
  const doc = loadJsonMcp(filePath);
  const existingKeys = new Set(Object.keys(doc.mcpServers || {}));

  // 移除上次由 Token Bank 写入的条目
  for (const key of prev) {
    delete doc.mcpServers[key];
    existingKeys.delete(key);
  }

  const newKeys = [];
  const synced = [];

  for (const srv of servers) {
    const entry = serverToEntry(srv);
    if (!entry) continue;
    const key = clientKeyForServer(srv, existingKeys, prev);
    doc.mcpServers[key] = entry;
    existingKeys.add(key);
    newKeys.push(key);
    synced.push({ id: srv.id, name: srv.display_name || srv.name, clientKey: key });
  }

  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
  return { synced, keys: newKeys, path: filePath };
}

/** 从 Codex config.toml 移除 Token Bank 写入的 mcp_servers 段 */
function stripCodexTbMcpSections(text, prevKeys) {
  let lines = text.split(/\r?\n/);
  for (const key of prevKeys) {
    const headRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(key)}\\]\\s*$`);
    const envRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(key)}\\.env\\]\\s*$`);
    let i = 0;
    while (i < lines.length) {
      if (headRe.test(lines[i]) || envRe.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
        lines.splice(i, j - i);
        continue;
      }
      i++;
    }
  }
  return lines.join('\n');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlQuote(v) {
  return JSON.stringify(String(v));
}

function buildCodexMcpSections(entries) {
  const blocks = [];
  for (const { key, entry } of entries) {
    blocks.push(`[mcp_servers.${key}]`);
    blocks.push(`command = ${tomlQuote(entry.command)}`);
    blocks.push(`args = ${JSON.stringify(entry.args)}`);
    if (entry.env && Object.keys(entry.env).length) {
      blocks.push('');
      blocks.push(`[mcp_servers.${key}.env]`);
      for (const [k, v] of Object.entries(entry.env)) {
        blocks.push(`${k} = ${tomlQuote(v)}`);
      }
    }
    blocks.push('');
  }
  return blocks;
}

function syncCodexClient(filePath, servers, prevKeys) {
  ensureDir(filePath);
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  let text = stripCodexTbMcpSections(original, prevKeys);

  const entries = [];
  const synced = [];
  const newKeys = [];

  for (const srv of servers) {
    const entry = serverToEntry(srv);
    if (!entry) continue;
    const key = clientKeyForServer(srv, new Set(), prevKeys);
    entries.push({ key, entry });
    newKeys.push(key);
    synced.push({ id: srv.id, name: srv.display_name || srv.name, clientKey: key });
  }

  if (entries.length) {
    const marker = `\n# >>> ${TB_MCP_MARKER} managed >>>\n`;
    const body = buildCodexMcpSections(entries).join('\n');
    const end = `# <<< ${TB_MCP_MARKER} managed <<<\n`;
    text = text.replace(/\n# >>> tokenbank-mcp managed >>>[\s\S]*?# <<< tokenbank-mcp managed <<<\n?/g, '\n');
    text = text.trimEnd() + marker + body + end;
  } else {
    text = text.replace(/\n# >>> tokenbank-mcp managed >>>[\s\S]*?# <<< tokenbank-mcp managed <<<\n?/g, '\n');
  }

  fs.writeFileSync(filePath, text.endsWith('\n') ? text : text + '\n', 'utf8');
  return { synced, keys: newKeys, path: filePath };
}

/**
 * 同步 active MCP 到 Agent 客户端（可按 Agent 分别写入）
 * @param {object[]} servers 来自 mcpManager.listManagedServers()
 * @param {{ clientIds?: string[] }} options 指定 Agent；缺省则同步全部可写 Agent
 */
function syncAll(servers, options = {}) {
  const state = readState();
  const results = [];
  const allSyncIds = Object.keys(CLIENT_TARGETS).filter(id => CLIENT_TARGETS[id].sync !== false);
  const clientIds = Array.isArray(options.clientIds) && options.clientIds.length
    ? options.clientIds.filter(id => allSyncIds.includes(id))
    : allSyncIds;

  for (const clientId of clientIds) {
    const target = CLIENT_TARGETS[clientId];
    try {
      const filePath = resolveTargetConfigPath(target);
      const prevKeys = state.clients[clientId]?.keys || [];
      const clientServers = filterServersForClient(servers, clientId);
      let result;

      if (target.format === 'json-mcp') {
        result = syncJsonClient(clientId, filePath, clientServers);
      } else if (target.format === 'toml-mcp') {
        result = syncCodexClient(filePath, clientServers, prevKeys);
      } else {
        continue;
      }

      state.clients[clientId] = {
        keys: result.keys,
        bindings: result.synced.map(s => ({ serverId: s.id, clientKey: s.clientKey })),
        lastSync: Date.now(),
        path: result.path,
        count: result.synced.length,
      };

      results.push({
        clientId,
        label: target.label,
        success: true,
        path: result.path,
        synced: result.synced,
        count: result.synced.length,
        syncEnabled: true,
      });
    } catch (e) {
      results.push({
        clientId,
        label: target.label,
        success: false,
        error: e.message,
        syncEnabled: true,
      });
    }
  }

  state.lastSync = Date.now();
  writeState(state);
  return { success: results.every(r => r.success), results, state };
}

/** 读取 MCP 应同步到哪些 Agent（默认全部可写 Agent） */
function getServerSyncClients(server) {
  const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
  const defaults = listSyncEnabledClientIds();
  if (Array.isArray(server?.sync_clients)) {
    return server.sync_clients.filter(id => defaults.includes(id));
  }
  if (Array.isArray(server?.metadata?.sync_clients)) {
    return server.metadata.sync_clients.filter(id => defaults.includes(id));
  }
  return defaults;
}

/** 筛选应写入指定 Agent 的 MCP 列表 */
function filterServersForClient(servers, clientId) {
  return (servers || []).filter(s => {
    if (s.status !== 'active' || s.source === 'client') return false;
    if (s.id === BUILTIN_BRIDGE_ID) return false;
    return getServerSyncClients(s).includes(clientId);
  });
}

/** 统计各 Agent 配置文件中扫描到的 MCP 数量 */
function buildScanIndex() {
  const index = {};
  for (const item of scanAllClientMcps()) {
    if (!index[item.clientId]) index[item.clientId] = new Map();
    index[item.clientId].set(item.clientKey, item);
  }
  return index;
}

function getSyncStatus() {
  const state = readState();
  const scanIndex = buildScanIndex();

  return {
    state,
    agents: Object.entries(CLIENT_TARGETS).map(([id, t]) => ({ id, label: t.label })),
    targets: Object.entries(CLIENT_TARGETS).map(([id, t]) => {
      const paths = t.getPaths ? t.getPaths() : [t.getPath()];
      const existingPath = paths.find(p => fs.existsSync(p)) || paths[0];
      const scannedKeys = scanIndex[id] ? [...scanIndex[id].keys()] : [];
      const syncedCount = state.clients[id]?.count || 0;

      return {
        id,
        label: t.label,
        path: existingPath,
        paths,
        exists: paths.some(p => fs.existsSync(p)),
        lastSync: state.clients[id]?.lastSync || null,
        count: Math.max(syncedCount, scannedKeys.length),
        scannedCount: scannedKeys.length,
        syncedCount,
        syncEnabled: t.sync !== false,
        bindings: state.clients[id]?.bindings || [],
        scannedKeys,
      };
    }),
  };
}

/** serverId → 各 Agent 客户端安装记录 */
function getServerInstallMap() {
  const state = readState();
  const map = {};
  for (const [clientId, clientState] of Object.entries(state.clients || {})) {
    const label = CLIENT_TARGETS[clientId]?.label || clientId;
    for (const b of clientState.bindings || []) {
      if (!b.serverId) continue;
      if (!map[b.serverId]) map[b.serverId] = [];
      map[b.serverId].push({
        clientId,
        label,
        clientKey: b.clientKey,
      });
    }
  }
  return map;
}

/** 为 server 列表附加各 Agent 安装情况（同步写入 + 配置文件扫描） */
function enrichServersWithClientInstalls(servers) {
  const installMap = getServerInstallMap();
  const scanIndex = buildScanIndex();
  const allClients = Object.entries(CLIENT_TARGETS).map(([id, t]) => ({ id, label: t.label }));

  return (servers || []).map(s => {
    const installs = [...(installMap[s.id] || [])];
    const installedSet = new Set(installs.map(i => i.clientId));

    // 扫描匹配：按 server.name 或已绑定的 clientKey 在各 Agent 配置中查找
    const matchKeys = new Set([s.name].filter(Boolean));
    for (const inst of installs) {
      if (inst.clientKey) matchKeys.add(inst.clientKey);
    }

    for (const [clientId, keyMap] of Object.entries(scanIndex)) {
      if (installedSet.has(clientId)) continue;
      const target = CLIENT_TARGETS[clientId];
      for (const key of matchKeys) {
        if (keyMap.has(key)) {
          installs.push({
            clientId,
            label: target?.label || clientId,
            clientKey: key,
            source: 'scan',
          });
          installedSet.add(clientId);
          break;
        }
      }
    }

    return {
      ...s,
      sync_clients: getServerSyncClients(s),
      clientInstalls: installs,
      clientTargets: allClients.map(c => ({
        ...c,
        syncAssigned: getServerSyncClients(s).includes(c.id) && CLIENT_TARGETS[c.id]?.sync !== false,
        syncEnabled: CLIENT_TARGETS[c.id]?.sync !== false,
        installed: installedSet.has(c.id),
        synced: installs.some(i => i.clientId === c.id && i.source !== 'scan'),
        clientKey: installs.find(i => i.clientId === c.id)?.clientKey || null,
      })),
    };
  });
}

/** 安装完成后的提示文案（按目标 Agent 区分） */
function getPostSyncHint(options = {}) {
  const { clientIds, results } = options;
  const syncedIds = new Set([
    ...(Array.isArray(clientIds) ? clientIds : []),
    ...(Array.isArray(results) ? results.filter(r => r.success).map(r => r.clientId) : []),
  ]);

  const lines = ['已写入客户端配置文件。'];

  if (syncedIds.has('workbuddy')) {
    lines.push(
      'WorkBuddy 目前仅写入配置，还需手动信任后才会真正激活：请到 WorkBuddy 右上角「连接器管理」，对每个新出现的 MCP 服务器点击「Trust」启用。',
    );
  }

  const needReload = ['cursor', 'codex'].filter(id => syncedIds.has(id));
  if (needReload.length) {
    lines.push(`${needReload.map(id => CLIENT_TARGETS[id]?.label || id).join(' / ')} 需重启或 Reload Window 后才会扫描到新 MCP。`);
  }

  return lines.join('\n');
}

/** Token Bank 上次写入各客户端的 MCP 键名 */
function getTbManagedClientKeys() {
  const state = readState();
  const set = new Set();
  for (const [clientId, clientState] of Object.entries(state.clients || {})) {
    for (const key of clientState.keys || []) {
      set.add(`${clientId}:${key}`);
    }
  }
  return set;
}

function normalizeMcpEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.enabled === false) return null;

  const url = raw.url || raw.httpUrl || raw.sseUrl || null;
  const entry = {
    command: raw.command ? String(raw.command) : '',
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : {},
    url: url ? String(url) : null,
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : undefined,
  };
  if (!entry.command && !entry.url) return null;
  return entry;
}

function deepGet(obj, dotKey) {
  const parts = dotKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return null;
  }
  return cur;
}

/** 读取 JSON/JSON5 配置文件 */
function readJsonConfig(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    // OpenClaw 等可能使用 JSON5 注释，尽力剥离 //
    const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(stripped);
  }
}

/** 从 Agent 配置文件解析 MCP 条目 → [[clientKey, raw], ...] */
function parseMcpEntriesFromFile(filePath, target) {
  const format = target.format;

  if (format === 'json-mcp') {
    const doc = loadJsonMcp(filePath);
    return Object.entries(doc.mcpServers || {});
  }

  if (format === 'yaml-mcp-servers') {
    const yaml = require('js-yaml').load(fs.readFileSync(filePath, 'utf8')) || {};
    return Object.entries(yaml.mcp_servers || {});
  }

  if (format === 'json-nested') {
    const doc = readJsonConfig(filePath);
    const nested = deepGet(doc, target.nestedKey || 'mcp.servers');
    return Object.entries(nested && typeof nested === 'object' ? nested : {});
  }

  if (format === 'toml-mcp') {
    return parseCodexMcpSections(fs.readFileSync(filePath, 'utf8'))
      .map(({ clientKey, entry }) => [clientKey, entry]);
  }

  return [];
}

function parseTomlScalar(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    try { return JSON.parse(s); } catch { return s; }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

/** 解析 Codex config.toml 中的 mcp_servers.* 段（含 Token Bank 与用户自配） */
function parseCodexMcpSections(text) {
  const entries = [];
  const lines = String(text || '').split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const head = lines[i].match(/^\s*\[mcp_servers\.([^\].]+)\]\s*$/);
    if (head) {
      const key = head[1];
      const entry = { command: '', args: [], env: {} };
      i += 1;
      while (i < lines.length && !/^\s*\[/.test(lines[i])) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#')) {
          const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
          if (kv) {
            const val = parseTomlScalar(kv[2]);
            if (kv[1] === 'command') entry.command = String(val || '');
            else if (kv[1] === 'args') entry.args = Array.isArray(val) ? val.map(String) : [];
          }
        }
        i += 1;
      }
      if (entry.command) entries.push({ clientKey: key, entry });
      continue;
    }

    const envHead = lines[i].match(/^\s*\[mcp_servers\.([^\].]+)\.env\]\s*$/);
    if (envHead) {
      const key = envHead[1];
      let target = entries.find(e => e.clientKey === key);
      if (!target) {
        target = { clientKey: key, entry: { command: '', args: [], env: {} } };
        entries.push(target);
      }
      i += 1;
      while (i < lines.length && !/^\s*\[/.test(lines[i])) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#')) {
          const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
          if (kv) target.entry.env[kv[1]] = String(parseTomlScalar(kv[2]) || '');
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }

  return entries.filter(e => e.entry.command);
}

/** 扫描各 Agent 客户端配置文件中的 MCP 条目 */
function scanAllClientMcps() {
  const results = [];

  for (const [clientId, target] of Object.entries(CLIENT_TARGETS)) {
    const paths = target.getPaths ? target.getPaths() : [target.getPath()];

    for (const filePath of paths) {
      if (!fs.existsSync(filePath)) continue;

      try {
        const pairs = parseMcpEntriesFromFile(filePath, target);
        for (const [clientKey, raw] of pairs) {
          const entry = normalizeMcpEntry(raw);
          if (!entry) continue;
          results.push({
            clientId,
            clientKey,
            entry,
            label: target.label,
            path: filePath,
          });
        }
      } catch (e) {
        console.warn(`[mcp-client-sync] scan ${clientId} (${filePath}) failed:`, e.message);
      }
    }
  }

  return results;
}

function inferClientMcpDescription(entry) {
  const args = entry?.args || [];
  const pkg = args.find(a => typeof a === 'string' && (a.includes('/') || a.includes('-mcp')));
  if (pkg) return `客户端自配 · ${pkg}`;
  if (entry?.command) return `客户端自配 · ${path.basename(entry.command)}`;
  return 'Agent 客户端配置中的 MCP（未在 Token Bank 纳管）';
}

/**
 * 发现客户端配置中存在、但未被 Token Bank 同步管理的 MCP
 * @param {object[]} managedServers 来自 DB 的已纳管列表
 */
function discoverExternalMcps(managedServers = []) {
  const tbKeys = getTbManagedClientKeys();
  const state = readState();

  // 已由 Token Bank 纳管的 MCP 在客户端可能使用的键名（避免与已纳管条目重复展示）
  const managedClientKeys = new Set();
  for (const srv of managedServers || []) {
    if (srv.name) managedClientKeys.add(srv.name);
  }
  for (const clientState of Object.values(state.clients || {})) {
    for (const b of clientState.bindings || []) {
      if (b.clientKey) managedClientKeys.add(b.clientKey);
    }
  }

  const byKey = new Map();

  for (const item of scanAllClientMcps()) {
    if (tbKeys.has(`${item.clientId}:${item.clientKey}`)) continue;
    if (managedClientKeys.has(item.clientKey)) continue;

    if (!byKey.has(item.clientKey)) {
      byKey.set(item.clientKey, {
        clientKey: item.clientKey,
        entry: item.entry,
        clients: [],
      });
    }
    const group = byKey.get(item.clientKey);
    if (!group.clients.some(c => c.clientId === item.clientId)) {
      group.clients.push({
        clientId: item.clientId,
        label: item.label,
        path: item.path,
      });
    }
  }

  const allClients = Object.entries(CLIENT_TARGETS).map(([id, t]) => ({ id, label: t.label }));

  return Array.from(byKey.values())
    .map(group => {
      const installedSet = new Set(group.clients.map(c => c.clientId));
      return {
        id: `client-external:${group.clientKey}`,
        name: group.clientKey,
        display_name: group.clientKey,
        type: group.entry.url ? 'sse' : 'stdio',
        command: group.entry.command,
        args: group.entry.args,
        env: group.entry.env,
        url: group.entry.url || null,
        builtin: false,
        status: 'active',
        source: 'client',
        managed: false,
        metadata: {
          description: inferClientMcpDescription(group.entry),
          category: 'client',
          clientKey: group.clientKey,
        },
        clientInstalls: group.clients.map(c => ({
          clientId: c.clientId,
          label: c.label,
          clientKey: group.clientKey,
        })),
        clientTargets: allClients.map(c => ({
          ...c,
          installed: installedSet.has(c.id),
          clientKey: installedSet.has(c.id) ? group.clientKey : null,
        })),
      };
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'zh-CN'));
}

/** 读取指定 clientKey 的客户端 MCP 配置（用于纳管导入） */
function getClientMcpEntry(clientKey) {
  for (const item of scanAllClientMcps()) {
    if (item.clientKey === clientKey) return item;
  }
  return null;
}

/** 读取指定 Agent 上的 MCP 配置（纳管时不改动该 Agent 原配置） */
function getClientMcpEntryForAgent(clientId, clientKey) {
  const key = String(clientKey || '').trim();
  if (!clientId || !key) return null;
  for (const item of scanAllClientMcps()) {
    if (item.clientId === clientId && item.clientKey === key) return item;
  }
  return null;
}

/** 从 Agent 配置文件删除指定 MCP 条目（用户自配或非 TB 写入） */
function removeRawClientMcpEntry(clientId, clientKey, { ignoreMissing = false } = {}) {
  const target = CLIENT_TARGETS[clientId];
  if (!target) throw new Error(`未知 Agent: ${clientId}`);
  const key = String(clientKey || '').trim();
  if (!key) throw new Error('缺少 clientKey');

  const paths = target.getPaths ? target.getPaths() : [target.getPath()];

  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;

    try {
      if (target.format === 'json-mcp') {
        const doc = loadJsonMcp(filePath);
        if (!doc.mcpServers[key]) continue;
        delete doc.mcpServers[key];
        fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
        return { clientId, clientKey: key, path: filePath };
      }

      if (target.format === 'yaml-mcp-servers') {
        const yaml = require('js-yaml');
        const doc = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
        if (!doc.mcp_servers?.[key]) continue;
        delete doc.mcp_servers[key];
        if (!Object.keys(doc.mcp_servers).length) delete doc.mcp_servers;
        fs.writeFileSync(filePath, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
        return { clientId, clientKey: key, path: filePath };
      }

      if (target.format === 'json-nested') {
        const doc = readJsonConfig(filePath);
        const nested = deepGet(doc, target.nestedKey || 'mcp.servers');
        if (!nested || !nested[key]) continue;
        delete nested[key];
        fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
        return { clientId, clientKey: key, path: filePath };
      }

      if (target.format === 'toml-mcp') {
        const original = fs.readFileSync(filePath, 'utf8');
        const stripped = stripCodexMcpKey(original, key);
        if (stripped === original) continue;
        fs.writeFileSync(filePath, stripped.endsWith('\n') ? stripped : stripped + '\n', 'utf8');
        return { clientId, clientKey: key, path: filePath };
      }
    } catch (e) {
      console.warn(`[mcp-client-sync] remove ${clientId}/${key} from ${filePath}:`, e.message);
    }
  }

  if (ignoreMissing) return { clientId, clientKey: key, path: null, skipped: true };
  throw new Error(`未在 ${target.label} 配置中找到: ${key}`);
}

/**
 * 按 Agent 维度汇总配置文件中的 MCP（通过 TB 安装 / 客户端自配）
 * @param {object[]} managedServers Token Bank 已纳管列表
 */
function listAgentInstallations(managedServers = []) {
  const state = readState();
  const scanIndex = buildScanIndex();
  const installMap = getServerInstallMap();
  const managedById = new Map((managedServers || []).map(s => [s.id, s]));

  function findManagedByClientKey(clientKey, agentId) {
    for (const s of managedServers || []) {
      if (s.name === clientKey) return s;
      const installs = installMap[s.id] || [];
      if (installs.some(i => i.clientId === agentId && i.clientKey === clientKey)) return s;
    }
    return null;
  }

  return Object.entries(CLIENT_TARGETS).map(([agentId, target]) => {
    const paths = target.getPaths ? target.getPaths() : [target.getPath()];
    const existingPath = paths.find(p => fs.existsSync(p)) || paths[0];
    const keyMap = scanIndex[agentId] || new Map();
    const bindings = state.clients[agentId]?.bindings || [];
    const bindingByKey = new Map(bindings.map(b => [b.clientKey, b]));

    const items = [];
    for (const [clientKey, scanItem] of keyMap) {
      const binding = bindingByKey.get(clientKey);
      const managed = findManagedByClientKey(clientKey, agentId);
      let source = 'client';
      let serverId = null;
      let displayName = clientKey;

      if (binding?.serverId) {
        source = 'tb_sync';
        serverId = binding.serverId;
        const srv = managedById.get(serverId);
        displayName = srv?.display_name || srv?.name || clientKey;
      } else if (managed) {
        source = 'tb_scanned';
        serverId = managed.id;
        displayName = managed.display_name || managed.name;
      }

      items.push({
        clientKey,
        displayName,
        serverId,
        managed: !!managed || source === 'tb_sync',
        source,
        type: scanItem.entry?.url ? 'sse' : 'stdio',
        command: scanItem.entry?.command || '',
        args: scanItem.entry?.args || [],
        description: source === 'client'
          ? inferClientMcpDescription(scanItem.entry)
          : (managedById.get(serverId)?.metadata?.description || displayName),
      });
    }

    items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));

    return {
      id: agentId,
      label: target.label,
      path: existingPath,
      paths,
      exists: paths.some(p => fs.existsSync(p)),
      syncEnabled: target.sync !== false,
      count: items.length,
      items,
    };
  });
}

/** 从 Codex config.toml 删除单个 mcp_servers.* 段 */
function stripCodexMcpKey(text, key) {
  let lines = String(text || '').split(/\r?\n/);
  const headRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(key)}\\]\\s*$`);
  const envRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(key)}\\.env\\]\\s*$`);
  let i = 0;
  while (i < lines.length) {
    if (headRe.test(lines[i]) || envRe.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
      lines.splice(i, j - i);
      continue;
    }
    i += 1;
  }
  return lines.join('\n');
}

module.exports = {
  syncAll,
  getSyncStatus,
  getPostSyncHint,
  getServerInstallMap,
  enrichServersWithClientInstalls,
  discoverExternalMcps,
  listAgentInstallations,
  getClientMcpEntry,
  getClientMcpEntryForAgent,
  removeRawClientMcpEntry,
  scanAllClientMcps,
  inferClientMcpDescription,
  getServerSyncClients,
  filterServersForClient,
  CLIENT_TARGETS,
  serverToEntry,
};
