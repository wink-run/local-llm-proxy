// client/electron/agent-linker.js
// 接入编排器：把 config-loader / shim-installer / injector / ca-manager / mitm-proxy 串起来。
// 对每个工具按 strategy 分派 apply / status / revert。全部数据来自 yaml（config-loader）。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

const configLoader = require('./config-loader');
const shim   = require('./shim-installer');
const inj    = require('./injector');
const ca     = require('./ca-manager');
const mitm   = require('./mitm-proxy');
const sysProxy = require('./system-proxy');

const TB_DIR = path.join(os.homedir(), '.tokenbank');
const APPLIED_DIR = path.join(TB_DIR, 'applied');

function gwHostPort() { return configLoader.gatewayCtx().reverse; }
function mitmHostPort() { return configLoader.gatewayCtx().mitm; }

// Appx 包是否已安装（GUI 桌面应用检测）
function appxInstalled(name) {
  if (process.platform !== 'win32' || !name) return false;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `if (Get-AppxPackage -Name '*${name}*') { 'yes' } else { 'no' }`],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out === 'yes';
  } catch { return false; }
}

// 工具是否已装：CLI 看命令；GUI(detect.appx) 看 Appx 包
function isInstalled(tool) {
  if (tool.detect && tool.detect.appx) return appxInstalled(tool.detect.appx);
  const cmd = tool.detect && tool.detect.command;
  if (!cmd) return false;
  return !!shim.resolveRealCommand(cmd);
}

// ── status：当前是否已接入网关（按 strategy）──
function status(tool) {
  const gw = gwHostPort();
  switch (tool.strategy) {
    case 'base_url-env':
      // env 类靠 shim 注入：shim 存在即视为已接入（shim 内含指向网关的 env）
      return shim.shimExists(tool.detect.command);
    case 'config-file':
      return inj.statusConfigFile(tool['config-file'], gw);
    case 'mitm-env':
      return shim.shimExists(tool.detect.command);
    case 'mitm-system':
      // GUI 应用：系统代理指向 MITM 即视为已托管
      return sysProxy.isEnabledTo(mitmHostPort());
    default:
      return false;
  }
}

// ── apply：接入（幂等）──
function apply(tool) {
  if (tool.unsupported) return { ok: false, error: 'unsupported', reason: tool.note || '该应用无法托管' };
  if (!isInstalled(tool)) return { ok: false, error: 'not-installed' };
  try {
    switch (tool.strategy) {
      case 'base_url-env': {
        const real = shim.resolveRealCommand(tool.detect.command);
        if (!real) return { ok: false, error: 'real-command-not-found' };
        shim.writeShim(tool.detect.command, real, (tool.inject && tool.inject.env) || {});
        shim.enablePath();
        return { ok: true, strategy: tool.strategy, needsRestartShell: true };
      }
      case 'config-file': {
        inj.applyConfigFile(tool.id, tool['config-file'], tool.patch || {});
        return { ok: true, strategy: tool.strategy };
      }
      case 'mitm-env': {
        const caInfo = ca.ensureCA();
        mitm.start();
        configLoader.setCaPath(caInfo.crt);
        const fresh = configLoader.tools().find(t => t.id === tool.id) || tool;
        const real = shim.resolveRealCommand(fresh.detect.command);
        if (!real) return { ok: false, error: 'real-command-not-found' };
        shim.writeShim(fresh.detect.command, real, (fresh.inject && fresh.inject.env) || {});
        shim.enablePath();
        return { ok: true, strategy: tool.strategy, needsRestartShell: true };
      }
      case 'mitm-system': {
        // GUI 应用：必须先把根 CA 装进系统信任库
        if (!ca.isInstalledInSystem()) {
          return { ok: false, error: 'ca-not-installed', needsCa: true };
        }
        const caInfo = ca.ensureCA();
        configLoader.setCaPath(caInfo.crt);
        mitm.start();
        const r = sysProxy.enable(mitmHostPort());
        if (!r.ok) return { ok: false, error: 'system-proxy-failed:' + r.error };
        return { ok: true, strategy: tool.strategy, needsAppRestart: true };
      }
      default:
        return { ok: false, error: 'unknown-strategy:' + tool.strategy };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── revert：还原（幂等）──
function revert(tool) {
  try {
    switch (tool.strategy) {
      case 'base_url-env':
        shim.removeShim(tool.detect.command);
        maybeDisablePath();
        return { ok: true };
      case 'config-file':
        return inj.revertConfigFile(tool.id);
      case 'mitm-env':
        shim.removeShim(tool.detect.command);
        maybeDisablePath();
        // 若没有其它 mitm 工具在用，停 MITM（这里简单处理：交给上层 stopIfIdle）
        return { ok: true };
      case 'mitm-system': {
        // 还原系统代理；若已无其它 GUI 应用在托管则停 MITM
        sysProxy.restore();
        const stillHosting = configLoader.tools().some(t =>
          t.strategy === 'mitm-system' && t.id !== tool.id && status(t));
        if (!stillHosting) { try { mitm.stop(); } catch {} }
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown-strategy' };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 仅当 bin 目录下已无任何 shim 时，才摘除 PATH（避免误删其它工具的接入）
function maybeDisablePath() {
  try {
    const binDir = shim.paths.BIN_DIR;
    const left = fs.existsSync(binDir) ? fs.readdirSync(binDir) : [];
    if (left.length === 0) shim.disablePath();
  } catch {}
}

// ── list：所有工具 + 状态（前端用）──
function list() {
  const tools = configLoader.tools();
  return tools.map(t => ({
    id: t.id, name: t.name, protocol: t.protocol, strategy: t.strategy,
    type: t.type || 'cli',          // cli | gui
    needs_ca: !!t.needs_ca,         // 是否需先装根证书
    unsupported: !!t.unsupported,   // 实测无法托管（如证书锁定）
    note: t.note || null,
    installed: isInstalled(t),
    linked: status(t),
  }));
}

// ── applyAll / revertAll ──
function applyAll() {
  const out = [];
  for (const t of configLoader.tools()) {
    if (!isInstalled(t)) { out.push({ id: t.id, skipped: 'not-installed' }); continue; }
    out.push({ id: t.id, ...apply(t) });
  }
  return out;
}

function revertAll() {
  const out = [];
  for (const t of configLoader.tools()) out.push({ id: t.id, ...revert(t) });
  // 全部还原后，若无 mitm 工具在用则停 MITM + 清 CA
  try { mitm.stop(); ca.cleanup(); } catch {}
  return out;
}

// 退出钩子用：把一切恢复原状
function revertEverythingOnExit() {
  try { revertAll(); } catch {}
}

// 按 id 操作（前端按钮）
function applyById(id)  { const t = configLoader.tools().find(x => x.id === id); return t ? apply(t)  : { ok:false, error:'no-such-tool' }; }
function revertById(id) { const t = configLoader.tools().find(x => x.id === id); return t ? revert(t) : { ok:false, error:'no-such-tool' }; }

module.exports = {
  list, apply, revert, status, applyAll, revertAll,
  applyById, revertById, revertEverythingOnExit,
};
