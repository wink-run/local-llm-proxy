// client/electron/resource-manager.js
// Prompt / Skill / Assistant / Template 统一纳管与投射
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
const { projectResource, unprojectResource } = require('./resource-projector');
const {
  resolveAuthorityDir,
  syncSkillContentToAuthority,
  normalizeSkillDirPath,
} = require('./resource-canonical');
const {
  AGENT_RESOURCE_TARGETS,
  listProjectableAgentIds,
} = require('./resource-agent-targets');
const {
  scanAllAgentSkills,
  buildAgentSkillScanIndex,
  removeRawAgentSkill,
  groupDiscoveredSkills,
  findScanGroupByScanKey,
  hashContent: scanHashContent,
} = require('./resource-skill-scanner');

class ResourceManager {
  constructor() {
    this._ready = false;
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
    return resource;
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
    let sql = 'SELECT * FROM resources WHERE 1=1';
    const params = [];

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
      item.content || '',
      JSON.stringify(item.metadata || {}),
      `catalog:${catalogId}`,
      this._hashContent(item.content),
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
    const content = data.content != null ? String(data.content) : '';
    const metadata = { ...(data.metadata || {}) };

    const existing = db.prepare('SELECT id, source FROM resources WHERE id = ?').get(id);
    if (!existing) {
      const nameTaken = db.prepare('SELECT id FROM resources WHERE type = ? AND name = ?').get(type, name);
      if (nameTaken) throw new Error(`同名资源已存在: ${name}`);
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
    }
    return { success: true, resource: this.getResource(id) };
  }

  /** 升级 Skill：同步到已有权威目录的 SKILL.md（软链自动生效） */
  syncSkillCanonical(resourceId) {
    this.init();
    const resource = this.getResource(resourceId);
    if (!resource || resource.type !== 'skill') throw new Error('不是 Skill 资源');
    const authorityDir = resolveAuthorityDir(resource);
    if (!authorityDir) {
      throw new Error('尚未确定权威目录，请先在本机纳管或投射到某个 Agent');
    }
    this._persistSkillAuthority(resourceId, resource, { syncContent: true });
    return { success: true, resource: this.getResource(resourceId) };
  }

  deleteResource(resourceId) {
    this.init();
    const db = this._getDb();
    const resource = this.getResource(resourceId);
    if (!resource) throw new Error('资源不存在');

    for (const proj of resource.projections || []) {
      try {
        unprojectResource(resource, proj.agentId, proj.projectionType, proj.targetPath);
      } catch {}
    }
    db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(resourceId);
    db.prepare('DELETE FROM resources WHERE id = ?').run(resourceId);
    return { success: true };
  }

  projectToAgents(resourceId, agentIds = [], scope = 'global') {
    this.init();
    const resource = this.getResource(resourceId);
    if (!resource) throw new Error('资源不存在');

    const allowed = new Set(listProjectableAgentIds());
    const ids = [...new Set((agentIds || []).filter(id => allowed.has(id)))];
    if (!ids.length) throw new Error('请至少选择一个 Agent');

    const db = this._getDb();
    const now = Date.now();
    const results = [];
    let workingResource = { ...resource };

    for (const agentId of ids) {
      const existingRow = db.prepare(
        'SELECT id, projection_type, target_path FROM resource_projections WHERE resource_id = ? AND agent_id = ? AND scope = ?',
      ).get(resourceId, agentId, scope);

      const existingProjection = existingRow
        ? { projectionType: existingRow.projection_type, targetPath: existingRow.target_path }
        : null;

      const proj = projectResource(workingResource, agentId, scope, { existingProjection });
      if (proj.authorityPath) {
        workingResource = this._mergeAuthorityMetadata(workingResource, {
          authorityPath: proj.authorityPath,
        });
      }
      if (existingRow) {
        db.prepare(`
          UPDATE resource_projections SET
            projection_type = ?, target_path = ?, status = ?, created_at = ?
          WHERE id = ?
        `).run(proj.projectionType, proj.targetPath, proj.status, now, existingRow.id);
        results.push({ agentId, projectionId: existingRow.id, ...proj, updated: true });
      } else {
        const projectionId = `proj-${resourceId}-${agentId}-${scope}`;
        db.prepare(`
          INSERT INTO resource_projections
          (id, resource_id, agent_id, scope, projection_type, target_path, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          projectionId,
          resourceId,
          agentId,
          scope,
          proj.projectionType,
          proj.targetPath,
          proj.status,
          now,
        );
        results.push({ agentId, projectionId, ...proj, updated: false });
      }
    }

    if (resource.type === 'skill' && workingResource.metadata?.authorityPath) {
      this._persistSkillAuthority(resourceId, workingResource, {
        authorityPath: workingResource.metadata.authorityPath,
      });
    }

    const symlinkCount = results.filter(r => r.projectionType === 'symlink').length;
    const scanCount = results.filter(r => r.projectionType === 'scan' || r.projectionType === 'origin').length;
    let hint = '已在 Token Bank 标记为可用；Debug 编排页后续将支持选用 Prompt / Assistant / Template。';
    if (resource.type === 'skill') {
      if (symlinkCount) {
        hint = 'Skill 已通过目录软链投射；权威目录保留在用户安装位置，修改该目录即可同步。';
      } else if (scanCount) {
        hint = '该 Agent 保留本机 Skill 目录作为权威源；其他 Agent 可软链指向此处。';
      } else {
        hint = 'Skill 已投射（软链不可用时已回退为复制）。请重启 Agent 或 Reload 后生效。';
      }
    }

    return {
      success: true,
      resource: this.getResource(resourceId),
      results,
      hint,
    };
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

    return { success: true, resource: this.getResource(row.resource_id) };
  }

  listAgentTargets() {
    return Object.values(AGENT_RESOURCE_TARGETS).map(t => ({
      id: t.id,
      label: t.label,
      skillRoot: t.getSkillRoot(),
    }));
  }

  /** 扫描本机 Agent / aweskill 已有 Skill，排除已纳管项 */
  listDiscoveredSkills(filters = {}) {
    this.init();
    const managed = this.listResources({ type: 'skill' });
    const managedByName = new Map(managed.map(r => [r.name, r]));
    const grouped = groupDiscoveredSkills(scanAllAgentSkills());

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
    };

    return { items, scanStats };
  }

  /** 将扫描到的本机 Skill 纳管进 Token Bank（不移动原文件，记录 scan 投射） */
  importDiscoveredSkill({ scanKey, updateIfExists = false } = {}) {
    this.init();
    const group = findScanGroupByScanKey(scanKey);
    if (!group) throw new Error('未找到该 Skill，请重新扫描');

    const entry = scanAllAgentSkills().find(i => i.scanKey === group.scanKey)
      || scanAllAgentSkills().find(i => i.name === group.name && i.hash === group.hash);
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
      return '已在 Token Bank 关联所选 Agent；Prompt / Assistant / Template 的 Debug 选用能力将在编排页接入。';
    }
    return '';
  }

  /** 各 Agent skills 目录中的 Skill 安装情况（对齐 MCP listAgentInstallations） */
  listAgentInstallations() {
    this.init();
    const managed = this.listResources({ type: 'skill' });
    const managedByName = new Map(managed.map(r => [r.name, r]));
    const scanIndex = buildAgentSkillScanIndex();
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

    return Object.entries(AGENT_RESOURCE_TARGETS).map(([agentId, target]) => {
      const skillRoot = target.getSkillRoot();
      const keyMap = scanIndex[agentId] || new Map();
      const items = [];

      for (const [skillKey, scanItem] of keyMap) {
        const resource = managedByName.get(skillKey);
        const projRow = projByAgentSkill.get(`${agentId}:${skillKey}`);
        let source = 'client';
        let resourceId = null;
        let displayName = scanItem.display_name || skillKey;
        let projectionType = null;

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

        items.push({
          skillKey,
          clientKey: skillKey,
          displayName,
          resourceId,
          managed: !!resource || source !== 'client',
          source,
          projectionType,
          isSymlink: scanItem.isSymlink,
          skillDir: scanItem.skillDir,
          skillPath: scanItem.skillPath,
          description: scanItem.description
            || (source === 'client' ? '客户端自配 Skill' : (resource?.description || displayName)),
        });
      }

      items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));

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
  }

  /** 将 Agent 上的自配 Skill 纳管到 Token Bank */
  importFromAgent({ agentId, skillKey, clientKey }) {
    this.init();
    const key = String(skillKey || clientKey || '').trim();
    if (!agentId || !key) throw new Error('缺少 agentId 或 skillKey');
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
        if (obj.system_prompt || obj.systemPrompt) type = 'assistant';
        else if (isSkillMd || obj.name) type = 'skill';
      } catch {
        // ignore
      }
    } else if (!forcedType && (isSkillMd || (fm.name && text.trimStart().startsWith('---')))) {
      type = 'skill';
    }

    const name = String(fm.name || baseName).trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!name) throw new Error('无法确定资源名称');

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
