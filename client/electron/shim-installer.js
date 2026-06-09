// client/electron/shim-installer.js
// 透明拦截层：在 PATH 最前放同名 shim 脚本，用户敲命令先命中它，
// shim 设好环境变量后 exec 真程序、原样转发参数。跨平台（mac/linux/win）。
// 关键：写死真实路径防递归；所有改动带标记块，可精确还原。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

const TB_DIR  = path.join(os.homedir(), '.tokenbank');
const BIN_DIR = path.join(TB_DIR, 'bin');
const IS_WIN  = process.platform === 'win32';

const MARK_BEGIN = '# >>> tokenbank managed >>>';
const MARK_END   = '# <<< tokenbank managed <<<';

function ensureBinDir() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
}

// 探测命令真实路径（此时 shim 目录不应在 PATH 最前，避免探到自己）。
// 返回绝对路径或 null。结果缓存 30s —— apps:list 每次拉列表都要对每个 CLI 工具
// 跑一次 where/command -v 子进程，切 tab 反复拉列表会很慢；缓存后避免重复 spawn。
const _cmdCache = new Map();   // command -> { ts, path }
const CMD_TTL = 30000;
function resolveRealCommand(command) {
  const now = Date.now();
  const cached = _cmdCache.get(command);
  if (cached && (now - cached.ts) < CMD_TTL) return cached.path;
  // 把 BIN_DIR 从 PATH 里剔除再查，确保不命中自己的 shim
  const sep = IS_WIN ? ';' : ':';
  const cleanPath = (process.env.PATH || '')
    .split(sep).filter(p => path.resolve(p || '.') !== path.resolve(BIN_DIR)).join(sep);
  let result = null;
  try {
    if (IS_WIN) {
      // stdio 静音 stderr（命令不存在时 where 会往 stderr 打 INFO，无需显示）
      const out = execFileSync('where', [command], {
        env: { ...process.env, PATH: cleanPath },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const first = out.split(/\r?\n/).find(l => l.trim());
      result = first ? first.trim() : null;
    } else {
      const out = execFileSync('sh', ['-lc', `command -v ${command}`], {
        env: { ...process.env, PATH: cleanPath },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      result = out.trim() || null;
    }
  } catch { result = null; }
  _cmdCache.set(command, { ts: now, path: result });
  return result;
}

// 生成一个工具的 shim。envMap = {KEY: value}（要注入的环境变量）。
// realPath = 真实可执行文件绝对路径（已探测、写死）。
// 从注入的 env 值里取网关 origin（http://host:port），用于探活
function probeOrigin(envMap) {
  for (const v of Object.values(envMap || {})) {
    const m = String(v).match(/^(https?:\/\/[^/]+)/);
    if (m) return m[1];
  }
  return null;
}

// shim 注入网关 env，但先探活：网关 /health 通才注入（否则直接调真程序走官方）。
// 这样网关没启动时 shim 不会把工具指向死端口 —— 透明托管对“网关未运行”自动回落。
function writeShim(command, realPath, envMap) {
  ensureBinDir();
  const exports = Object.entries(envMap || {});
  const origin  = probeOrigin(envMap);
  let shimPath;
  if (IS_WIN) {
    shimPath = path.join(BIN_DIR, command + '.cmd');
    let lines;
    if (origin && exports.length) {
      lines = [
        '@echo off',
        'REM ' + MARK_BEGIN,
        // 探活：curl 通(exit 0)才注入网关 env；不通则跳过 → 走官方
        `curl.exe -s -o NUL -m 1 "${origin}/health" >NUL 2>NUL`,
        'if %errorlevel%==0 (',
        ...exports.map(([k, v]) => `  set "${k}=${v}"`),
        ')',
        `"${realPath}" %*`,
        'REM ' + MARK_END,
      ];
    } else {
      lines = ['@echo off', 'REM ' + MARK_BEGIN, `"${realPath}" %*`, 'REM ' + MARK_END];
    }
    fs.writeFileSync(shimPath, lines.join('\r\n'));
  } else {
    shimPath = path.join(BIN_DIR, command);
    let lines;
    if (origin && exports.length) {
      lines = [
        '#!/bin/sh',
        MARK_BEGIN,
        `if curl -s -o /dev/null -m 1 "${origin}/health" 2>/dev/null; then`,
        ...exports.map(([k, v]) => `  export ${k}="${v}"`),
        'fi',
        `exec "${realPath}" "$@"`,
        MARK_END,
      ];
    } else {
      lines = ['#!/bin/sh', MARK_BEGIN, `exec "${realPath}" "$@"`, MARK_END];
    }
    fs.writeFileSync(shimPath, lines.join('\n'));
    fs.chmodSync(shimPath, 0o755);
  }
  return shimPath;
}

function removeShim(command) {
  const p = IS_WIN ? path.join(BIN_DIR, command + '.cmd') : path.join(BIN_DIR, command);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function shimExists(command) {
  const p = IS_WIN ? path.join(BIN_DIR, command + '.cmd') : path.join(BIN_DIR, command);
  return fs.existsSync(p);
}

// ── PATH 管理 ────────────────────────────────────────────────────────────────
// 把 BIN_DIR 加到 PATH 最前。mac/linux 写 rc 文件（标记块）；win 改用户环境变量。

function shellRcFiles() {
  const home = os.homedir();
  // 覆盖常见 shell；存在哪个就写哪个，都不存在则写 .profile
  const candidates = ['.zshrc', '.bashrc', '.profile', '.bash_profile'].map(f => path.join(home, f));
  const existing = candidates.filter(f => fs.existsSync(f));
  return existing.length ? existing : [path.join(home, '.profile')];
}

function pathBlock() {
  return `${MARK_BEGIN}\nexport PATH="${BIN_DIR}:$PATH"\n${MARK_END}\n`;
}

function enablePath() {
  ensureBinDir();
  if (IS_WIN) {
    // 读当前用户 PATH，前置 BIN_DIR（去重），用 setx 持久化
    let cur = '';
    try { cur = execFileSync('powershell', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','User')"]).toString().trim(); } catch {}
    const parts = cur.split(';').filter(Boolean);
    if (parts.map(p => p.toLowerCase()).includes(BIN_DIR.toLowerCase())) return { changed: false };
    const next = [BIN_DIR, ...parts].join(';');
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `[Environment]::SetEnvironmentVariable('Path', '${next.replace(/'/g, "''")}', 'User')`]);
      return { changed: true, scope: 'win-user-path' };
    } catch (e) { return { changed: false, error: e.message }; }
  } else {
    const written = [];
    for (const rc of shellRcFiles()) {
      let txt = '';
      try { txt = fs.readFileSync(rc, 'utf8'); } catch {}
      if (txt.includes(MARK_BEGIN)) continue;         // 已有标记块，跳过
      fs.appendFileSync(rc, '\n' + pathBlock());
      written.push(rc);
    }
    return { changed: written.length > 0, files: written };
  }
}

function disablePath() {
  if (IS_WIN) {
    let cur = '';
    try { cur = execFileSync('powershell', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','User')"]).toString().trim(); } catch {}
    const parts = cur.split(';').filter(Boolean).filter(p => p.toLowerCase() !== BIN_DIR.toLowerCase());
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `[Environment]::SetEnvironmentVariable('Path', '${parts.join(';').replace(/'/g, "''")}', 'User')`]);
      return { changed: true };
    } catch (e) { return { changed: false, error: e.message }; }
  } else {
    const cleaned = [];
    for (const rc of shellRcFiles()) {
      let txt = '';
      try { txt = fs.readFileSync(rc, 'utf8'); } catch { continue; }
      if (!txt.includes(MARK_BEGIN)) continue;
      // 删除标记块（含块内所有行）
      const re = new RegExp(`\\n?${escapeRe(MARK_BEGIN)}[\\s\\S]*?${escapeRe(MARK_END)}\\n?`, 'g');
      const next = txt.replace(re, '\n');
      fs.writeFileSync(rc, next);
      cleaned.push(rc);
    }
    return { changed: cleaned.length > 0, files: cleaned };
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = {
  resolveRealCommand, writeShim, removeShim, shimExists,
  enablePath, disablePath,
  paths: { BIN_DIR }, MARK_BEGIN, MARK_END,
};
