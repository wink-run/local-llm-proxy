// client/electron/resource-manager.js
// Prompt / Skill / Assistant 统一纳管与投射
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const localStats = require('./local-stats');
const { STATS_DIR } = require('../shared/telemetry');
const {
  getCatalogItem,
  listCatalogItems,
  listCatalogGrouped,
  RESOURCE_TYPE_LABELS,
} = require('./resource-catalog');
const { projectResource, unprojectResource, verifyProjection } = require('./resource-projector');
const {
  resolveAuthorityDir,
  syncSkillContentToAuthority,
  normalizeSkillDirPath,
  copyDirRecursive,
} = require('./resource-canonical');
const {
  AGENT_RESOURCE_TARGETS,
  listProjectableAgentIds,
  listPromptProjectableAgentIds,
} = require('./resource-agent-targets');
const {
  scanAllAgentSkills,
  buildAgentSkillScanIndex,
  removeRawAgentSkill,
  groupDiscoveredSkills,
  findScanGroupByScanKey,
  hashContent: scanHashContent,
} = require('./resource-skill-scanner');
const { parseAssistantConfig, formatAssistantContent, assistantContentNeedsMigration, resolveAssistantRuntimeAgent, withAssistantRuntimeAgent } = require('./resource-assistant');

/**
 * 按模板智能填充参数：正文含 $ARGUMENTS → 全部替换为参数；不含 → 参数非空时以分隔线追加。
 * 纯函数，供 resolvePrompt 与单测直接使用。
 */
function applyPromptArguments(body, argString) {
  const text = String(body || '');
  const args = typeof argString === 'string' ? argString.trim() : '';
  if (text.includes('$ARGUMENTS')) {
    return text.split('$ARGUMENTS').join(args);
  }
  return args ? `${text}\n\n---\n\n${args}` : text;
}

class ResourceManager {
  constructor() {
    this._ready = false;
    /** 最近一次扫描参数，供纳管时定位 Skill */
    this._lastScanOptions = { scanScope: 'global', customDirs: [] };
  }

  _getDb() {
    return localStats.requireDb(STATS_DIR);
  }

  init() {
    if (this._ready) return;
    this._getDb();
    this._ready = true;
  }

  _parseJson(raw, fallback = {}) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  _hashContent(content) {
    return crypto.createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16);
  }

  /** Skill：登记权威目录（用户安装位置），必要时同步 SKILL.md */
  _persistSkillAuthority(resourceId, resource, options = {}) {
    if (!resource || resource.type !== 'skill') return null;

    const meta = { ...(resource.metadata || {}) };
    if (options.authorityPath) {
      meta.authorityPath = normalizeSkillDirPath(options.authorityPath, resource.name)
        || options.authorityPath;
      delete meta.canonicalPath;
    } else if (options.sourceDir) {
      meta.authorityPath = normalizeSkillDirPath(options.sourceDir, resource.name) || options.sourceDir;
      meta.scannedFrom = meta.authorityPath;
      delete meta.canonicalPath;
    }

    const authorityDir = resolveAuthorityDir({ ...resource, metadata: meta });
    if (authorityDir && resource.content != null && options.syncContent) {
      syncSkillContentToAuthority(authorityDir, resource.content);
      meta.authorityPath = authorityDir;
    }

    const db = this._getDb();
    db.prepare('UPDATE resources SET metadata = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(meta),
      Date.now(),
      resourceId,
    );
    return authorityDir || meta.authorityPath || null;
  }

  _mergeAuthorityMetadata(resource, patch = {}) {
    return {
      ...resource,
      metadata: { ...(resource.metadata || {}), ...patch },
    };
  }

  _rowToResource(row) {
    if (!row) return null;
    const resource = {
      id: row.id,
      type: row.type,
      name: row.name,
      display_name: row.display_name || row.name,
      description: row.description || '',
      content: row.content || '',
      metadata: this._parseJson(row.metadata, {}),
      source: row.source || 'local',
      source_url: row.source_url || null,
      hash: row.hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (resource.type === 'skill') {
      resource.authorityPath = resolveAuthorityDir(resource);
    }
    if (resource.type === 'assistant') {
      return this._ensureAssistantContentFormat(resource);
    }
    return resource;
  }

  /** 读取时自动将 system_prompt 迁移为 soul 并写回库 */
  _ensureAssistantContentFormat(resource) {
    if (!resource || resource.type !== 'assistant') return resource;
    if (!assistantContentNeedsMigration(resource.content)) return resource;

    const content = formatAssistantContent(resource.content);
    const now = Date.now();
    const hash = this._hashContent(content);
    this._getDb().prepare(`
      UPDATE resources SET content = ?, hash = ?, updated_at = ? WHERE id = ?
    `).run(content, hash, now, resource.id);

    return { ...resource, content, hash, updated_at: now };
  }

  _getProjections(resourceId) {
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT * FROM resource_projections WHERE resource_id = ? ORDER BY created_at DESC
    `).all(resourceId);
    return rows.map(r => ({
      id: r.id,
      resourceId: r.resource_id,
      agentId: r.agent_id,
      scope: r.scope,
      projectionType: r.projection_type,
      targetPath: r.target_path,
      status: r.status,
      createdAt: r.created_at,
      label: AGENT_RESOURCE_TARGETS[r.agent_id]?.label || r.agent_id,
    }));
  }

  listCatalog(filters = {}) {
    this.init();
    const items = listCatalogItems(filters).map(item => {
      const installed = this._findByTypeName(item.type, item.name);
      return {
        ...item,
        installed: !!installed,
        resourceId: installed?.id || null,
      };
    });
    return {
      items,
      grouped: listCatalogGrouped(),
      typeLabels: RESOURCE_TYPE_LABELS,
    };
  }

  _findByTypeName(type, name) {
    const row = this._getDb().prepare(
      'SELECT * FROM resources WHERE type = ? AND name = ?',
    ).get(type, name);
    return this._rowToResource(row);
  }

  listResources(filters = {}) {
    this.init();
    const db = this._getDb();
    let sql = 'SELECT * FROM resources WHERE type != ?';
    const params = ['template'];

    if (filters.type) {
      sql += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters.query) {
      sql += ' AND (name LIKE ? OR display_name LIKE ? OR description LIKE ?)';
      const q = `%${filters.query}%`;
      params.push(q, q, q);
    }
    sql += ' ORDER BY updated_at DESC';

    const rows = db.prepare(sql).all(...params);
    return rows.map(row => {
      const resource = this._rowToResource(row);
      resource.projections = this._getProjections(resource.id);
      return resource;
    });
  }

  getResource(resourceId) {
    this.init();
    const row = this._getDb().prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
    const resource = this._rowToResource(row);
    if (resource) resource.projections = this._getProjections(resourceId);
    return resource;
  }

  /**
   * 解析提示词引用（触发词后的 `name` 或 `#id`）为展开后的正文。
   * @param {string} ref 提示词 name，或 `#<id>` / 纯 id
   * @param {string} argString 触发词后的参数原文（可空）
   * @returns {{ found: boolean, id?: string, name?: string, text?: string }}
   */
  resolvePrompt(ref, argString = '') {
    this.init();
    const raw = String(ref || '').trim();
    if (!raw) return { found: false };

    let resource = this._findByTypeName('prompt', raw);
    if (!resource) {
      const id = raw.startsWith('#') ? raw.slice(1).trim() : raw;
      const byId = id ? this.getResource(id) : null;
      if (byId && byId.type === 'prompt') resource = byId;
    }
    if (!resource || resource.type !== 'prompt') return { found: false };

    return {
      found: true,
      id: resource.id,
      name: resource.name,
      text: applyPromptArguments(resource.content || '', argString),
    };
  }

  /** 投射给该 client 的 prompt 轻量列表;clientId 为空 → 全部 prompt */
  listPromptsForClient(clientId) {
    this.init();
    const db = this._getDb();
    const cid = String(clientId || '').trim();
    if (!cid) {
      return db.prepare(`
        SELECT id, name, display_name, description FROM resources
        WHERE type = 'prompt' ORDER BY updated_at DESC
      `).all();
    }
    return db.prepare(`
      SELECT DISTINCT r.id, r.name, r.display_name, r.description
      FROM resources r
      JOIN resource_projections ps ON ps.resource_id = r.id
      WHERE r.type = 'prompt' AND ps.agent_id = ?
      ORDER BY r.updated_at DESC
    `).all(cid);
  }

  /** 该 client 是否有 ≥1 条 prompt 投射(决定是否给它下发 prompt MCP) */
  hasPromptProjections(clientId) {
    this.init();
    const cid = String(clientId || '').trim();
    if (!cid) return false;
    const row = this._getDb().prepare(`
      SELECT 1 FROM resource_projections ps
      JOIN resources r ON r.id = ps.resource_id
      WHERE ps.agent_id = ? AND r.type = 'prompt' LIMIT 1
    `).get(cid);
    return !!row;
  }

  /** resolvePrompt + 投射校验:仅当该 prompt 投射给 clientId 才返回;clientId 为空不过滤 */
  resolvePromptForClient(ref, argString = '', clientId = '') {
    const r = this.resolvePrompt(ref, argString);
    if (!r.found) return r;
    const cid = String(clientId || '').trim();
    if (!cid) return r;
    const row = this._getDb().prepare(
      'SELECT 1 FROM resource_projections WHERE resource_id = ? AND agent_id = ? LIMIT 1',
    ).get(r.id, cid);
    return row ? r : { found: false };
  }

  installFromCatalog(catalogId) {
    this.init();
    const item = getCatalogItem(catalogId);
    if (!item) throw new Error('目录项不存在');

    const existing = this._findByTypeName(item.type, item.name);
    if (existing) {
      return { success: true, resource: { ...existing, projections: this._getProjections(existing.id) }, alreadyInstalled: true };
    }

    const now = Date.now();
    const id = `res-${item.type}-${item.name}`;
    const content = item.type === 'assistant'
      ? formatAssistantContent(item.content || '')
      : (item.content || '');
    const db = this._getDb();
    db.prepare(`
      INSERT INTO resources
      (id, type, name, display_name, description, content, metadata, source, source_url, hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'catalog', ?, ?, ?, ?)
    `).run(
      id,
      item.type,
      item.name,
      item.display_name || item.name,
      item.description || '',
      content,
      JSON.stringify(item.metadata || {}),
      `catalog:${catalogId}`,
      this._hashContent(content),
      now,
      now,
    );

    const resource = this.getResource(id);
    return { success: true, resource, alreadyInstalled: false };
  }

  saveResource(data = {}) {
    this.init();
    const db = this._getDb();
    const now = Date.now();
    const type = data.type || 'prompt';
    const name = String(data.name || '').trim();
    if (!name) throw new Error('name 不能为空');

    const id = data.id || `res-${type}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    let content = data.content != null ? String(data.content) : '';
    if (type === 'assistant') content = formatAssistantContent(content);
    const metadata = { ...(data.metadata || {}) };

    const existing = db.prepare('SELECT id, source FROM resources WHERE id = ?').get(id);
    if (!existing) {
      const nameTaken = db.prepare('SELECT id FROM resources WHERE type = ? AND name = ?').get(type, name);
      if (nameTaken) throw new Error(`同名资产已存在: ${name}`);
    }

    if (existing) {
      db.prepare(`
        UPDATE resources SET
          display_name = ?, description = ?, content = ?, metadata = ?, hash = ?, updated_at = ?
        WHERE id = ?
      `).run(
        data.display_name || name,
        data.description || '',
        content,
        JSON.stringify(metadata),
        this._hashContent(content),
        now,
        id,
      );
    } else {
      db.prepare(`
        INSERT INTO resources
        (id, type, name, display_name, description, content, metadata, source, hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        type,
        name,
        data.display_name || name,
        data.description || '',
        content,
        JSON.stringify(metadata),
        data.source || 'local',
        this._hashContent(content),
        now,
        now,
      );
    }

    const saved = this.getResource(id);
    if (saved?.type === 'skill') {
      this._persistSkillAuthority(id, saved, { syncContent: true });
    } else if (saved?.type === 'prompt') {
      // 权威源=DB:MCP 调用时实时读库,编辑后无需重刷任何文件
    }
    return { success: true, resource: this.getResource(id) };
  }

  /** 升级 Skill：同步到已有权威目录的 SKILL.md（软链自动生效） */
  syncSkillCanonical(resourceId) {
    this.init();
    const resource = this.getResource(resourceId);
    if (!resource || resource.type !== 'skill') throw new Error('不是 Skill 资产');
    const authorityDir = resolveAuthorityDir(resource);
    if (!authorityDir) {
      throw new Error('尚未确定权威目录，请先在本机纳管或投射到某个 Agent');
    }
    this._persistSkillAuthority(resourceId, resource, { syncContent: true });
    // 软链型投射写权威即生效；复制型不会自动同步，需重刷。
    const resynced = this._resyncCopyProjections(this.getResource(resourceId));
    return { success: true, resource: this.getResource(resourceId), ...resynced };
  }

  deleteResource(resourceId) {
    this.init();
    const db = this._getDb();
    const resource = this.getResource(resourceId);
    if (!resource) throw new Error('资产不存在');

    for (const proj of resource.projections || []) {
      try {
        unprojectResource(resource, proj.agentId, proj.projectionType, proj.targetPath);
      } catch {}
    }
    db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(resourceId);
    db.prepare('DELETE FROM resources WHERE id = ?').run(resourceId);
    return { success: true };
  }

  /** 智能体 JSON 中引用的 Prompt / Skill（须已纳管） */
  _collectAssistantDependencies(resource) {
    if (resource.type !== 'assistant') return { resources: [], missing: [] };
    const config = parseAssistantConfig(resource.content);
    const resources = [];
    const missing = [];
    const seen = new Set();

    for (const name of config.prompts || []) {
      const row = this._findByTypeName('prompt', name);
      if (!row) {
        missing.push({ type: 'prompt', name });
        continue;
      }
      if (!seen.has(row.id)) {
        seen.add(row.id);
        resources.push(this.getResource(row.id));
      }
    }
    for (const name of config.skills || []) {
      const row = this._findByTypeName('skill', name);
      if (!row) {
        missing.push({ type: 'skill', name });
        continue;
      }
      if (!seen.has(row.id)) {
        seen.add(row.id);
        resources.push(this.getResource(row.id));
      }
    }
    return { resources: resources.filter(Boolean), missing };
  }

  /** 将单个资产投射到多个 Agent */
  _projectOneResourceToAgents(resource, agentIds, scope = 'global', options = {}) {
    const db = this._getDb();
    const now = Date.now();
    let workingResource = { ...resource };
    const resourceId = resource.id;

    // 先做文件系统投射并收集结果，再在单个事务里落库，避免中途失败留下半态 DB。
    const pending = [];
    for (const agentId of agentIds) {
      const existingRow = db.prepare(
        'SELECT id, projection_type, target_path FROM resource_projections WHERE resource_id = ? AND agent_id = ? AND scope = ?',
      ).get(resourceId, agentId, scope);

      const existingProjection = existingRow
        ? { projectionType: existingRow.projection_type, targetPath: existingRow.target_path }
        : null;

      const proj = projectResource(workingResource, agentId, scope, {
        existingProjection,
        force: !!options.force,
      });
      // 冲突不改变权威元数据
      if (proj.authorityPath && proj.projectionType !== 'conflict') {
        workingResource = this._mergeAuthorityMetadata(workingResource, {
          authorityPath: proj.authorityPath,
        });
      }
      pending.push({ agentId, existingRow, proj });
    }

    const results = [];
    const persist = db.transaction((entries) => {
      for (const { agentId, existingRow, proj } of entries) {
        if (existingRow) {
          db.prepare(`
            UPDATE resource_projections SET
              projection_type = ?, target_path = ?, status = ?, created_at = ?
            WHERE id = ?
          `).run(proj.projectionType, proj.targetPath, proj.status, now, existingRow.id);
          results.push({ agentId, projectionId: existingRow.id, resourceId, ...proj, updated: true });
        } else {
          const projectionId = `proj-${resourceId}-${agentId}-${scope}`;
          db.prepare(`
            INSERT INTO resource_projections
            (id, resource_id, agent_id, scope, projection_type, target_path, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectionId, resourceId, agentId, scope,
            proj.projectionType, proj.targetPath, proj.status, now,
          );
          results.push({ agentId, projectionId, resourceId, ...proj, updated: false });
        }
      }
    });
    persist(pending);

    if (resource.type === 'skill' && workingResource.metadata?.authorityPath) {
      this._persistSkillAuthority(resourceId, workingResource, {
        authorityPath: workingResource.metadata.authorityPath,
      });
    }

    return { results, workingResource };
  }

  projectToAgents(resourceId, agentIds = [], scope = 'global', options = {}) {
    this.init();
    const resource = this.getResource(resourceId);
    if (!resource) throw new Error('资产不存在');

    // 提示词只能投给支持斜杠命令的 Agent（Claude Code / Codex）；其余类型用 Skill 目标集
    const allowed = new Set(
      resource.type === 'prompt' ? listPromptProjectableAgentIds() : listProjectableAgentIds(),
    );
    const ids = [...new Set((agentIds || []).filter(id => allowed.has(id)))];
    if (!ids.length) throw new Error('请至少选择一个可投射的 Agent');

    const resourcesToProject = [resource];
    let missingDeps = [];
    if (resource.type === 'assistant') {
      const { resources, missing } = this._collectAssistantDependencies(resource);
      // prompt 依赖在运行时内联进 system 上下文(resolveAssistantContext),仅 Skill 需要落盘投射
      resourcesToProject.push(...resources.filter(r => r.type === 'skill'));
      missingDeps = missing;
    }

    const results = [];
    for (const res of resourcesToProject) {
      const batch = this._projectOneResourceToAgents(res, ids, scope, { force: !!options.force });
      results.push(...batch.results);
    }

    // 智能体：投射目标同步为 Debug 运行时（投到 Codex → Debug 显示 Codex）
    if (resource.type === 'assistant') {
      this._syncAssistantRuntimeFromProjections(resourceId);
    }

    const symlinkCount = results.filter(r => r.projectionType === 'symlink').length;
    const copyCount = results.filter(r => r.projectionType === 'copy').length;
    const scanCount = results.filter(r => r.projectionType === 'scan' || r.projectionType === 'origin').length;
    const conflicts = results.filter(r => r.projectionType === 'conflict');
    let hint = '提示词已投射:目标 Agent 会话可通过 MCP 工具 tb_get_prompt 按名取回(tb_list_prompts 可列出)。';
    if (resource.type === 'skill') {
      if (symlinkCount) {
        hint = 'Skill 已通过目录软链投射；权威目录保留在用户安装位置，修改该目录即可同步。';
      } else if (scanCount) {
        hint = '该 Agent 保留本机 Skill 目录作为权威源；其他 Agent 可软链指向此处。';
      } else if (copyCount) {
        hint = 'Skill 已投射（软链不可用时已回退为复制，副本不会随权威目录自动更新）。请重启 Agent 或 Reload 后生效。';
      }
    } else if (resource.type === 'assistant') {
      const depLabels = resourcesToProject.slice(1).map(r => r.display_name || r.name);
      // 说清楚：智能体本体不落盘到目标 Agent，仅在 Token Bank（Debug）内以 system 上下文运行；此处主要投射其关联 Skill。
      hint = '智能体已标记可用（本体在 Token Bank 内以上下文运行，不写入目标 Agent 目录）';
      if (depLabels.length) {
        hint += `，已同步投射关联 Skill：${depLabels.join('、')}`;
      }
      if (missingDeps.length) {
        const miss = missingDeps.map(m => `${m.name}（${RESOURCE_TYPE_LABELS[m.type] || m.type}）`).join('、');
        hint += `。以下关联项尚未纳管，请先添加：${miss}`;
      } else {
        hint += '。';
      }
    }

    if (conflicts.length) {
      const labels = conflicts.map(c => `${c.agentId}`).join('、');
      hint += `⚠️ ${conflicts.length} 处目标已存在同名的其他目录，为防误删未覆盖（${labels}）。确认可覆盖后可选「强制投射」。`;
    }

    return {
      success: true,
      resource: this.getResource(resourceId),
      results,
      hint,
      conflicts,
      projectedDependencies: resourcesToProject.slice(1).map(r => r.id),
      missingDependencies: missingDeps,
    };
  }

  /**
   * 校验某资产的所有投射是否仍健康；repair=true 时尝试重建可修复的软链。
   * @returns {{ success, resource, projections: Array }}
   */
  verifyProjections(resourceId, { repair = false } = {}) {
    this.init();
    const resource = this.getResource(resourceId);
    if (!resource) throw new Error('资产不存在');
    const db = this._getDb();
    const out = [];

    for (const proj of resource.projections || []) {
      let health = verifyProjection(resource, proj.agentId, proj.projectionType, proj.targetPath);
      let repaired = false;
      if (!health.healthy && health.repairable && repair) {
        try {
          const fixed = projectResource(resource, proj.agentId, proj.scope, {});
          db.prepare(`
            UPDATE resource_projections SET projection_type = ?, target_path = ?, status = ?, created_at = ?
            WHERE id = ?
          `).run(fixed.projectionType, fixed.targetPath, fixed.status, Date.now(), proj.projectionId || proj.id);
          health = verifyProjection(resource, proj.agentId, fixed.projectionType, fixed.targetPath);
          repaired = true;
        } catch (e) {
          health = { ...health, repairError: e.message };
        }
      }
      out.push({ ...proj, health, repaired });
    }

    return { success: true, resource: this.getResource(resourceId), projections: out };
  }

  /**
   * 权威目录升级后，重刷所有「复制」型投射（软链型无需重刷，copy 型不会自动同步）。
   */
  _resyncCopyProjections(resource) {
    if (!resource || resource.type !== 'skill') return { resynced: 0 };
    const authorityDir = resolveAuthorityDir(resource);
    if (!authorityDir) return { resynced: 0 };
    let resynced = 0;
    for (const proj of resource.projections || []) {
      if (proj.projectionType !== 'copy') continue;
      const targetDir = normalizeSkillDirPath(proj.targetPath, resource.name) || proj.targetPath;
      if (!targetDir) continue;
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
        copyDirRecursive(authorityDir, targetDir);
        resynced += 1;
      } catch (e) {
        console.warn('[resource-manager] copy resync failed:', proj.agentId, e.message);
      }
    }
    return { resynced };
  }

  unproject({ resourceId, agentId, projectionId }) {
    this.init();
    const db = this._getDb();
    let row;

    if (projectionId) {
      row = db.prepare('SELECT * FROM resource_projections WHERE id = ?').get(projectionId);
    } else if (resourceId && agentId) {
      row = db.prepare(
        'SELECT * FROM resource_projections WHERE resource_id = ? AND agent_id = ?',
      ).get(resourceId, agentId);
    }
    if (!row) throw new Error('投射记录不存在');

    const resource = this.getResource(row.resource_id);
    if (resource) unprojectResource(resource, row.agent_id, row.projection_type, row.target_path);
    db.prepare('DELETE FROM resource_projections WHERE id = ?').run(row.id);

    if (resource?.type === 'assistant') {
      this._syncAssistantRuntimeFromProjections(row.resource_id);
    }

    return { success: true, resource: this.getResource(row.resource_id) };
  }

  /**
   * 按当前投射列表同步智能体 content.runtime_agent，并刷新 Debug Agent 列表缓存
   */
  _syncAssistantRuntimeFromProjections(resourceId) {
    const resource = this.getResource(resourceId);
    if (!resource || resource.type !== 'assistant') return null;
    const config = parseAssistantConfig(resource.content);
    const nextRuntime = resolveAssistantRuntimeAgent(config, resource.projections || []);
    if (!nextRuntime || nextRuntime === config.runtime_agent) {
      try { require('./agent-executor').invalidateAgentListCache?.(); } catch { /* ignore */ }
      return resource;
    }
    const content = withAssistantRuntimeAgent(resource.content, nextRuntime);
    const now = Date.now();
    const hash = this._hashContent(content);
    this._getDb().prepare(`
      UPDATE resources SET content = ?, hash = ?, updated_at = ? WHERE id = ?
    `).run(content, hash, now, resourceId);
    try { require('./agent-executor').invalidateAgentListCache?.(); } catch { /* ignore */ }
    return this.getResource(resourceId);
  }

  listAgentTargets() {
    return Object.values(AGENT_RESOURCE_TARGETS).map(t => ({
      id: t.id,
      label: t.label,
      skillRoot: t.getSkillRoot(),
    }));
  }

  /** 规范化 Skill 扫描参数 */
  _buildSkillScanOptions(filters = {}) {
    const scanScope = filters.scanScope === 'custom' ? 'custom' : 'global';
    const customDirs = (filters.customDirs || [])
      .map(d => String(d || '').trim())
      .filter(Boolean);
    return { scanScope, customDirs };
  }

  _applyScanOptions(filters = {}) {
    this._lastScanOptions = this._buildSkillScanOptions(filters);
    return this._lastScanOptions;
  }

  _getActiveScanOptions(filters = {}) {
    if (filters.scanScope || filters.customDirs?.length) {
      return this._applyScanOptions(filters);
    }
    return this._lastScanOptions;
  }

  /** 扫描本机 Agent / aweskill 已有 Skill，排除已纳管项 */
  listDiscoveredSkills(filters = {}) {
    this.init();
    const scanOptions = this._applyScanOptions(filters);
    const managed = this.listResources({ type: 'skill' });
    const managedByName = new Map(managed.map(r => [r.name, r]));
    const grouped = groupDiscoveredSkills(scanAllAgentSkills(scanOptions));

    let items = grouped.map(g => {
      const managedRes = managedByName.get(g.name);
      const managed = !!managedRes;
      const contentChanged = managedRes && managedRes.hash && managedRes.hash !== g.hash;
      return {
        ...g,
        managed,
        contentChanged,
        resourceId: managedRes?.id || null,
      };
    });

    // 默认只展示未纳管；includeManaged 时一并展示（含内容变更）
    if (!filters.includeManaged) {
      items = items.filter(i => !i.managed || i.contentChanged);
    }
    if (filters.query) {
      const q = String(filters.query).toLowerCase();
      items = items.filter(i =>
        i.name.toLowerCase().includes(q)
        || (i.display_name || '').toLowerCase().includes(q)
        || (i.description || '').toLowerCase().includes(q),
      );
    }

    const scanStats = {
      totalOnDisk: grouped.length,
      managedCount: grouped.filter(g => managedByName.has(g.name)).length,
      pendingCount: items.filter(i => !i.managed).length,
      scanScope: scanOptions.scanScope,
      customDirs: scanOptions.customDirs,
    };

    return { items, scanStats };
  }

  /** 将扫描到的本机 Skill 纳管进 Token Bank（不移动原文件，记录 scan 投射） */
  importDiscoveredSkill({ scanKey, updateIfExists = false } = {}) {
    this.init();
    const scanOptions = this._lastScanOptions;
    const group = findScanGroupByScanKey(scanKey, scanOptions);
    if (!group) throw new Error('未找到该 Skill，请重新扫描');

    const entry = scanAllAgentSkills(scanOptions).find(i => i.scanKey === group.scanKey)
      || scanAllAgentSkills(scanOptions).find(i => i.name === group.name && i.hash === group.hash);
    if (!entry) throw new Error('无法读取 Skill 文件');

    const existing = this._findByTypeName('skill', group.name);
    if (existing && !updateIfExists) {
      return { success: true, resource: this.getResource(existing.id), alreadyInstalled: true };
    }

    const now = Date.now();
    const id = existing?.id || `res-skill-${group.name}`;
    const db = this._getDb();
    const sourceDir = entry.skillDir || path.dirname(entry.skillPath);
    const authorityPath = path.resolve(sourceDir);
    const metadata = {
      ...(existing?.metadata || {}),
      tags: entry.metadata?.tags || [],
      authorityPath,
      scannedFrom: authorityPath,
      originAgents: group.agents.map(a => a.agentId),
    };
    const source = `agent:${entry.agentId}`;

    if (existing) {
      db.prepare(`
        UPDATE resources SET
          display_name = ?, description = ?, content = ?, metadata = ?, source = ?, hash = ?, updated_at = ?
        WHERE id = ?
      `).run(
        group.display_name || group.name,
        group.description || '',
        entry.content,
        JSON.stringify(metadata),
        source,
        scanHashContent(entry.content),
        now,
        id,
      );
    } else {
      db.prepare(`
        INSERT INTO resources
        (id, type, name, display_name, description, content, metadata, source, source_url, hash, created_at, updated_at)
        VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        group.name,
        group.display_name || group.name,
        group.description || '',
        entry.content,
        JSON.stringify(metadata),
        source,
        entry.skillPath,
        scanHashContent(entry.content),
        now,
        now,
      );
    }

    this._persistSkillAuthority(id, this.getResource(id), { authorityPath });

    // 为本机已有该 Skill 的 Agent 建立 scan 投射（不替换原目录）
    for (const agent of group.agents) {
      const targetDir = agent.skillDir || path.dirname(agent.skillPath);
      const projId = `proj-${id}-${agent.agentId}-global`;
      const existingProj = db.prepare(
        'SELECT id FROM resource_projections WHERE resource_id = ? AND agent_id = ? AND scope = ?',
      ).get(id, agent.agentId, 'global');

      if (existingProj) {
        db.prepare(`
          UPDATE resource_projections SET
            projection_type = 'scan', target_path = ?, status = 'active', created_at = ?
          WHERE id = ?
        `).run(targetDir, now, existingProj.id);
      } else {
        db.prepare(`
          INSERT INTO resource_projections
          (id, resource_id, agent_id, scope, projection_type, target_path, status, created_at)
          VALUES (?, ?, ?, 'global', 'scan', ?, 'active', ?)
        `).run(projId, id, agent.agentId, targetDir, now);
      }
    }

    return {
      success: true,
      resource: this.getResource(id),
      alreadyInstalled: false,
      updated: !!existing,
      hint: '已纳管本机 Skill，权威目录保留在原安装位置；可在「已纳管」页软链投射到其他 Agent。',
    };
  }

  getPostProjectHint(resourceType, agentIds = []) {
    if (resourceType === 'skill') {
      return 'Skill 已软链指向用户安装目录；修改该目录内容后各 Agent 自动同步。';
    }
    if (agentIds.length) {
      return '已在 Token Bank 关联所选 Agent；Prompt / Assistant 的 Debug 选用能力将在编排页接入。';
    }
    return '';
  }

  /** 各 Agent skills 目录中的 Skill 安装情况 */
  listAgentInstallations(filters = {}) {
    this.init();
    const scanOptions = this._getActiveScanOptions(filters);
    const managed = this.listResources({ type: 'skill' });
    const managedByName = new Map(managed.map(r => [r.name, r]));
    const scanIndex = buildAgentSkillScanIndex(scanOptions);
    const db = this._getDb();

    const projRows = db.prepare(`
      SELECT p.*, r.name AS skill_name, r.display_name
      FROM resource_projections p
      JOIN resources r ON r.id = p.resource_id
      WHERE r.type = 'skill'
    `).all();
    const projByAgentSkill = new Map();
    for (const row of projRows) {
      projByAgentSkill.set(`${row.agent_id}:${row.skill_name}`, row);
    }

    const buildItems = (agentId, keyMap) => {
      const items = [];
      for (const [mapKey, scanItem] of keyMap) {
        const skillKey = scanItem.name;
        const resource = managedByName.get(skillKey);
        const projRow = projByAgentSkill.get(`${agentId}:${skillKey}`);
        let source = 'client';
        let resourceId = null;
        let displayName = scanItem.display_name || skillKey;
        let projectionType = null;
        const projectRoot = scanItem.projectRoot || null;
        const customScanRoot = scanItem.customScanRoot || null;
        const itemKey = mapKey;

        if (projRow) {
          resourceId = projRow.resource_id;
          displayName = projRow.display_name || skillKey;
          projectionType = projRow.projection_type;
          source = projectionType === 'scan' ? 'tb_scanned' : 'tb_sync';
        } else if (resource) {
          source = 'tb_scanned';
          resourceId = resource.id;
          displayName = resource.display_name || skillKey;
        }

        const descBase = scanItem.description
          || (source === 'client' ? '客户端自配 Skill' : (resource?.description || displayName));
        let description = descBase;
        if (projectRoot) description = `${descBase} · 项目 ${path.basename(projectRoot)}`;
        else if (customScanRoot) description = `${descBase} · ${customScanRoot}`;

        items.push({
          itemKey,
          skillKey,
          clientKey: skillKey,
          scanKey: scanItem.scanKey,
          displayName,
          resourceId,
          managed: !!resource || source !== 'client',
          source,
          projectionType,
          isSymlink: scanItem.isSymlink,
          skillDir: scanItem.skillDir,
          skillPath: scanItem.skillPath,
          projectRoot,
          customScanRoot,
          scope: scanItem.scope || scanOptions.scanScope,
          description,
        });
      }
      items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
      return items;
    };

    const agents = Object.entries(AGENT_RESOURCE_TARGETS).map(([agentId, target]) => {
      const skillRoot = target.getSkillRoot();
      const items = buildItems(agentId, scanIndex[agentId] || new Map());
      return {
        id: agentId,
        label: target.label,
        path: skillRoot,
        exists: fs.existsSync(skillRoot),
        syncEnabled: true,
        count: items.length,
        items,
      };
    });

    if (scanOptions.scanScope === 'custom' && scanIndex.custom?.size) {
      const items = buildItems('custom', scanIndex.custom);
      agents.unshift({
        id: 'custom',
        label: '指定目录',
        path: scanOptions.customDirs.join(' · ') || '—',
        exists: true,
        syncEnabled: false,
        count: items.length,
        items,
      });
    }

    return agents;
  }

  /** 将 Agent 上的自配 Skill 纳管到 Token Bank */
  importFromAgent({ agentId, skillKey, clientKey, scanKey, projectRoot }) {
    this.init();
    const key = String(skillKey || clientKey || '').trim();
    if (!agentId || !key) throw new Error('缺少 agentId 或 skillKey');
    if (scanKey) return this.importDiscoveredSkill({ scanKey });
    if (projectRoot) {
      const { projectRootToken } = require('./resource-skill-scanner');
      return this.importDiscoveredSkill({
        scanKey: `${agentId}::project::${projectRootToken(projectRoot)}::${key}`,
      });
    }
    return this.importDiscoveredSkill({ scanKey: `${agentId}::${key}` });
  }

  /**
   * 从指定 Agent 移除此 Skill（不影响 TB 纳管及其他 Agent）
   * @param {boolean} [external] 客户端自配 Skill
   */
  removeFromAgent({ resourceId, agentId, skillKey, clientKey, external = false }) {
    this.init();
    const key = String(skillKey || clientKey || '').trim();
    if (!agentId || !key) throw new Error('缺少 agentId 或 skillKey');

    removeRawAgentSkill(agentId, key, { ignoreMissing: external });

    const resolvedId = resourceId || this._findByTypeName('skill', key)?.id;
    if (resolvedId && !external) {
      try {
        const row = this._getDb().prepare(
          'SELECT id FROM resource_projections WHERE resource_id = ? AND agent_id = ?',
        ).get(resolvedId, agentId);
        if (row) this.unproject({ resourceId: resolvedId, agentId });
      } catch {}
    } else if (resolvedId) {
      try { this.unproject({ resourceId: resolvedId, agentId }); } catch {}
    }

    return { success: true, resource: resolvedId ? this.getResource(resolvedId) : null };
  }

  /** 从本机文件或 Skill 目录导入资源（不复制 Skill 目录，仅登记权威路径） */
  importFromPath({ sourcePath, type: forcedType } = {}) {
    this.init();
    const src = path.resolve(String(sourcePath || '').trim());
    if (!src || !fs.existsSync(src)) throw new Error('路径不存在');

    const st = fs.lstatSync(src);
    if (st.isDirectory()) {
      return this._importSkillDirectory(src, forcedType);
    }
    if (!st.isFile()) throw new Error('请选择文件或 Skill 目录');

    return this._importTextFile(src, forcedType);
  }

  _importSkillDirectory(dir, forcedType) {
    if (forcedType && forcedType !== 'skill') {
      throw new Error('目录导入仅适用于 Skill');
    }

    const { parseSkillFrontmatter } = require('./resource-skill-scanner');
    const skillMd = ['SKILL.md', 'skill.md'].map(f => path.join(dir, f)).find(p => fs.existsSync(p));
    if (!skillMd) throw new Error('目录中未找到 SKILL.md');

    const content = fs.readFileSync(skillMd, 'utf8');
    const fm = parseSkillFrontmatter(content);
    const name = String(fm.name || path.basename(dir)).trim();
    if (!name) throw new Error('无法确定 Skill 名称');

    const existing = this._findByTypeName('skill', name);
    if (existing) {
      return { success: true, resource: this.getResource(existing.id), alreadyInstalled: true };
    }

    const authorityPath = path.resolve(dir);
    const tags = fm.tags ? String(fm.tags).split(/[,\s]+/).filter(Boolean) : [];
    const result = this.saveResource({
      type: 'skill',
      name,
      display_name: fm.name || name,
      description: fm.description || '',
      content,
      source: 'imported',
      metadata: {
        tags,
        authorityPath,
        scannedFrom: authorityPath,
        importedFrom: authorityPath,
      },
    });
    this._persistSkillAuthority(result.resource.id, result.resource, { authorityPath });
    return {
      ...result,
      alreadyInstalled: false,
      hint: '已导入 Skill 目录，权威位置保留在原路径；可在「已纳管」页投射到其他 Agent。',
    };
  }

  _importTextFile(filePath, forcedType) {
    const { parseSkillFrontmatter } = require('./resource-skill-scanner');
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = parseSkillFrontmatter(content);
    const baseName = path.basename(filePath, path.extname(filePath));
    const isSkillMd = /^skill\.md$/i.test(path.basename(filePath));

    let type = forcedType || 'prompt';
    if (!forcedType && text.startsWith('{')) {
      try {
        const obj = JSON.parse(text);
        if (obj.soul || obj.system_prompt || obj.systemPrompt) type = 'assistant';
        else if (isSkillMd || obj.name) type = 'skill';
      } catch {
        // ignore
      }
    } else if (!forcedType && (isSkillMd || (fm.name && text.trimStart().startsWith('---')))) {
      type = 'skill';
    }

    const name = String(fm.name || baseName).trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!name) throw new Error('无法确定资产名称');

    const existing = this._findByTypeName(type, name);
    if (existing) {
      return { success: true, resource: this.getResource(existing.id), alreadyInstalled: true };
    }

    const metadata = {
      tags: fm.tags ? String(fm.tags).split(/[,\s]+/).filter(Boolean) : [],
      importedFrom: filePath,
    };

    if (type === 'skill' && isSkillMd) {
      const authorityPath = path.resolve(path.dirname(filePath));
      metadata.authorityPath = authorityPath;
      metadata.scannedFrom = authorityPath;
    }

    const result = this.saveResource({
      type,
      name,
      display_name: fm.name || baseName || name,
      description: fm.description || '',
      content,
      source: 'imported',
      metadata,
    });

    if (type === 'skill' && metadata.authorityPath) {
      this._persistSkillAuthority(result.resource.id, result.resource, {
        authorityPath: metadata.authorityPath,
      });
    }

    return {
      ...result,
      alreadyInstalled: false,
      hint: type === 'skill'
        ? '已导入 Skill 文件；可在「已纳管」页投射到其他 Agent。'
        : '已导入到 Token Bank。',
    };
  }
}

module.exports = new ResourceManager();
module.exports.applyPromptArguments = applyPromptArguments;
