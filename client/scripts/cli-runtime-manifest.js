// CLI / Docker 与桌面版共用的 electron 运行时清单（单一真相源）
'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.join(__dirname, '..');
const ELECTRON_ROOT = path.join(CLIENT_ROOT, 'electron');

/** CLI 入口（与 Dockerfile.cli / gateway 一致） */
const CLI_ENTRY_POINTS = [
  path.join(CLIENT_ROOT, 'cli', 'gateway.js'),
  path.join(CLIENT_ROOT, 'cli', 'admin-api.js'),
  path.join(CLIENT_ROOT, 'cli', 'agent-control.js'),
];

/**
 * 仅 Electron 桌面壳使用，CLI/Docker 镜像中可安全删除。
 * 桌面版 electron-builder 仍打包完整 electron 目录（含这些文件）。
 */
const DESKTOP_ONLY_FILES = new Set([
  'main.js',
  'preload.js',
  'detect-tools.js',
  'agent-linker.js',
  'shim-installer.js',
  'mitm-proxy.js',
  'injector.js',
  'ca-manager.js',
  'entitlements.mac.plist',
]);

const DESKTOP_ONLY_DIRS = new Set([
  '__tests__',
]);

function isDesktopOnly(absPath) {
  const rel = path.relative(ELECTRON_ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep).filter(Boolean);
  if (!parts.length) return false;
  if (DESKTOP_ONLY_DIRS.has(parts[0])) return true;
  if (parts.length === 1 && DESKTOP_ONLY_FILES.has(parts[0])) return true;
  return false;
}

/** 解析 require 相对路径 → 绝对路径（仅处理 ./ ../） */
function resolveRequire(fromFile, reqPath) {
  if (!reqPath.startsWith('.')) return null;
  let base = path.resolve(path.dirname(fromFile), reqPath);
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    const idx = path.join(base, 'index.js');
    if (fs.existsSync(idx)) return idx;
  }
  if (fs.existsSync(base)) return base;
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.json`)) return `${base}.json`;
  return base.endsWith('.js') ? base : `${base}.js`;
}

/** 静态扫描 require()，收集 CLI 运行时依赖的本地 JS 文件 */
function collectRequiredLocalFiles(entryPath, seen = new Set(), missing = []) {
  if (seen.has(entryPath)) return { seen, missing };
  if (!fs.existsSync(entryPath)) {
    missing.push({ from: entryPath, req: '(entry missing)' });
    return { seen, missing };
  }
  seen.add(entryPath);

  const src = fs.readFileSync(entryPath, 'utf8');
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const req = m[1];
    const resolved = resolveRequire(entryPath, req);
    if (!resolved) continue;
    // 只追踪 client 目录内的源码
    if (!resolved.startsWith(CLIENT_ROOT)) continue;
    if (!fs.existsSync(resolved)) {
      missing.push({ from: entryPath, req, resolved });
      continue;
    }
    if (resolved.endsWith('.js')) {
      collectRequiredLocalFiles(resolved, seen, missing);
    }
  }
  return { seen, missing };
}

/** 从 CLI 入口递归收集全部依赖 */
function collectCliRuntimeDeps() {
  const seen = new Set();
  const missing = [];
  for (const entry of CLI_ENTRY_POINTS) {
    collectRequiredLocalFiles(entry, seen, missing);
  }
  return { files: [...seen].sort(), missing };
}

/** 剪枝后 electron 目录应仍能满足 CLI 依赖 */
function validatePrunedElectron(electronRoot = ELECTRON_ROOT) {
  const { files, missing } = collectCliRuntimeDeps();
  const prunedMissing = [];
  for (const f of files) {
    if (!f.startsWith(electronRoot)) continue;
    if (isDesktopOnly(f)) continue;
    const rel = path.relative(electronRoot, f);
    const check = path.join(electronRoot, rel);
    if (!fs.existsSync(check)) prunedMissing.push(check);
  }
  return { missing, prunedMissing, requiredElectron: files.filter(f => f.startsWith(ELECTRON_ROOT)) };
}

module.exports = {
  CLIENT_ROOT,
  ELECTRON_ROOT,
  CLI_ENTRY_POINTS,
  DESKTOP_ONLY_FILES,
  DESKTOP_ONLY_DIRS,
  isDesktopOnly,
  collectCliRuntimeDeps,
  validatePrunedElectron,
};
