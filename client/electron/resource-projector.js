// client/electron/resource-projector.js
// Skill 投射：以用户安装目录为权威源，其他 Agent 建目录软链
'use strict';

const fs = require('fs');
const path = require('path');
const { getAgentTarget } = require('./resource-agent-targets');
const {
  resolveAuthorityDir,
  materializeSkillDir,
  copyDirRecursive,
  normalizeSkillDirPath,
  resolvePath,
  pathExists,
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

function projectResource(resource, agentId, scope = 'global', options = {}) {
  if (resource.type === 'skill') {
    return projectSkillToAgent(resource, agentId, scope, options);
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
  return { removed: true };
}

module.exports = {
  projectResource,
  unprojectResource,
  projectSkillToAgent,
  replaceWithSymlink,
  isSymlinkTo,
  normalizeSkillDirPath,
};
