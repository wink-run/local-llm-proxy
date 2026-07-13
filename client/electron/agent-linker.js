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

// 由 main.js 注入：toolId → 该工具的多账号实例列表 [{config_dir, api_key, dir_glob, is_default}]
let _instancesResolver = null;
function setInstancesResolver(fn) { _instancesResolver = typeof fn === 'function' ? fn : null; }

// 多账号兜底实例（未匹配任何 dir_glob 目录时用它）：优先「用户显式留空 dir_glob 的实例」，
// 否则回落默认 CONFIG_DIR(~/.claude)实例，最后取第一个。不再把兜底硬绑 is_default。
function pickFallbackInstance(instances) {
  const list = Array.isArray(instances) ? instances : [];
  return list.find(i => i && !i.dir_glob) || list.find(i => i && i.is_default) || list[0] || null;
}

// 支持目录分发的 CLI 工具 → 其「配置目录」与「鉴权 token」环境变量名
const CLI_ENV = {
  'claude-code': { dirVar: 'CLAUDE_CONFIG_DIR', tokenVar: 'ANTHROPIC_AUTH_TOKEN' },
  'codex':       { dirVar: 'CODEX_HOME',        tokenVar: 'OPENAI_API_KEY' },
};

// 展开 dir_glob 里的 ~ 为 home，并去掉末尾分隔符（供 shim 前缀匹配）
function expandHome(p) {
  let s = String(p || '').trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  return s.replace(/[\\/]+$/, '');
}

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

// 工具是否已装（命令可执行）。
// 注意：不靠「配置/会话目录存在」判断——那不可靠（~/.gemini 可能是 Antigravity 造的、
// ~/.codex 被 Codex Desktop 共用），会把没装 CLI 的工具误报为已装。
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
        // 多账号目录分发（claude/codex）：有实例配了 dir_glob → 生成「按启动目录选实例」的 shim。
        // 默认实例作 base env，各 dir-bound 实例作分发项（$PWD 前缀命中即覆盖 CONFIG_DIR + token）。
        const cliEnv = CLI_ENV[tool.id];
        const instances = (cliEnv && _instancesResolver) ? (_instancesResolver(tool.id) || []) : [];
        // 分发项：selectEnv(选账号，永远执行) + gatewayEnv(走网关，探活门控)。
        // 路由态实例 → gatewayEnv 注 token；直连态实例 → gatewayEnv=null（探活块里 unset 网关 env，
        // 退回该 config-dir 自身配置：兼容端点读 settings.json / OAuth 读登录态）。
        const dispatch = instances
          .filter(i => i.dir_glob && i.config_dir)
          .map(i => ({
            dir: expandHome(i.dir_glob),
            selectEnv: { [cliEnv.dirVar]: i.config_dir },
            gatewayEnv: (i.routed && i.api_key) ? { [cliEnv.tokenVar]: i.api_key } : null,
          }))
          .sort((a, b) => b.dir.length - a.dir.length);   // 长前缀优先
        if (dispatch.length) {
          const def = pickFallbackInstance(instances);
          const defRouted = !!(def && def.routed && def.api_key);
          // 默认实例(未匹配任何目录时的兜底)：routed → token 进 base 网关 env(探活块)；
          // direct → base 不注 token，由 writeShim 的 defaultDirect 在兜底处 unset 网关 env
          // (走默认账号自己 config-dir 的配置，而非被指向网关)。CONFIG_DIR 永远选中(baseSelectEnv)。
          if (defRouted) env[cliEnv.tokenVar] = def.api_key;
          const baseSelectEnv = (def && def.config_dir) ? { [cliEnv.dirVar]: def.config_dir } : {};
          shim.writeShim(tool.detect.command, real, env, dispatch, baseSelectEnv, { defaultDirect: !defRouted });
          shim.enablePath();
          return { ok: true, strategy: tool.strategy, needsRestartShell: true };
        }
        // 单实例/无目录绑定：保持原逻辑。
        // Claude Code CLI（anthropic）：已绑路由(有 key)→注入 ANTHROPIC_AUTH_TOKEN 走 per-app keyScene；
        // 未绑→不注入，用自己的 OAuth 打网关(claudeShimScene 兜底)、保留组织 connectors。
        if (tool.protocol === 'anthropic') {
          const key = _keyResolver ? (_keyResolver(tool.id) || '') : '';
          if (key) env.ANTHROPIC_AUTH_TOKEN = key;
          else delete env.ANTHROPIC_AUTH_TOKEN;
        }
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
  applyById, revertById, revertEverythingOnExit, setKeyResolver, setInstancesResolver,
  pickFallbackInstance,
};
