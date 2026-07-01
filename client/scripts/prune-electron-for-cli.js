#!/usr/bin/env node
// Docker 构建阶段：删除仅桌面版使用的 electron 文件（与 cli-runtime-manifest 对齐）
'use strict';

const fs = require('fs');
const path = require('path');
const {
  ELECTRON_ROOT,
  DESKTOP_ONLY_FILES,
  DESKTOP_ONLY_DIRS,
  validatePrunedElectron,
} = require('./cli-runtime-manifest');

/** 防止在开发工作区误删源码：仅 Docker(/app) 或显式允许时执行 */
function pruneTargetRoot() {
  if (process.env.CLI_PRUNE_ELECTRON_ROOT) {
    return path.resolve(process.env.CLI_PRUNE_ELECTRON_ROOT);
  }
  if (process.env.CLI_PRUNE_ALLOW === '1') return ELECTRON_ROOT;
  if (ELECTRON_ROOT.startsWith('/app/') || ELECTRON_ROOT === '/app/electron') {
    return ELECTRON_ROOT;
  }
  // Dockerfile WORKDIR /app → electron 在 /app/electron
  const dockerRoot = path.join('/app', 'electron');
  if (fs.existsSync(dockerRoot)) return dockerRoot;
  console.error(
    '[prune-cli] refused: would modify dev tree at',
    ELECTRON_ROOT,
    '\n  Docker build runs this automatically.',
    '\n  Local dry-run: CLI_PRUNE_ALLOW=1 node scripts/prune-electron-for-cli.js',
  );
  process.exit(1);
}

function rm(root, name) {
  const target = path.join(root, name);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log('[prune-cli] removed', name);
  } catch (e) {
    console.warn('[prune-cli] skip', name, e.message);
  }
}

const root = pruneTargetRoot();
if (!fs.existsSync(root)) {
  console.error('[prune-cli] electron dir not found:', root);
  process.exit(1);
}

for (const name of DESKTOP_ONLY_FILES) rm(root, name);
for (const dir of DESKTOP_ONLY_DIRS) rm(root, dir);

const { missing, prunedMissing } = validatePrunedElectron(root);
if (missing.length) {
  console.error('[prune-cli] unresolved requires in source tree:');
  for (const m of missing) console.error(' ', m.from, '→', m.req, m.resolved || '');
  process.exit(1);
}
if (prunedMissing.length) {
  console.error('[prune-cli] CLI deps missing after prune:');
  for (const f of prunedMissing) console.error(' ', f);
  process.exit(1);
}

console.log('[prune-cli] ok — electron runtime aligned with desktop gateway modules');
