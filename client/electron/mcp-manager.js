// client/electron/mcp-manager.js
// MCP 供给源管理：Server 注册、Profile 裁剪、编排模式配置生成
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const localStats = require('./local-stats');
const shim = require('./shim-installer');
const { getCatalogItem, listCatalogItems, listCatalogGrouped, MCP_CATEGORY_GROUPS } = require('./mcp-catalog');

/** 编排层系统提示（Claude / Codex 共用） */
const ORCHESTRATOR_SYSTEM = [
  '你是 Token Bank 聚合入口的主 Agent（编排层）。',
  '协调其他已纳管 Agent 完成用户任务。',
  '规则：',
  '1. 禁止在 shell 中直接运行 codex/claude/gemini 等 CLI（which/npm install 都不行）。',
  '2. 必须使用 MCP 工具 tb_list_agents 查看可派发 Agent。',
  '3. 必须使用 tb_dispatch_agent(agent_id, prompt) 派发子任务并等待结果。',
  '4. 汇总子 Agent 输出后回复用户。',
].join('\n');

/** 支持 MCP 编排的主 Agent */
const ORCHESTRATOR_AGENTS = new Set(['claude-code', 'codex']);

const BUILTIN_BRIDGE_ID = 'tokenbank-agent-bridge';
const DEFAULT_PROFILE_ID = 'orchestrator-default';
const DEVELOPMENT_PROFILE_ID = 'development';
const DISPATCH_SCRIPT = path.join(__dirname, 'agent-dispatch-mcp.js');

class MCPManager {
  constructor() {
    this._seeded = false;
  }

  _getDb() {
    const db = localStats.getDb();
    if (!db) throw new Error('Database not initialized');
    return db;
  }

  /** 初始化内置 MCP Server 与默认 Profile（幂等） */
  init() {
    if (this._seeded) return;
    const db = this._getDb();
    const now = Date.now();

    const bridge = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(BUILTIN_BRIDGE_ID);
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
        JSON.stringify({
          description: '内置 Agent 派发桥：tb_list_agents / tb_dispatch_agent',
          tools: ['tb_list_agents', 'tb_dispatch_agent'],
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
      const link = db.prepare(
        'SELECT profile_id FROM mcp_profile_servers WHERE profile_id = ? AND server_id = ?',
      ).get(profileId, BUILTIN_BRIDGE_ID);
      if (!link) {
        db.prepare(`
          INSERT INTO mcp_profile_servers (profile_id, server_id, enabled)
          VALUES (?, ?, 1)
        `).run(profileId, BUILTIN_BRIDGE_ID);
      }
    }

    this._seeded = true;
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

  /** 保存自定义 MCP Server */
  saveServer(data) {
    this.init();
    const db = this._getDb();
    const now = Date.now();
    const id = data.id || `mcp-custom-${Date.now()}`;
    if (data.id === BUILTIN_BRIDGE_ID) throw new Error('不可修改内置 Bridge');

    const payload = {
      name: String(data.name || id).trim(),
      display_name: String(data.display_name || data.name || id).trim(),
      type: data.type || 'stdio',
      command: String(data.command || '').trim(),
      args: JSON.stringify(Array.isArray(data.args) ? data.args : []),
      url: data.url || null,
      env: JSON.stringify(data.env || {}),
      status: data.status || 'active',
      metadata: JSON.stringify(data.metadata || { category: 'custom' }),
    };

    if (!payload.command && payload.type === 'stdio') {
      throw new Error('stdio 类型需填写 command');
    }

    const existing = db.prepare('SELECT id, builtin FROM mcp_servers WHERE id = ?').get(id);
    if (existing?.builtin) throw new Error('内置 Server 不可覆盖');

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

    const sync = data.skipAutoSync ? null : this._autoSyncClients();
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

    // 勾选 MCP + 目标 Agent：先合并 sync_clients，再写入配置文件
    if (Array.isArray(serverIds) && serverIds.length && Array.isArray(clientIds) && clientIds.length) {
      const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
      const allowed = new Set(listSyncEnabledClientIds());
      const agents = clientIds.filter(id => allowed.has(id));
      for (const serverId of serverIds) {
        if (serverId === BUILTIN_BRIDGE_ID) continue;
        const server = this.getServer(serverId);
        if (!server || server.status !== 'active') continue;
        const merged = [...new Set([...(server.sync_clients || []), ...agents])];
        this._persistServerSyncClients(serverId, merged);
      }
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

  /** 设置 MCP 同步到哪些 Agent（可分别指定） */
  setServerSyncClients(serverId, clientIds, options = {}) {
    this.init();
    if (serverId === BUILTIN_BRIDGE_ID) {
      throw new Error('内置 Bridge 不参与 Agent 同步');
    }
    const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
    const allowed = new Set(listSyncEnabledClientIds());
    const ids = [...new Set((clientIds || []).filter(id => allowed.has(id)))];

    this._persistServerSyncClients(serverId, ids);

    const sync = this.syncToClients(
      options.syncClientIds ? { clientIds: options.syncClientIds } : {},
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

  /** 已纳管 MCP（不含客户端自配、未纳管项） */
  listServers() {
    return this.listManagedServers();
  }

  /**
   * 将 Agent 上扫描到的 MCP 纳管进 Token Bank（不改动该 Agent 原配置、不自动同步到其他 Agent）
   * 纳管后可在「已纳管」页选择安装到其他 Agent
   */
  importFromAgent({ clientId, clientKey }) {
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

    const safeId = `mcp-import-${key.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}`;
    const result = this.saveServer({
      id: safeId,
      name: key,
      display_name: key,
      type: found.entry.url ? 'sse' : 'stdio',
      command: found.entry.command,
      args: found.entry.args,
      env: found.entry.env,
      url: found.entry.url,
      skipAutoSync: true,
      metadata: {
        category: 'imported',
        importedFrom: key,
        originAgents: [clientId],
        sync_clients: [],
        description: inferClientMcpDescription(found.entry),
      },
    });
    this._linkServerToProfile(DEVELOPMENT_PROFILE_ID, safeId);
    return {
      ...result,
      alreadyInstalled: false,
      hint: '已纳管客户端 MCP。本 Agent 保留原配置；可在「已纳管」页安装到其他 Agent。',
    };
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
  buildOrchestratorLaunch({ agentId, taskId, workingDir, mainAgentId, profileId = DEFAULT_PROFILE_ID }) {
    this.init();

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

    if (agentId === 'claude-code') {
      const mcpServers = {};
      for (const srv of servers) {
        mcpServers[srv.name] = this._buildRuntimeServerConfig(srv, { taskId, workingDir, mainAgentId });
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
      const extraArgs = ['exec', '--enable', 'mcp'];
      for (const srv of servers) {
        const cfg = this._buildRuntimeServerConfig(srv, { taskId, workingDir, mainAgentId });
        const name = srv.name;
        extraArgs.push('-c', `mcp_servers.${name}.command=${JSON.stringify(cfg.command)}`);
        extraArgs.push('-c', `mcp_servers.${name}.args=${JSON.stringify(cfg.args)}`);
        for (const [k, v] of Object.entries(cfg.env || {})) {
          extraArgs.push('-c', `mcp_servers.${name}.env.${k}=${JSON.stringify(String(v))}`);
        }
      }

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

    return db.prepare(`
      SELECT s.*
      FROM mcp_profile_servers ps
      JOIN mcp_servers s ON s.id = ps.server_id
      WHERE ps.profile_id = ? AND ps.enabled = 1 AND s.status = 'active'
      ORDER BY s.builtin DESC, s.name ASC
    `).all(effectiveId);
  }

  /** 运行时 Server 配置（内置 bridge 注入 task 上下文） */
  _buildRuntimeServerConfig(serverRow, ctx) {
    const { taskId, workingDir, mainAgentId } = ctx;
    const baseEnv = this._parseJson(serverRow.env, {});

    if (serverRow.id === BUILTIN_BRIDGE_ID || serverRow.name === BUILTIN_BRIDGE_ID) {
      return {
        command: process.execPath,
        args: [DISPATCH_SCRIPT],
        env: {
          ...baseEnv,
          ELECTRON_RUN_AS_NODE: '1',
          TB_PARENT_TASK_ID: taskId || '',
          TB_WORKING_DIR: workingDir || process.cwd(),
          TB_MAIN_AGENT_ID: mainAgentId || '',
        },
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
