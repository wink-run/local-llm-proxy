// client/electron/resource-canonical.js
// Skill 权威目录：用户安装位置（不复制到 ~/.tokenbank）
'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolvePath(p) {
  return path.resolve(p);
}

function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 路径是否同一位置（Windows 忽略大小写） */
function pathsEqual(a, b) {
  if (!a || !b) return false;
  const left = resolvePath(a);
  const right = resolvePath(b);
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/** 将路径规范为 Skill 目录（兼容旧版 SKILL.md 路径） */
function normalizeSkillDirPath(targetPath, resourceName) {
  if (!targetPath) return null;
  const base = path.basename(targetPath);
  if (/^skill\.md$/i.test(base)) return path.dirname(targetPath);
  return targetPath;
}

function isRealSkillDir(dir) {
  if (!dir || !pathExists(dir)) return false;
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return ['SKILL.md', 'skill.md', 'meta.json'].some(f => fs.existsSync(path.join(dir, f)));
}

/** 从 metadata 解析权威目录（兼容旧 canonicalPath） */
function resolveAuthorityDir(resource) {
  const meta = resource?.metadata || {};
  const hints = [meta.authorityPath, meta.scannedFrom, meta.canonicalPath].filter(Boolean);
  for (const hint of hints) {
    const dir = normalizeSkillDirPath(hint, resource?.name);
    if (dir && isRealSkillDir(dir)) return resolvePath(dir);
  }
  return null;
}

/** 递归复制目录（软链失败回退用） */
function copyDirRecursive(src, dest) {
  ensureDir(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, ent.name);
    const destPath = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** 在目标 Agent 首次安装目录写入 Skill（仅目录市场纳管、尚无本机副本时） */
function materializeSkillDir(skillDir, content) {
  ensureDir(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content || '', 'utf8');
  return resolvePath(skillDir);
}

/** 将 DB 内容同步到已有权威目录的 SKILL.md（不新建 TB 副本） */
function syncSkillContentToAuthority(authorityDir, content) {
  if (!authorityDir || !isRealSkillDir(authorityDir)) return null;
  fs.writeFileSync(path.join(authorityDir, 'SKILL.md'), content || '', 'utf8');
  return resolvePath(authorityDir);
}

module.exports = {
  normalizeSkillDirPath,
  resolveAuthorityDir,
  isRealSkillDir,
  materializeSkillDir,
  syncSkillContentToAuthority,
  copyDirRecursive,
  resolvePath,
  pathExists,
  pathsEqual,
};
