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

const TB_DIR = path.join(os.homedir(), '.tokenbank');
const APPLIED_DIR = path.join(TB_DIR, 'applied');

function gwHostPort() { return configLoader.gatewayCtx().reverse; }

// 由 main.js 注入：toolId → 该 shim 应用的 api_key（用于解析 inject.env 里的 {KEY}）
let _keyResolver = null;
function setKeyResolver(fn) { _keyResolver = typeof fn === 'function' ? fn : null; }

// 解析 inject.env 里的 {KEY} 占位为该工具的 api_key。
// 关键：若 env 需要 key（含 {KEY}）但当前没有 key（用户未绑路由）→ 整组不注入，
// shim 纯透传走官方。否则只注入 base_url 而不带 key，会把工具导向网关却无法路由 → 反而搞挂。
function resolveEnvKeys(toolId, envMap) {
  const entries = Object.entries(envMap || {});
  const needsKey = entries.some(([, v]) => String(v).includes('{KEY}'));
  const key = _keyResolver ? (_keyResolver(toolId) || '') : '';
  if (needsKey && !key) return {};        // 未绑路由 → 不托管，纯透传
  const out = {};
  for (const [k, v] of entries) out[k] = String(v).replace(/\{KEY\}/g, key);
  return out;
}

// 工具是否已装（命令可执行）
function isInstalled(tool) {
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
        // route_bindable=false（如 Claude，客户端校验模型）→ 不注入，shim 纯透传走官方
        const env = tool.route_bindable === false ? {} : resolveEnvKeys(tool.id, (tool.inject && tool.inject.env) || {});
        shim.writeShim(tool.detect.command, real, env);
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
        shim.writeShim(fresh.detect.command, real, resolveEnvKeys(fresh.id, (fresh.inject && fresh.inject.env) || {}));
        shim.enablePath();
        return { ok: true, strategy: tool.strategy, needsRestartShell: true };
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
        return { ok: true };
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
    route_bindable: t.route_bindable !== false,  // 是否支持改模型/绑路由
    restrict_to_virtual: t.restrict_to_virtual === true,  // 仅限虚拟模型（Claude Code/Desktop）
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
  applyById, revertById, revertEverythingOnExit, setKeyResolver,
};
