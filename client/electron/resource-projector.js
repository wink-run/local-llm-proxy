// client/electron/resource-projector.js
// Skill 投射：以用户安装目录为权威源，其他 Agent 建目录软链
'use strict';

const fs = require('fs');
const path = require('path');
const { getAgentTarget, getPromptTarget } = require('./resource-agent-targets');
const {
  resolveAuthorityDir,
  materializeSkillDir,
  copyDirRecursive,
  normalizeSkillDirPath,
  resolvePath,
  pathExists,
  isRealSkillDir,
} = require('./resource-canonical');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isSymlinkTo(targetPath, authorityDir) {
  try {
    const st = fs.lstatSync(targetPath);
    if (!st.isSymbolicLink()) return false;
    return fs.realpathSync(targetPath) === fs.realpathSync(authorityDir);
  } catch {
    return false;
  }
}

function removePathSafe(p) {
  if (!pathExists(p)) return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(p);
    return;
  }
  if (st.isDirectory()) {
    fs.rmSync(p, { recursive: true, force: true });
    return;
  }
  fs.unlinkSync(p);
}

/**
 * 在 targetDir 创建指向 authorityDir 的目录软链
 * @returns {'symlink'|'copy'} 实际使用的方式
 */
function replaceWithSymlink(targetDir, authorityDir) {
  ensureDir(path.dirname(targetDir));

  if (pathExists(targetDir)) {
    if (isSymlinkTo(targetDir, authorityDir)) return 'symlink';
    removePathSafe(targetDir);
  }

  try {
    fs.symlinkSync(resolvePath(authorityDir), targetDir, 'dir');
    return 'symlink';
  } catch (e) {
    console.warn('[resource-projector] dir symlink failed, fallback to copy:', e.message);
    copyDirRecursive(authorityDir, targetDir);
    return 'copy';
  }
}

/** 该 Agent 上是否保留用户自装的实体目录（权威源，不替换为软链） */
function shouldKeepAsAuthority(resource, agentId, skillDir, existingProjection) {
  const skillDirResolved = resolvePath(skillDir);
  const authorityDir = resolveAuthorityDir(resource);

  if (authorityDir && skillDirResolved === authorityDir) return true;

  if (existingProjection?.projectionType === 'scan' || existingProjection?.projectionType === 'origin') {
    const projDir = normalizeSkillDirPath(existingProjection.targetPath, resource.name);
    if (projDir && resolvePath(projDir) === skillDirResolved && pathExists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
      return true;
    }
  }

  const scannedFrom = resource.metadata?.scannedFrom || resource.metadata?.authorityPath;
  if (scannedFrom) {
    const scannedDir = normalizeSkillDirPath(scannedFrom, resource.name);
    if (scannedDir && resolvePath(scannedDir) === skillDirResolved && pathExists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
      return true;
    }
  }

  const originAgents = resource.metadata?.originAgents || [];
  if (originAgents.includes(agentId) && pathExists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
    return true;
  }
  return false;
}

/**
 * 目标位置是否已有一个「与本资产无关的真实目录」。
 * 存在、非软链、且不是本资产的权威目录 → 属于冲突：直接覆盖会删掉用户已有的同名 Skill。
 */
function isForeignRealDir(skillDir, authorityDir) {
  if (!pathExists(skillDir)) return false;
  try {
    if (fs.lstatSync(skillDir).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  if (authorityDir && resolvePath(skillDir) === resolvePath(authorityDir)) return false;
  return true;
}

/**
 * Skill 投射：权威目录在用户安装位置；其他 Agent 软链指向该目录
 */
function projectSkillToAgent(resource, agentId, scope = 'global', options = {}) {
  const target = getAgentTarget(agentId);
  if (!target) throw new Error(`不支持的 Agent: ${agentId}`);

  const skillRoot = target.getSkillRoot();
  ensureDir(skillRoot);

  const skillDir = path.join(skillRoot, resource.name);
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  let authorityDir = resolveAuthorityDir(resource);

  if (shouldKeepAsAuthority(resource, agentId, skillDir, options.existingProjection)) {
    if (!authorityDir && pathExists(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) {
      authorityDir = resolvePath(skillDir);
    }
    return {
      agentId,
      scope,
      targetPath: skillDir,
      skillMdPath,
      authorityPath: authorityDir,
      projectionType: 'scan',
      status: 'active',
    };
  }

  // 冲突保护：目标位置已有一个无关的真实同名目录（用户自装的另一个 Skill）。
  // 直接软链/物化会先删掉它，造成数据丢失——除非调用方显式 force，否则拒绝并回报冲突。
  if (isForeignRealDir(skillDir, authorityDir) && !options.force) {
    return {
      agentId,
      scope,
      targetPath: skillDir,
      skillMdPath,
      authorityPath: authorityDir,
      projectionType: 'conflict',
      status: 'conflict',
      conflict: true,
      conflictPath: skillDir,
    };
  }

  // 目录市场纳管、尚无本机副本：在首个目标 Agent 写入实体目录作为权威源
  if (!authorityDir) {
    authorityDir = materializeSkillDir(skillDir, resource.content);
    return {
      agentId,
      scope,
      targetPath: skillDir,
      skillMdPath,
      authorityPath: authorityDir,
      projectionType: 'origin',
      status: 'active',
    };
  }

  const mode = replaceWithSymlink(skillDir, authorityDir);
  return {
    agentId,
    scope,
    targetPath: skillDir,
    skillMdPath,
    authorityPath: authorityDir,
    projectionType: mode === 'symlink' ? 'symlink' : 'copy',
    status: 'active',
  };
}

/** 取消投射：仅删除软链/复制目录，不删用户权威目录 */
function unprojectSkillFromAgent(resource, agentId, projectionType = 'symlink', targetPathHint) {
  if (projectionType === 'scan' || projectionType === 'reference' || projectionType === 'origin') {
    return { removed: false, skipped: true };
  }

  const target = getAgentTarget(agentId);
  if (!target) return { removed: false };

  const skillRoot = target.getSkillRoot();
  const skillDir = normalizeSkillDirPath(
    targetPathHint || path.join(skillRoot, resource.name),
    resource.name,
  ) || path.join(skillRoot, resource.name);

  if (!pathExists(skillDir)) return { removed: false, path: skillDir };

  try {
    const st = fs.lstatSync(skillDir);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(skillDir);
    } else if (projectionType === 'copy') {
      fs.rmSync(skillDir, { recursive: true, force: true });
    } else {
      const legacyMd = path.join(skillDir, 'SKILL.md');
      if (pathExists(legacyMd) && fs.lstatSync(legacyMd).isSymbolicLink()) {
        fs.unlinkSync(legacyMd);
        try {
          if (fs.readdirSync(skillDir).length === 0) fs.rmdirSync(skillDir);
        } catch {}
        return { removed: true, path: legacyMd };
      }
      return { removed: false, skipped: true, path: skillDir };
    }
  } catch {
    return { removed: false, path: skillDir };
  }

  return { removed: true, path: skillDir };
}

/**
 * 校验单条投射当前是否仍然健康（软链是否还在/是否仍指向权威/权威是否还存在）。
 * @returns {{ healthy: boolean, reason: string, repairable: boolean }}
 */
function verifyProjection(resource, agentId, projectionType, targetPath) {
  if (projectionType === 'reference') {
    return { healthy: true, reason: 'reference', repairable: false };
  }
  // 提示词命令文件：健康 = TB 生成的文件仍在
  if (projectionType === 'command' || resource?.type === 'prompt') {
    const target = getPromptTarget(agentId);
    const filePath = targetPath
      || (target ? path.join(target.getPromptRoot(), target.fileName(resource.name)) : null);
    if (!filePath) return { healthy: false, reason: 'unknown-target', repairable: false };
    if (!pathExists(filePath)) return { healthy: false, reason: 'missing', repairable: true };
    if (!isTbManagedPromptFile(filePath)) return { healthy: false, reason: 'overwritten', repairable: false };
    return { healthy: true, reason: 'command', repairable: false };
  }
  if (!resource || resource.type !== 'skill') {
    return { healthy: true, reason: 'reference', repairable: false };
  }
  const skillDir = normalizeSkillDirPath(targetPath, resource.name)
    || (getAgentTarget(agentId) ? path.join(getAgentTarget(agentId).getSkillRoot(), resource.name) : null);
  if (!skillDir) return { healthy: false, reason: 'unknown-target', repairable: false };

  const authorityDir = resolveAuthorityDir(resource);

  // 权威型：该 Agent 目录本身就是权威源，健康 = 真实目录仍在
  if (projectionType === 'scan' || projectionType === 'origin') {
    return isRealSkillDir(skillDir)
      ? { healthy: true, reason: 'authority', repairable: false }
      : { healthy: false, reason: 'authority-missing', repairable: false };
  }

  if (projectionType === 'symlink') {
    if (isSymlinkTo(skillDir, authorityDir)) return { healthy: true, reason: 'symlink', repairable: false };
    if (!authorityDir) return { healthy: false, reason: 'authority-missing', repairable: false };
    return {
      healthy: false,
      reason: pathExists(skillDir) ? 'not-symlink' : 'missing',
      repairable: true,
    };
  }

  if (projectionType === 'copy') {
    if (!pathExists(skillDir)) return { healthy: false, reason: 'missing', repairable: !!authorityDir };
    // 复制存在但可能已陈旧（权威升级后不会自动同步）
    return { healthy: true, reason: 'copy-maybe-stale', repairable: !!authorityDir };
  }

  return { healthy: true, reason: projectionType, repairable: false };
}

// ── 提示词 → 各 Agent 原生斜杠命令 ──────────────────────────────────────────

/** TB 生成的命令文件标记：据此判断某文件是否 TB 所写（决定可否覆盖/删除） */
const TB_PROMPT_MARKER = 'tokenbank-managed-prompt';

function buildPromptFileContent(resource, target) {
  const body = String(resource.content || '');
  if (target.withFrontmatter) {
    const desc = String(resource.description || resource.display_name || resource.name || '')
      .replace(/\s+/g, ' ').trim();
    // frontmatter 内含 TB 标记；description 供 Claude 命令列表展示
    return `---\n${TB_PROMPT_MARKER}: true\ndescription: ${JSON.stringify(desc)}\n---\n${body}`;
  }
  // 纯文本 Agent（如 Codex）：首行注释作为 TB 标记
  return `<!-- ${TB_PROMPT_MARKER} -->\n${body}`;
}

/** 文件是否为 TB 生成（含标记）；据此避免覆盖/删除用户自建的同名命令 */
function isTbManagedPromptFile(filePath) {
  try {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 400);
    return head.includes(TB_PROMPT_MARKER);
  } catch {
    return false;
  }
}

function projectPromptToAgent(resource, agentId, scope = 'global', options = {}) {
  const target = getPromptTarget(agentId);
  // 该 Agent 不支持提示词投射（如 cursor/workbuddy）：仅标记引用，不落盘
  if (!target) {
    return { agentId, scope, targetPath: null, authorityPath: null, projectionType: 'reference', status: 'active' };
  }

  const root = target.getPromptRoot();
  ensureDir(root);
  const filePath = path.join(root, target.fileName(resource.name));

  // 冲突保护：目标已有一个「非 TB 生成」的同名命令文件 → 不覆盖用户自建命令
  if (pathExists(filePath) && !isTbManagedPromptFile(filePath) && !options.force) {
    return {
      agentId, scope, targetPath: filePath, authorityPath: null,
      projectionType: 'conflict', status: 'conflict', conflict: true, conflictPath: filePath,
      invoke: target.invoke(resource.name),
    };
  }

  fs.writeFileSync(filePath, buildPromptFileContent(resource, target), 'utf8');
  return {
    agentId, scope, targetPath: filePath, authorityPath: null,
    projectionType: 'command', status: 'active',
    invoke: target.invoke(resource.name),
  };
}

function unprojectPromptFromAgent(resource, agentId, targetPath) {
  const target = getPromptTarget(agentId);
  const filePath = targetPath
    || (target ? path.join(target.getPromptRoot(), target.fileName(resource.name)) : null);
  if (!filePath || !pathExists(filePath)) return { removed: false };
  // 只删 TB 生成的命令文件，绝不删用户自建的同名命令
  if (!isTbManagedPromptFile(filePath)) return { removed: false, skipped: true, path: filePath };
  try {
    fs.unlinkSync(filePath);
    return { removed: true, path: filePath };
  } catch {
    return { removed: false, path: filePath };
  }
}

function projectResource(resource, agentId, scope = 'global', options = {}) {
  if (resource.type === 'skill') {
    return projectSkillToAgent(resource, agentId, scope, options);
  }
  if (resource.type === 'prompt') {
    return projectPromptToAgent(resource, agentId, scope, options);
  }
  return {
    agentId,
    scope,
    targetPath: null,
    authorityPath: null,
    projectionType: 'reference',
    status: 'active',
  };
}

function unprojectResource(resource, agentId, projectionType = 'symlink', targetPath) {
  if (resource.type === 'skill') {
    return unprojectSkillFromAgent(resource, agentId, projectionType, targetPath);
  }
  if (resource.type === 'prompt') {
    return unprojectPromptFromAgent(resource, agentId, targetPath);
  }
  return { removed: true };
}

module.exports = {
  projectResource,
  unprojectResource,
  projectSkillToAgent,
  projectPromptToAgent,
  unprojectPromptFromAgent,
  isTbManagedPromptFile,
  verifyProjection,
  isForeignRealDir,
  replaceWithSymlink,
  isSymlinkTo,
  normalizeSkillDirPath,
};
