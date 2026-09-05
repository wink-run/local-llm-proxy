'use strict';
// 跨平台 MCP/hook 启动：不要直接 exec Token Bank 写出的脚本。
// - macOS：quarantine → 直接 spawn .sh 会 EPERM
// - Linux/Docker：noexec 卷同样 EPERM；Alpine 没有 bash，只有 /bin/sh
// - Windows：GUI Agent 的 PATH 往往找不到 cmd.exe；.cmd 须经绝对路径 cmd.exe /c
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function clearMacQuarantine(filePath) {
  if (process.platform !== 'darwin' || !filePath) return;
  try {
    execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', String(filePath)], {
      stdio: 'ignore',
      timeout: 2000,
    });
  } catch { /* 无该属性或无权限时忽略 */ }
}

/** Windows 从网上下载的文件会带 Zone.Identifier，直接 spawn .cmd 可能被拦截 */
function clearWinZoneIdentifier(filePath) {
  if (process.platform !== 'win32' || !filePath) return;
  try { fs.unlinkSync(`${filePath}:Zone.Identifier`); } catch { /* 无 ADS 时忽略 */ }
}

function clearExecRestrictions(filePath) {
  clearMacQuarantine(filePath);
  clearWinZoneIdentifier(filePath);
}

/** Alpine / slim 镜像通常只有 /bin/sh；macOS 两者都有。优先 sh。 */
function resolveUnixShell() {
  for (const c of ['/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash']) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return '/bin/sh';
}

/** GUI 进程 PATH 常不含 System32；用 ComSpec / SystemRoot 拼绝对路径。 */
function resolveCmdExe() {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec;
    if (comspec && fs.existsSync(comspec)) return comspec;
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const abs = path.join(root, 'System32', 'cmd.exe');
    if (fs.existsSync(abs)) return abs;
    return comspec || 'cmd.exe';
  }
  // 在 mac/linux 上单测 platform=win32 时的占位
  return process.env.ComSpec || 'cmd.exe';
}

/**
 * 将 launcher 转成 MCP stdio 的 command/args。
 * 永远 spawn 系统壳去读脚本，避免直接 exec 用户目录文件。
 */
function mcpStdioFromLauncher(launcherPath, extraEnv = {}, platform = process.platform) {
  const launcher = String(launcherPath || '');
  const env = { ...(extraEnv || {}) };
  if (platform === 'win32') {
    const quoted = `"${launcher.replace(/"/g, '')}"`;
    return {
      command: resolveCmdExe(),
      args: ['/d', '/s', '/c', quoted],
      env,
    };
  }
  return { command: resolveUnixShell(), args: [launcher], env };
}

module.exports = {
  clearMacQuarantine,
  clearWinZoneIdentifier,
  clearExecRestrictions,
  resolveUnixShell,
  resolveCmdExe,
  mcpStdioFromLauncher,
};
