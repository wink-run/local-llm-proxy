// trae-support.js — Trae / Trae CN / TRAE SOLO 数据目录解析（官方订阅 + 会话导入）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** macOS / Windows / Linux 上 Trae 系应用 Support 目录候选（按优先级） */
function traeSupportCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO', 'Trae'].map(n => path.join(base, n));
  }
  if (process.platform === 'darwin') {
    return ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO', 'Trae']
      .map(n => path.join(home, 'Library', 'Application Support', n));
  }
  return ['trae-cn', 'trae-solo-cn', 'trae-solo', 'trae']
    .map(n => path.join(home, '.config', n));
}

/** 已安装的 Trae 系应用数据根目录（不存在则 null） */
function traeSupportDir() {
  for (const p of traeSupportCandidates()) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function traeStateDbPath() {
  const root = traeSupportDir();
  if (!root) return null;
  return path.join(root, 'User', 'globalStorage', 'state.vscdb');
}

function traeLogsDir() {
  const root = traeSupportDir();
  return root ? path.join(root, 'logs') : null;
}

/** TokenBank 归一化后的 Trae 会话用量导出目录（session-sync 写入） */
function traeSessionsExportDir() {
  return path.join(os.homedir(), '.tokenbank', 'trae-sessions');
}

module.exports = {
  traeSupportCandidates,
  traeSupportDir,
  traeStateDbPath,
  traeLogsDir,
  traeSessionsExportDir,
};
