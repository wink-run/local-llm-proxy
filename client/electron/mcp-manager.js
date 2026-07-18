// client/electron/mcp-manager.js
// MCP 供给源管理：Server 注册、Profile 裁剪、编排模式配置生成
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const localStats = require('./local-stats');
const { STATS_DIR } = require('../shared/telemetry');
const shim = require('./shim-installer');
const { getCatalogItem, listCatalogItems, listCatalogGrouped, MCP_CATEGORY_GROUPS } = require('./mcp-catalog');

const { DELIVERY_POLICY } = require('./agent-delivery-policy');

/** 编排层系统提示（Claude / Codex 共用） */
const ORCHESTRATOR_SYSTEM = [
  '你是 Token Bank 聚合入口的主 Agent（编排层）。',
  '协调其他已纳管 Agent / 专业智能体完成用户任务。',
  '规则：',
  '1. 禁止在 shell 中直接运行 codex/claude/gemini 等 CLI（which/npm install 都不行）。',
  '2. 先用 tb_list_agents 查看可派发目标（含专业智能体 assistant:*）。',
  '3. 优先按名称/能力/描述匹配最合适的专业智能体（type=assistant），用 tb_dispatch_agent 派发；',
  '   仅当没有匹配的专业智能体时，才自行用工具完成，或派发给通用 CLI Agent（claude-code / codex）。',
  '4. 派发后等待结果，汇总后回复用户；不要把本可派发的专业任务自己做完。',
  '5. 涉及 PPT/文件产物时，要求子 Agent / 自身直接写入工作目录，禁止让用户粘贴一键保存脚本。',
  '',
  DELIVERY_POLICY,
].join('\n');

/** 支持 MCP 编排的主 Agent */
const ORCHESTRATOR_AGENTS = new Set(['claude-code', 'codex']);

const BUILTIN_BRIDGE_ID = 'tokenbank-agent-bridge';
const BUILTIN_PROMPTS_ID = 'tokenbank-prompts';
const DEFAULT_PROFILE_ID = 'orchestrator-default';
const DEVELOPMENT_PROFILE_ID = 'development';
const DISPATCH_SCRIPT = path.join(__dirname, 'agent-dispatch-mcp.js');
const PROMPTS_SCRIPT = path.join(__dirname, 'prompt-mcp.js');

/** shell 单引号转义（用于 bridge launcher） */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 解析 Electron 可执行文件路径。
 * 主进程 / ELECTRON_RUN_AS_NODE 下用 process.execPath；
 * 若被系统 Node 误调用（如单测、脚本同步），回退到 electron 包二进制，避免把 node 写进 launcher。
 */
function resolveElectronBinary() {
  if (process.versions.electron) return process.execPath;
  const exec = process.execPath || '';
  if (/[/\\]Electron(\.app)?[/\\]|[/\\]electron([/\\.]|$)/i.test(exec)) return exec;
  try {
    // 在纯 Node 中 require('electron') 返回二进制路径字符串
    const electronPkg = require('electron');
    if (typeof electronPkg === 'string' && fs.existsSync(electronPkg)) return electronPkg;
  } catch { /* ignore */ }
  const platformRel = process.platform === 'darwin'
    ? path.join('electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : process.platform === 'win32'
      ? path.join('electron', 'dist', 'electron.exe')
      : path.join('electron', 'dist', 'electron');
  const candidates = [
    path.join(__dirname, '..', 'node_modules', platformRel),
    path.join(process.cwd(), 'node_modules', platformRel),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return exec;
}

/**
 * 写入 Electron-as-node 启动脚本。
 * Codex 等客户端常不透传 mcp_servers.*.env，直接 spawn Electron 会进 GUI 并 SIGABRT；
 * 脚本内固定 ELECTRON_RUN_AS_NODE，并用 env 再写一遍作双保险。
 */
function writeElectronAsNodeLauncher({ name, scriptPath, env = {} }) {
  const mcpDir = path.join(os.homedir(), '.tokenbank', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  const launcherPath = path.join(mcpDir, `${name}.sh`);
  const electronBin = resolveElectronBinary();
  const absScript = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(scriptPath);
  const envExports = Object.entries(env || {}).map(
    ([k, v]) => `export ${k}=${shellQuote(String(v))}`,
  );
  const lines = [
    '#!/bin/bash',
    'export ELECTRON_RUN_AS_NODE=1',
    ...envExports,
    `exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(electronBin)} ${shellQuote(absScript)}`,
    '',
  ];
  fs.writeFileSync(launcherPath, lines.join('\n'), { mode: 0o755 });
  return launcherPath;
}

/**
 * 写入 bridge MCP 启动脚本：Codex 等外部进程拉起 Electron 时未必透传 env，
 * 缺 ELECTRON_RUN_AS_NODE 会触发 NSApplication 注册并 SIGABRT 崩溃。
 */
function writeBridgeMcpLauncher({
  taskId,
  workingDir,
  mainAgentId,
  sessionKey,
  sessionInstanceId,
  mcpDir,
}) {
  const launcherPath = path.join(mcpDir, `bridge-${taskId}.sh`);
  const dispatchEnv = {};
  try {
    const { getDispatchEndpoint } = require('./agent-dispatch-server');
    const ep = getDispatchEndpoint();
    // 走主进程 HTTP 派发，避免 Codex 沙箱内子进程写 SQLite 报 readonly database
    if (ep?.url && ep?.token) {
      dispatchEnv.TB_DISPATCH_URL = ep.url;
      dispatchEnv.TB_DISPATCH_TOKEN = ep.token;
    }
  } catch { /* 单测或未启动主进程时回退本地派发 */ }

  const env = {
    TB_PARENT_TASK_ID: taskId || '',
    TB_PARENT_SESSION_KEY: sessionKey || '',
    TB_PARENT_SESSION_INSTANCE: sessionInstanceId || '',
    TB_WORKING_DIR: workingDir || process.cwd(),
    TB_MAIN_AGENT_ID: mainAgentId || '',
    TB_CLIENT_ID: mainAgentId || '',
    ...dispatchEnv,
  };
  const envExports = Object.entries(env).map(
    ([k, v]) => `export ${k}=${shellQuote(String(v))}`,
  );
  const electronBin = resolveElectronBinary();
  const lines = [
    '#!/bin/bash',
    'export ELECTRON_RUN_AS_NODE=1',
    ...envExports,
    `exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(electronBin)} ${shellQuote(DISPATCH_SCRIPT)}`,
    '',
  ];
  fs.writeFileSync(launcherPath, lines.join('\n'), { mode: 0o755 });
  return launcherPath;
}

/** 生成 Codex 编排临时 profile（完整 [mcp_servers.*] 表，避免 -c 局部覆盖导致 invalid transport） */
function buildCodexOrchestratorProfileToml(servers, ctx, buildRuntimeConfig) {
  const lines = ['# Token Bank orchestrator MCP profile (ephemeral)'];
  for (const srv of servers) {
    const cfg = buildRuntimeConfig(srv, ctx);
    const name = srv.name;
    const isBridge = srv.id === BUILTIN_BRIDGE_ID || srv.name === BUILTIN_BRIDGE_ID;
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${JSON.stringify(cfg.command)}`);
    lines.push(`args = ${JSON.stringify(cfg.args || [])}`);
    lines.push('enabled = true');
    // 内置 bridge 必须启动，否则编排层无法派发子 Agent
    if (isBridge) lines.push('required = true');
    if (cfg.env && Object.keys(cfg.env).length) {
      lines.push('');
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, v] of Object.entries(cfg.env)) {
        lines.push(`${k} = ${JSON.stringify(String(v))}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

class MCPManager {
  constructor() {
    this._seeded = false;
  }

  _getDb() {
    return localStats.requireDb(STATS_DIR);
  }

  /** 初始化内置 MCP Server 与默认 Profile（幂等） */
  init() {
    if (this._seeded) return;
    const db = this._getDb();
    const now = Date.now();

    this._ensureBuiltinBridge(now);

    // 同构 seed 内置 Prompts MCP：投射门控在同步阶段（filterServersForClient）判定，这里只保证 server 存在
    const prompts = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(BUILTIN_PROMPTS_ID);
    if (!prompts) {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'stdio', ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        BUILTIN_PROMPTS_ID,
        BUILTIN_PROMPTS_ID,
        'Token Bank Prompts',
        '__DYNAMIC_ELECTRON__',
        JSON.stringify([PROMPTS_SCRIPT]),
        JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
        JSON.stringify({
          description: '内置提示词服务：tb_get_prompt / tb_list_prompts（须先投射提示词到该 Agent）',
          tools: ['tb_get_prompt', 'tb_list_prompts'],
        }),
        now,
        now,
      );
    }

    const profiles = [
      {
        id: DEFAULT_PROFILE_ID,
        name: 'orchestrator-default',
        display_name: '编排默认',
        description: '聚合入口默认 Profile，含 Agent 派发桥',
        rules: JSON.stringify({ include: ['tokenbank-*'], servers: [BUILTIN_BRIDGE_ID] }),
      },
      {
        id: 'orchestrator-minimal',
        name: 'orchestrator-minimal',
        display_name: '编排精简',
        description: '仅 Agent 派发桥，不含外部 MCP',
        rules: JSON.stringify({ include: [BUILTIN_BRIDGE_ID], servers: [BUILTIN_BRIDGE_ID] }),
      },
      {
        id: DEVELOPMENT_PROFILE_ID,
        name: 'development',
        display_name: '开发模式',
        description: 'Agent 派发 + 已纳管的工具 MCP',
        rules: JSON.stringify({ include: ['*'], servers: [BUILTIN_BRIDGE_ID] }),
      },
    ];

    for (const p of profiles) {
      const row = db.prepare('SELECT id FROM mcp_profiles WHERE id = ?').get(p.id);
      if (!row) {
        db.prepare(`
          INSERT INTO mcp_profiles (id, name, display_name, description, rules, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(p.id, p.name, p.display_name, p.description, p.rules, now);
      }
    }

    // Profile ↔ Server 绑定（默认 Profile 均含 bridge）
    for (const profileId of [DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID]) {
      this._linkBuiltinBridgeToProfile(profileId);
    }

    this._seeded = true;
  }

  /** 确保内置 Agent Bridge 存在、启用，并绑定到编排默认 Profile */
  _ensureBuiltinBridge(now = Date.now()) {
    const db = this._getDb();
    const bridge = db.prepare('SELECT id, status, metadata FROM mcp_servers WHERE id = ?').get(BUILTIN_BRIDGE_ID);
    const bridgeMeta = JSON.stringify({
      description: '内置 Agent 派发桥：tb_list_agents / tb_dispatch_agent',
      tools: ['tb_list_agents', 'tb_dispatch_agent'],
    });
    if (!bridge) {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'stdio', ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        BUILTIN_BRIDGE_ID,
        BUILTIN_BRIDGE_ID,
        'Token Bank Agent Bridge',
        '__DYNAMIC_ELECTRON__',
        JSON.stringify([DISPATCH_SCRIPT]),
        JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
        bridgeMeta,
        now,
        now,
      );
    } else {
      // 刷新元数据（去掉误挂在 bridge 上的 tb_get_prompt）并确保 active
      db.prepare('UPDATE mcp_servers SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run('active', bridgeMeta, now, BUILTIN_BRIDGE_ID);
    }

    for (const profileId of [DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID]) {
      this._linkBuiltinBridgeToProfile(profileId);
    }

    return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(BUILTIN_BRIDGE_ID);
  }

  _linkBuiltinBridgeToProfile(profileId) {
    const db = this._getDb();
    const link = db.prepare(
      'SELECT profile_id, enabled FROM mcp_profile_servers WHERE profile_id = ? AND server_id = ?',
    ).get(profileId, BUILTIN_BRIDGE_ID);
    if (!link) {
      db.prepare(`
        INSERT INTO mcp_profile_servers (profile_id, server_id, enabled)
        VALUES (?, ?, 1)
      `).run(profileId, BUILTIN_BRIDGE_ID);
    } else if (!link.enabled) {
      db.prepare(`
        UPDATE mcp_profile_servers SET enabled = 1
        WHERE profile_id = ? AND server_id = ?
      `).run(profileId, BUILTIN_BRIDGE_ID);
    }
  }

  /** 常见 MCP 目录 + 安装状态 */
  listCatalog() {
    this.init();
    const installed = new Map(this.listManagedServers().map(s => [s.id, s]));
    const enrich = (item) => {
      const row = installed.get(item.id);
      return {
        ...item,
        installed: !!row || !!item.alwaysInstalled,
        status: row?.status || (item.alwaysInstalled ? 'active' : 'inactive'),
        server: row || null,
      };
    };
    return listCatalogItems().map(enrich);
  }

  /** 按分类分组的常见 MCP 目录 */
  listCatalogGrouped() {
    this.init();
    const installed = new Map(this.listManagedServers().map(s => [s.id, s]));
    const enrich = (item) => {
      const row = installed.get(item.id);
      return {
        ...item,
        installed: !!row || !!item.alwaysInstalled,
        status: row?.status || (item.alwaysInstalled ? 'active' : 'inactive'),
        server: row || null,
      };
    };
    return listCatalogGrouped().map(group => ({
      ...group,
      items: group.items.map(enrich),
    }));
  }

  /**
   * 从目录一键纳管 MCP Server
   * @param {string} catalogId
   * @param {Record<string,string>} config 用户填写的配置项
   */
  installFromCatalog(catalogId, config = {}) {
    this.init();
    const item = getCatalogItem(catalogId);
    if (!item) throw new Error(`未知 MCP 目录项: ${catalogId}`);
    if (item.alwaysInstalled) {
      return { success: true, server: this.getServer(item.id), alreadyInstalled: true };
    }

    const db = this._getDb();
    const now = Date.now();
    const args = [...(item.args || [])];
    const env = { ...(item.env || {}) };

    for (const field of item.configFields || []) {
      const val = String(config[field.key] ?? field.defaultValue ?? '').trim();
      if (field.appendArg && val) {
        args.push(val);
      }
      if (field.envKey && val) {
        env[field.envKey] = val;
      }
      if (field.required && !val) {
        throw new Error(`请填写: ${field.label}`);
      }
    }

    const command = item.command === 'npx'
      ? (shim.resolveRealCommand('npx') || 'npx')
      : item.command;

    const existing = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(item.id);
    if (existing) {
      db.prepare(`
        UPDATE mcp_servers
        SET command = ?, args = ?, env = ?, status = 'active', metadata = ?, updated_at = ?
        WHERE id = ?
      `).run(
        command,
        JSON.stringify(args),
        JSON.stringify(env),
        JSON.stringify({ ...item.metadata, catalogId: item.catalogId }),
        now,
        item.id,
      );
    } else {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)
      `).run(
        item.id,
        item.name,
        item.display_name,
        item.type,
        command,
        JSON.stringify(args),
        JSON.stringify(env),
        JSON.stringify({ ...item.metadata, catalogId: item.catalogId }),
        now,
        now,
      );
    }

    this._linkServerToProfile(DEVELOPMENT_PROFILE_ID, item.id);
    const sync = this._autoSyncClients();
    return { success: true, server: this.getServer(item.id), sync };
  }

  /** 卸载（非内置）MCP Server */
  uninstallServer(serverId) {
    this.init();
    if (serverId === BUILTIN_BRIDGE_ID) {
      throw new Error('内置 Agent Bridge 不可卸载');
    }
    const db = this._getDb();
    db.prepare('DELETE FROM mcp_profile_servers WHERE server_id = ?').run(serverId);
    db.prepare('DELETE FROM mcp_servers WHERE id = ? AND builtin = 0').run(serverId);
    const sync = this._autoSyncClients();
    return { success: true, sync };
  }

  setServerStatus(serverId, status) {
    this.init();
    const allowed = new Set(['active', 'inactive']);
    if (!allowed.has(status)) throw new Error(`无效状态: ${status}`);
    const db = this._getDb();
    const info = db.prepare('UPDATE mcp_servers SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), serverId);
    if (!info.changes) throw new Error('Server not found');
    const sync = this._autoSyncClients();
    return { success: true, server: this.getServer(serverId), sync };
  }

  /** 保存自定义 / 编辑 MCP Server */
  saveServer(data) {
    this.init();
    const db = this._getDb();
    const now = Date.now();
    const id = data.id || `mcp-custom-${Date.now()}`;
    if (data.id === BUILTIN_BRIDGE_ID) throw new Error('不可修改内置 Bridge');

    const existing = db.prepare('SELECT id, builtin, metadata, status, type FROM mcp_servers WHERE id = ?').get(id);
    if (existing?.builtin) throw new Error('内置 Server 不可覆盖');

    const prevMeta = this._parseJson(existing?.metadata, {});
    const nextMeta = { ...prevMeta, ...(data.metadata || {}) };
    // 未显式传入时保留原 sync_clients
    if (data.metadata?.sync_clients === undefined && Array.isArray(prevMeta.sync_clients)) {
      nextMeta.sync_clients = prevMeta.sync_clients;
    }

    const type = data.type || existing?.type || 'stdio';
    const payload = {
      name: String(data.name || id).trim(),
      display_name: String(data.display_name || data.name || id).trim(),
      type,
      command: String(data.command ?? '').trim(),
      args: JSON.stringify(Array.isArray(data.args) ? data.args : []),
      url: data.url != null && String(data.url).trim() ? String(data.url).trim() : null,
      env: JSON.stringify(data.env && typeof data.env === 'object' ? data.env : {}),
      status: data.status || existing?.status || 'active',
      metadata: JSON.stringify(nextMeta),
    };

    if (payload.type === 'stdio' && !payload.command) {
      throw new Error('stdio 类型需填写 command');
    }
    if ((payload.type === 'sse' || payload.type === 'http') && !payload.url) {
      throw new Error('URL 类型需填写 url');
    }

    if (existing) {
      db.prepare(`
        UPDATE mcp_servers
        SET name = ?, display_name = ?, type = ?, command = ?, args = ?, url = ?, env = ?,
            status = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `).run(
        payload.name, payload.display_name, payload.type, payload.command,
        payload.args, payload.url, payload.env, payload.status, payload.metadata, now, id,
      );
    } else {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, url, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        id, payload.name, payload.display_name, payload.type, payload.command,
        payload.args, payload.url, payload.env, payload.status, payload.metadata, now, now,
      );
    }

    let sync = null;
    if (!data.skipAutoSync) {
      if (data.syncInstalled) {
        // 仅推送到已分配 / 已安装的 Agent
        const enriched = this.listManagedServers().find(s => s.id === id);
        const clientIds = [...new Set([
          ...(enriched?.sync_clients || []),
          ...(enriched?.clientTargets || []).filter(c => c.installed).map(c => c.id),
        ])];
        if (clientIds.length) {
          // 保证 filterServersForClient 能下发：把目标写入 sync_clients
          const prev = enriched?.sync_clients || [];
          const merged = [...new Set([...prev, ...clientIds])];
          if (merged.length !== prev.length) {
            this._persistServerSyncClients(id, merged);
          }
          sync = this.syncToClients({ clientIds });
        } else {
          sync = { success: true, results: [], skipped: true };
        }
      } else {
        sync = this._autoSyncClients();
      }
    }
    return { success: true, server: this.getServer(id), sync };
  }

  /** 更新 Profile 绑定的 Server 列表 */
  saveProfile(profileId, { serverIds, display_name, description, rules } = {}) {
    this.init();
    const db = this._getDb();
    const profile = db.prepare('SELECT id FROM mcp_profiles WHERE id = ?').get(profileId);
    if (!profile) throw new Error('Profile not found');

    if (display_name != null || description != null || rules != null) {
      const row = db.prepare('SELECT * FROM mcp_profiles WHERE id = ?').get(profileId);
      db.prepare(`
        UPDATE mcp_profiles
        SET display_name = ?, description = ?, rules = ?
        WHERE id = ?
      `).run(
        display_name ?? row.display_name,
        description ?? row.description,
        rules != null ? JSON.stringify(rules) : row.rules,
        profileId,
      );
    }

    if (Array.isArray(serverIds)) {
      // bridge 必须保留在 orchestrator profiles
      const ids = [...new Set(serverIds)];
      if ([DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID].includes(profileId)) {
        if (!ids.includes(BUILTIN_BRIDGE_ID)) ids.unshift(BUILTIN_BRIDGE_ID);
      }
      db.prepare('DELETE FROM mcp_profile_servers WHERE profile_id = ?').run(profileId);
      const insert = db.prepare(`
        INSERT INTO mcp_profile_servers (profile_id, server_id, enabled) VALUES (?, ?, 1)
      `);
      for (const sid of ids) {
        const srv = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(sid);
        if (srv) insert.run(profileId, sid);
      }
    }

    return { success: true, profile: this.getProfile(profileId) };
  }

  _linkServerToProfile(profileId, serverId) {
    const db = this._getDb();
    const link = db.prepare(
      'SELECT profile_id FROM mcp_profile_servers WHERE profile_id = ? AND server_id = ?',
    ).get(profileId, serverId);
    if (!link) {
      db.prepare(`
        INSERT INTO mcp_profile_servers (profile_id, server_id, enabled)
        VALUES (?, ?, 1)
      `).run(profileId, serverId);
    }
  }

  /** 同步已纳管 MCP 到 Agent 客户端（可按 Agent / MCP 分别指定） */
  syncToClients(options = {}) {
    this.init();
    const mcpClientSync = require('./mcp-client-sync');
    const { serverIds, clientIds } = options;

    // 勾选 MCP + 目标 Agent：以本次勾选为准整体替换 sync_clients（取消勾选 = 从该 Agent 移除）
    if (Array.isArray(serverIds) && serverIds.length && Array.isArray(clientIds)) {
      const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
      const allowed = new Set(listSyncEnabledClientIds());
      const agents = clientIds.filter(id => allowed.has(id));
      for (const serverId of serverIds) {
        if (serverId === BUILTIN_BRIDGE_ID) continue;
        const server = this.getServer(serverId);
        if (!server || server.status !== 'active') continue;
        this._persistServerSyncClients(serverId, agents);
      }
      // 全量重写各 Agent 配置，确保被取消勾选的 Agent 也会删掉条目
      return mcpClientSync.syncAll(this.listManagedServers(), {});
    }

    return mcpClientSync.syncAll(this.listManagedServers(), options);
  }

  /** 仅更新 metadata.sync_clients，不触发同步 */
  _persistServerSyncClients(serverId, clientIds) {
    const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
    const allowed = new Set(listSyncEnabledClientIds());
    const ids = [...new Set((clientIds || []).filter(id => allowed.has(id)))];

    const db = this._getDb();
    const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(serverId);
    if (!row) throw new Error('Server not found');

    const metadata = { ...this._parseJson(row.metadata, {}), sync_clients: ids };
    db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), Date.now(), serverId);
  }

  /** 设置 MCP 同步到哪些 Agent（可分别指定）；未传 syncClientIds 时同步「旧+新」相关 Agent，确保取消勾选的会被移除 */
  setServerSyncClients(serverId, clientIds, options = {}) {
    this.init();
    if (serverId === BUILTIN_BRIDGE_ID) {
      throw new Error('内置 Bridge 不参与 Agent 同步');
    }
    const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
    const allowed = new Set(listSyncEnabledClientIds());
    const ids = [...new Set((clientIds || []).filter(id => allowed.has(id)))];

    const prev = this.getServer(serverId)?.sync_clients || [];
    this._persistServerSyncClients(serverId, ids);

    // 同步旧分配 ∪ 新分配，使取消勾选的 Agent 配置被重写并删掉该 MCP
    const affected = Array.isArray(options.syncClientIds) && options.syncClientIds.length
      ? options.syncClientIds.filter(id => allowed.has(id))
      : [...new Set([...prev, ...ids])];
    const sync = this.syncToClients(
      affected.length ? { clientIds: affected } : {},
    );
    return { success: true, server: this.getServer(serverId), sync };
  }

  /** 切换某 MCP 是否同步到指定 Agent */
  toggleServerSyncClient(serverId, clientId) {
    this.init();
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    const set = new Set(server.sync_clients || []);
    if (set.has(clientId)) set.delete(clientId);
    else set.add(clientId);
    return this.setServerSyncClients(serverId, [...set], { syncClientIds: [clientId] });
  }

  /**
   * 从指定 Agent 移除此 MCP（不影响 Token Bank 纳管及其他 Agent）
   * @param {string} serverId 已纳管 MCP id；客户端自配时可省略
   * @param {string} clientId Agent id
   * @param {string} [clientKey] 客户端配置键名
   */
  removeFromAgent({ serverId, clientId, clientKey, external = false }) {
    this.init();
    const mcpClientSync = require('./mcp-client-sync');
    const key = String(clientKey || '').trim();

    // 客户端自配 MCP：直接从 Agent 配置文件删除
    if (external || !serverId || String(serverId).startsWith('client-external:')) {
      if (!key) throw new Error('缺少 clientKey');
      const result = mcpClientSync.removeRawClientMcpEntry(clientId, key);
      return { success: true, ...result };
    }

    if (serverId === BUILTIN_BRIDGE_ID) {
      throw new Error('内置 Bridge 不可移除');
    }

    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');

    const resolvedKey = key
      || server.clientInstalls?.find(i => i.clientId === clientId)?.clientKey
      || server.name;

    // 取消 Token Bank 对该 Agent 的同步分配并重写配置
    const set = new Set(server.sync_clients || []);
    set.delete(clientId);
    this.setServerSyncClients(serverId, [...set], { syncClientIds: [clientId] });

    // 若客户端里仍有同名自配条目（非 TB 写入），一并删除
    try {
      mcpClientSync.removeRawClientMcpEntry(clientId, resolvedKey, { ignoreMissing: true });
    } catch (e) {
      console.warn('[mcp-manager] remove raw client entry:', e.message);
    }

    return { success: true, server: this.getServer(serverId) };
  }

  getClientSyncStatus() {
    return require('./mcp-client-sync').getSyncStatus();
  }

  /** 各 Agent 配置文件中的 MCP 安装情况（含 TB 同步 / 扫描 / 客户端自配） */
  listAgentInstallations() {
    this.init();
    // 与 listServers 一致：先扫描即纳管，再汇总各 Agent 安装情况
    this.syncDiscoveredMcps();
    const agents = require('./mcp-client-sync').listAgentInstallations(this.listManagedServers());
    return { agents };
  }

  _autoSyncClients() {
    try {
      return this.syncToClients();
    } catch (e) {
      console.warn('[mcp-manager] auto sync clients failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  /** Token Bank 数据库中已纳管的 MCP（不含客户端自配） */
  listManagedServers() {
    this.init();
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id, name, display_name, type, command, args, url, env, builtin, status, metadata, created_at, updated_at
      FROM mcp_servers
      ORDER BY builtin DESC, display_name ASC, name ASC
    `).all().map(row => this._formatServerRow(row));
    const { enrichServersWithClientInstalls } = require('./mcp-client-sync');
    return enrichServersWithClientInstalls(rows);
  }

  /**
   * 将 Agent 上扫描到的 MCP 纳管进 Token Bank（不改动该 Agent 原配置、不自动同步到其他 Agent）
   * 纳管后可在「已纳管」页选择安装到其他 Agent
   */
  importFromAgent({ clientId, clientKey, originAgents }) {
    this.init();
    const key = String(clientKey || '').trim();
    if (!clientId || !key) throw new Error('缺少 clientId 或 clientKey');

    const {
      getClientMcpEntryForAgent,
      inferClientMcpDescription,
      CLIENT_TARGETS,
    } = require('./mcp-client-sync');
    const found = getClientMcpEntryForAgent(clientId, key);
    if (!found) {
      const label = CLIENT_TARGETS[clientId]?.label || clientId;
      throw new Error(`未在 ${label} 配置中找到 MCP: ${key}`);
    }

    const db = this._getDb();
    const existing = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(key);
    if (existing) {
      return {
        success: true,
        server: this.getServer(existing.id),
        alreadyInstalled: true,
        hint: '该 MCP 已在 Token Bank 纳管；可在「已纳管」页安装到其他 Agent。',
      };
    }

    const agents = [...new Set(
      (Array.isArray(originAgents) && originAgents.length ? originAgents : [clientId])
        .map(id => String(id || '').trim())
        .filter(Boolean),
    )];

    const safeId = `mcp-import-${key.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}`;
    const result = this.saveServer({
      id: safeId,
      name: key,
      display_name: key,
      type: found.entry.url ? (found.entry.type === 'http' ? 'http' : 'sse') : 'stdio',
      command: found.entry.command || '',
      args: found.entry.args,
      env: found.entry.env,
      url: found.entry.url,
      skipAutoSync: true,
      metadata: {
        category: 'imported',
        origin: 'client_scan',
        importedFrom: key,
        originAgents: agents,
        // 空列表：不自动推送到其他 Agent，保留各客户端原配置
        sync_clients: [],
        description: inferClientMcpDescription(found.entry),
        ...(found.entry.headers ? { headers: found.entry.headers } : {}),
      },
    });
    this._linkServerToProfile(DEVELOPMENT_PROFILE_ID, safeId);
    return {
      ...result,
      alreadyInstalled: false,
      hint: '已纳管客户端 MCP。本 Agent 保留原配置；可在「已纳管」页安装到其他 Agent。',
    };
  }

  /**
   * 扫描即纳管：把各 Agent 配置里尚未入库的 MCP 静默导入 Token Bank。
   * 不改写客户端配置、不同步到其他 Agent；用 origin=client_scan 与 TB 安装区分。
   */
  syncDiscoveredMcps() {
    this.init();
    const { discoverExternalMcps } = require('./mcp-client-sync');
    const external = discoverExternalMcps(this.listManagedServers());
    let imported = 0;
    for (const ext of external) {
      const clients = ext.clientInstalls || [];
      if (!clients.length) continue;
      try {
        const res = this.importFromAgent({
          clientId: clients[0].clientId,
          clientKey: ext.name,
          originAgents: clients.map(c => c.clientId),
        });
        if (res.success && !res.alreadyInstalled) imported += 1;
      } catch (e) {
        console.warn(`[mcp-manager] syncDiscovered ${ext.name}:`, e.message);
      }
    }
    return { success: true, imported, total: external.length };
  }

  /** 已纳管 MCP（扫描即纳管后返回最新列表） */
  listServers() {
    this.syncDiscoveredMcps();
    return this.listManagedServers();
  }

  /** 将客户端自配 MCP 导入 Token Bank（取首个匹配的 Agent） */
  importFromClient(clientKey) {
    this.init();
    const key = String(clientKey || '').trim();
    if (!key) throw new Error('缺少 clientKey');

    const { getClientMcpEntry } = require('./mcp-client-sync');
    const found = getClientMcpEntry(key);
    if (!found) throw new Error(`未在客户端配置中找到 MCP: ${key}`);
    return this.importFromAgent({ clientId: found.clientId, clientKey: key });
  }

  getServer(serverId) {
    this.init();
    const db = this._getDb();
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId);
    return row ? this._formatServerRow(row) : null;
  }

  listProfiles() {
    this.init();
    const db = this._getDb();
    const profiles = db.prepare(`
      SELECT id, name, display_name, description, rules, created_at
      FROM mcp_profiles
      ORDER BY name ASC
    `).all();

    return profiles.map(p => ({
      ...p,
      rules: this._parseJson(p.rules, {}),
      servers: this._getProfileServerIds(p.id),
    }));
  }

  getProfile(profileId) {
    this.init();
    const db = this._getDb();
    const row = db.prepare('SELECT * FROM mcp_profiles WHERE id = ?').get(profileId);
    if (!row) return null;
    return {
      ...row,
      rules: this._parseJson(row.rules, {}),
      servers: this._getProfileServerIds(row.id),
    };
  }

  /** 是否支持编排模式 */
  supportsOrchestrator(agentId) {
    return ORCHESTRATOR_AGENTS.has(agentId);
  }

  /**
   * 为编排任务生成 Agent 启动参数
   * @returns {{ extraArgs: string[], promptPrefix?: string, cleanup: Function }}
   */
  buildOrchestratorLaunch({ agentId, taskId, workingDir, mainAgentId, profileId = DEFAULT_PROFILE_ID, sessionKey, sessionInstanceId }) {
    this.init();
    this._ensureBuiltinBridge();

    if (!this.supportsOrchestrator(agentId)) {
      throw new Error(`编排模式暂不支持 Agent: ${agentId}`);
    }

    const servers = this._resolveProfileServers(profileId);
    if (!servers.length) {
      throw new Error(`MCP Profile 未包含任何 Server: ${profileId}`);
    }

    const mcpDir = path.join(os.homedir(), '.tokenbank', 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    const cleanupFns = [];
    const ctx = { taskId, workingDir, mainAgentId, sessionKey, sessionInstanceId };
    // bridge / prompts 用 shell 脚本保证 ELECTRON_RUN_AS_NODE，避免 Electron 子进程 GUI 初始化崩溃
    ctx.bridgeLauncher = writeBridgeMcpLauncher({ ...ctx, mcpDir });
    cleanupFns.push(() => { try { fs.unlinkSync(ctx.bridgeLauncher); } catch {} });
    if (servers.some(s => s.id === BUILTIN_PROMPTS_ID || s.name === BUILTIN_PROMPTS_ID)) {
      ctx.promptsLauncher = writeElectronAsNodeLauncher({
        name: `prompts-orch-${taskId}`,
        scriptPath: PROMPTS_SCRIPT,
        env: { TB_CLIENT_ID: mainAgentId || '' },
      });
      cleanupFns.push(() => { try { fs.unlinkSync(ctx.promptsLauncher); } catch {} });
    }

    if (agentId === 'claude-code') {
      const mcpServers = {};
      for (const srv of servers) {
        mcpServers[srv.name] = this._buildRuntimeServerConfig(srv, ctx);
      }

      const configPath = path.join(mcpDir, `orch-${taskId}.json`);
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
      cleanupFns.push(() => { try { fs.unlinkSync(configPath); } catch {} });

      return {
        extraArgs: [
          '-p',
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          '--verbose',
          '--strict-mcp-config',
          '--mcp-config', configPath,
          '--append-system-prompt', ORCHESTRATOR_SYSTEM,
        ],
        cleanup: () => cleanupFns.forEach(fn => fn()),
      };
    }

    if (agentId === 'codex') {
      // Codex 新版 CLI 不再支持 --enable mcp（会报 Unknown feature flag: mcp 并以 code 1 退出）。
      // MCP 通过 config.toml 的 [mcp_servers.*] 段加载；这里写入临时 profile 供 exec -p 叠加。
      const profileName = `tokenbank-orch-${taskId}`;
      const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      const profilePath = path.join(codexHome, `${profileName}.config.toml`);
      const toml = buildCodexOrchestratorProfileToml(servers, ctx, (srv) => this._buildRuntimeServerConfig(srv, ctx));
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(profilePath, toml, 'utf8');
      cleanupFns.push(() => { try { fs.unlinkSync(profilePath); } catch {} });

      const extraArgs = ['exec'];
      if (workingDir) extraArgs.push('--cd', workingDir);
      // exec 无 --ask-for-approval；bypass 对齐 Claude skip-permissions
      extraArgs.push(
        '--dangerously-bypass-approvals-and-sandbox',
        '--json', '--skip-git-repo-check', '-p', profileName,
      );

      return {
        extraArgs,
        promptPrefix: `${ORCHESTRATOR_SYSTEM}\n\n`,
        cleanup: () => cleanupFns.forEach(fn => fn()),
      };
    }

    throw new Error(`Unsupported orchestrator agent: ${agentId}`);
  }

  _getProfileServerIds(profileId) {
    const db = this._getDb();
    return db.prepare(`
      SELECT s.id, s.name, s.display_name, s.type, s.builtin, s.status
      FROM mcp_profile_servers ps
      JOIN mcp_servers s ON s.id = ps.server_id
      WHERE ps.profile_id = ? AND ps.enabled = 1
      ORDER BY s.builtin DESC, s.display_name ASC
    `).all(profileId);
  }

  _resolveProfileServers(profileId) {
    const db = this._getDb();
    const profile = db.prepare('SELECT id FROM mcp_profiles WHERE id = ?').get(profileId);
    const effectiveId = profile ? profileId : DEFAULT_PROFILE_ID;

    const servers = db.prepare(`
      SELECT s.*
      FROM mcp_profile_servers ps
      JOIN mcp_servers s ON s.id = ps.server_id
      WHERE ps.profile_id = ? AND ps.enabled = 1 AND s.status = 'active'
      ORDER BY s.builtin DESC, s.name ASC
    `).all(effectiveId);

    // 编排层内置 bridge 始终默认启动（即使用户 Profile 未勾选）
    const bridge = this._ensureBuiltinBridge();
    if (bridge && !servers.some(s => s.id === BUILTIN_BRIDGE_ID)) {
      return [bridge, ...servers];
    }
    return servers;
  }

  /** 运行时 Server 配置（内置 bridge 注入 task 上下文） */
  _buildRuntimeServerConfig(serverRow, ctx) {
    const { taskId, workingDir, mainAgentId, sessionKey, sessionInstanceId } = ctx;
    const baseEnv = this._parseJson(serverRow.env, {});

    if (serverRow.id === BUILTIN_BRIDGE_ID || serverRow.name === BUILTIN_BRIDGE_ID) {
      // 编排模式优先走 shell launcher（env 写在脚本内，Codex MCP 子进程更可靠）
      if (ctx.bridgeLauncher) {
        return {
          command: ctx.bridgeLauncher,
          args: [],
          env: {},
        };
      }
      return {
        command: resolveElectronBinary(),
        args: [DISPATCH_SCRIPT],
        env: {
          ...baseEnv,
          ELECTRON_RUN_AS_NODE: '1',
          TB_PARENT_TASK_ID: taskId || '',
          TB_PARENT_SESSION_KEY: sessionKey || '',
          TB_PARENT_SESSION_INSTANCE: sessionInstanceId || '',
          TB_WORKING_DIR: workingDir || process.cwd(),
          TB_MAIN_AGENT_ID: mainAgentId || '',
          TB_CLIENT_ID: mainAgentId || '',
        },
      };
    }

    if (serverRow.id === BUILTIN_PROMPTS_ID || serverRow.name === BUILTIN_PROMPTS_ID) {
      if (ctx.promptsLauncher) {
        return { command: ctx.promptsLauncher, args: [], env: {} };
      }
      return {
        command: writeElectronAsNodeLauncher({
          name: `prompts-${mainAgentId || 'default'}`,
          scriptPath: PROMPTS_SCRIPT,
          env: { TB_CLIENT_ID: mainAgentId || '' },
        }),
        args: [],
        env: {},
      };
    }

    let command = serverRow.command;
    if (command === 'npx') {
      command = shim.resolveRealCommand('npx') || 'npx';
    }

    return {
      command,
      args: this._parseJson(serverRow.args, []),
      env: { ...baseEnv },
    };
  }

  _formatServerRow(row) {
    const metadata = this._parseJson(row.metadata, {});
    const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
    const syncDefaults = listSyncEnabledClientIds();
    const sync_clients = Array.isArray(metadata.sync_clients)
      ? metadata.sync_clients.filter(id => syncDefaults.includes(id))
      : syncDefaults;

    return {
      ...row,
      args: this._parseJson(row.args, []),
      env: this._parseJson(row.env, {}),
      metadata,
      sync_clients,
      builtin: !!row.builtin,
    };
  }

  _parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }
}

module.exports = new MCPManager();
module.exports.ORCHESTRATOR_SYSTEM = ORCHESTRATOR_SYSTEM;
module.exports.DEFAULT_PROFILE_ID = DEFAULT_PROFILE_ID;
module.exports.DEVELOPMENT_PROFILE_ID = DEVELOPMENT_PROFILE_ID;
module.exports.BUILTIN_BRIDGE_ID = BUILTIN_BRIDGE_ID;
module.exports.BUILTIN_PROMPTS_ID = BUILTIN_PROMPTS_ID;
module.exports.buildCodexOrchestratorProfileToml = buildCodexOrchestratorProfileToml;
module.exports.writeBridgeMcpLauncher = writeBridgeMcpLauncher;
module.exports.writeElectronAsNodeLauncher = writeElectronAsNodeLauncher;
module.exports.resolveElectronBinary = resolveElectronBinary;
module.exports.shellQuote = shellQuote;
