'use strict';
/**
 * Codex 本地 app-server JSON-RPC（对齐 token-monitor readCodexRpc）。
 *
 * 优先于 chatgpt.com/wham/usage：不依赖外网直连 chatgpt.com，
 * 走本机 ChatGPT.app / Codex.app / PATH 上的 `codex app-server`。
 *
 * 协议：newline-delimited JSON-RPC
 *   initialize → initialized → account/rateLimits/read → account/read
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RPC_TIMEOUT_MS = 20_000;

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

/** 候选 `codex` 可执行文件（macOS 优先 ChatGPT.app 内置）。 */
function codexCommandCandidates(env = process.env, platform = process.platform) {
  if (env.TOKENBANK_CODEX_COMMAND || env.TOKEN_MONITOR_CODEX_COMMAND) {
    return [env.TOKENBANK_CODEX_COMMAND || env.TOKEN_MONITOR_CODEX_COMMAND];
  }
  const home = env.HOME || os.homedir();
  const out = [];
  if (platform === 'darwin') {
    // 应用包路径始终列入候选（不依赖本机是否已安装；spawn 时 ENOENT 再试下一个）
    out.push(
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    );
  }
  out.push(
    'codex',
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  );
  return unique(out).filter((cmd) => {
    if (!path.isAbsolute(cmd)) return true;
    // /Applications/*.app 内置 CLI：按平台列入，不因 CI/未安装而滤掉
    if (/^\/Applications\/[^/]+\.app\/Contents\/Resources\/codex$/.test(cmd)) return true;
    try { return fs.existsSync(cmd); } catch { return false; }
  });
}

function killTree(child) {
  if (!child || typeof child.kill !== 'function') return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); return; } catch { /* fallthrough */ }
    }
    child.kill('SIGTERM');
  } catch { /* ignore */ }
}

/** 在已 spawn 的 app-server 子进程上建 JSON-RPC 客户端。 */
function createJsonRpcClient(child, timeoutMs = RPC_TIMEOUT_MS) {
  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map();

  function rejectAll(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  function abort(error) {
    closed = true;
    rejectAll(error instanceof Error ? error : new Error(String(error || 'aborted')));
  }

  function handleMessage(message) {
    if (!message || message.id === undefined || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { handleMessage(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
    }
  });
  child.on('error', (error) => { closed = true; rejectAll(error); });
  child.on('close', (code) => {
    closed = true;
    rejectAll(new Error(`codex app-server exited ${code}`));
  });

  function send(method, params) {
    if (closed) return Promise.reject(new Error('codex app-server is closed'));
    const id = nextId++;
    const message = { method, id, params: params === undefined ? {} : params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  function notify(method, params) {
    if (closed) return;
    try {
      child.stdin.write(`${JSON.stringify({ method, params: params === undefined ? {} : params })}\n`);
    } catch { /* ignore */ }
  }

  return { abort, send, notify };
}

function spawnCodexAppServer(command, env = process.env) {
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  return spawn(command, ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: { ...env, CODEX_HOME: home },
    windowsHide: true,
  });
}

/**
 * 用指定 codex 二进制读账户额度。
 * @returns {{ account, rateLimits, rateLimitsByLimitId, sourceDetail }}
 */
async function readCodexRpcWithCommand(command, deps = {}) {
  const timeoutMs = Number(deps.timeoutMs || RPC_TIMEOUT_MS);
  const env = deps.env || process.env;
  const child = spawnCodexAppServer(command, env);
  const rpc = createJsonRpcClient(child, timeoutMs);
  try {
    await rpc.send('initialize', {
      clientInfo: { name: 'tokenbank', title: 'Token Bank', version: '0' },
    });
    rpc.notify('initialized', {});
    const rateLimitResult = await rpc.send('account/rateLimits/read', {});
    const accountResult = await rpc.send('account/read', {}).catch(() => null);
    const rateLimitsByLimitId = rateLimitResult?.rateLimitsByLimitId
      || rateLimitResult?.rate_limits_by_limit_id
      || {};
    const rateLimits = rateLimitResult?.rateLimits
      || rateLimitResult?.rate_limits
      || rateLimitsByLimitId.codex
      || {};
    return {
      account: accountResult?.account || null,
      rateLimits,
      rateLimitsByLimitId,
      rateLimitResetCredits: rateLimitResult?.rateLimitResetCredits
        || rateLimitResult?.rate_limit_reset_credits
        || null,
      sourceDetail: String(command).includes('/Applications/') ? 'app' : 'cli',
    };
  } finally {
    rpc.abort(new Error('codex app-server closed'));
    killTree(child);
  }
}

function shouldTryNextCommand(error) {
  if (error?.code === 'ENOENT') return true;
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('app-server exited')
    || message.includes('timed out')
    || message.includes('enoent')
    || message.includes('not found')
    || message.includes('spawn')
  );
}

/** 依次尝试候选 codex，成功即返回 RPC payload。 */
async function readCodexRpc(deps = {}) {
  const commands = deps.codexCommand
    ? [deps.codexCommand]
    : codexCommandCandidates(deps.env || process.env, deps.platform || process.platform);
  if (commands.length === 0) throw new Error('未找到 Codex CLI / ChatGPT.app');
  let lastError = null;
  for (const command of commands) {
    try {
      return await readCodexRpcWithCommand(command, deps);
    } catch (error) {
      lastError = error;
      if (!shouldTryNextCommand(error)) throw error;
    }
  }
  throw lastError || new Error('Codex RPC 不可用');
}

module.exports = {
  codexCommandCandidates,
  readCodexRpc,
  readCodexRpcWithCommand,
  createJsonRpcClient,
  RPC_TIMEOUT_MS,
};
