// client/electron/detect-tools.js
// 探测本机已安装的 AI 编程工具 / 本地模型服务，判断它们是否已接入本网关。
//
// 注意：这里用"主动探测"而非"流量拦截"——网关是反向代理，工具只有被配置指向网关后
// 流量才经过它（鸡生蛋问题）。所以发现工具靠：① 命令是否可执行 ② 配置目录/文件
// ③ 本地服务端口。全部只读，不修改任何用户配置。
//
// 两类对象方向相反：
//   kind='client'   —— AI 客户端（Claude Code / Codex / Gemini）：要把它们指向网关
//   kind='upstream' —— 本地模型服务（Ollama）：要把它注册成网关的一个 provider
'use strict';

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

const GATEWAY_PORT = 11430;
const GATEWAY_HOSTS = ['127.0.0.1', 'localhost']; // base_url 含其一且端口匹配即视为已接入
const PROBE_TIMEOUT_MS = 4000;

// ── 跨平台执行命令探测可用性 ───────────────────────────────────────────────
// 返回 { ok, stdout, code }；命令不存在/超时/非零退出都算 ok:false，但区分原因。
function runProbe(cmd, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      // Windows 上 npm 装的 CLI 常是 .cmd，execFile 需要 shell 兜底
      child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, shell: process.platform === 'win32' },
        (err, stdout, stderr) => {
          if (err) {
            // ENOENT = 命令不存在；killed = 超时
            const reason = err.code === 'ENOENT' ? 'not-found' : (err.killed ? 'timeout' : 'error');
            return finish({ ok: false, reason, stdout: (stdout || '') + (stderr || '') });
          }
          finish({ ok: true, stdout: (stdout || '').trim() });
        });
    } catch (e) {
      return finish({ ok: false, reason: 'error', stdout: '' });
    }
    child?.on?.('error', () => finish({ ok: false, reason: 'not-found', stdout: '' }));
  });
}

// 探一个本地 TCP 服务是否在线（HTTP GET，短超时）。
function probeHttp(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get(url, { timeout: 1500 }, (res) => { res.resume(); finish(true); });
      req.on('error', () => finish(false));
      req.on('timeout', () => { req.destroy(); finish(false); });
    } catch { finish(false); }
  });
}

// 读文件（只读，失败返回 null）。
function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// 判断一个 base_url 字符串是否指向本网关：必须同时含本机 host 且含网关端口。
function pointsToGateway(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  const hasPort = baseUrl.includes(`:${GATEWAY_PORT}`);
  const hasHost = GATEWAY_HOSTS.some(h => baseUrl.includes(h));
  return hasHost && hasPort;
}

// ── 各工具的探测逻辑 ─────────────────────────────────────────────────────────

// Claude Code：命令 `claude --version`；配置 ~/.claude（CLAUDE_CONFIG_DIR 可覆盖）；
// 接入靠环境变量 ANTHROPIC_BASE_URL。
async function detectClaude() {
  const probe = await runProbe('claude', ['--version']);
  const installed = probe.ok;
  const version = installed ? (probe.stdout.match(/[\d.]+/)?.[0] || probe.stdout) : null;

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const hasConfig = fs.existsSync(configDir) || fs.existsSync(path.join(os.homedir(), '.claude.json'));

  // 接入判断：环境变量 ANTHROPIC_BASE_URL 指向网关
  const envBase = process.env.ANTHROPIC_BASE_URL || null;
  const linked = pointsToGateway(envBase);

  return {
    id: 'claude-code', name: 'Claude Code', kind: 'client', protocol: 'anthropic',
    installed, version, configDir: hasConfig ? configDir : null,
    linked, currentBaseUrl: envBase,
    linkVia: 'env',
    linkHint: `export ANTHROPIC_BASE_URL=http://localhost:${GATEWAY_PORT}`,
  };
}

// Codex：命令 `codex --version`；配置 CODEX_HOME 或 ~/.codex/config.toml；
// 接入靠 config.toml 里 base_url 指向网关。
async function detectCodex() {
  const probe = await runProbe('codex', ['--version']);
  const installed = probe.ok;
  const version = installed ? (probe.stdout.match(/[\d.]+/)?.[0] || probe.stdout) : null;

  const configDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = path.join(configDir, 'config.toml');
  const toml = readSafe(configPath);
  const hasConfig = toml != null;
  // 简单从 TOML 抽 base_url（不引 toml 解析库，正则足够判断接入）
  const baseUrl = toml ? (toml.match(/base_url\s*=\s*["']([^"']+)["']/)?.[1] || null) : null;
  const linked = pointsToGateway(baseUrl);

  return {
    id: 'codex', name: 'Codex', kind: 'client', protocol: 'responses',
    installed, version, configDir: hasConfig ? configDir : null,
    linked, currentBaseUrl: baseUrl,
    linkVia: 'config-file',
    linkHint: `写入 ${configPath}: model_provider=custom + [model_providers.custom] base_url="http://127.0.0.1:${GATEWAY_PORT}/v1" wire_api="responses"`,
  };
}

// Gemini CLI：命令 `gemini --version`；配置 ~/.gemini。
async function detectGemini() {
  const probe = await runProbe('gemini', ['--version']);
  const installed = probe.ok;
  const version = installed ? (probe.stdout.match(/[\d.]+/)?.[0] || probe.stdout) : null;

  const configDir = path.join(os.homedir(), '.gemini');
  const hasConfig = fs.existsSync(configDir);
  const envBase = process.env.GOOGLE_GEMINI_BASE_URL || process.env.GEMINI_BASE_URL || null;
  const linked = pointsToGateway(envBase);

  return {
    id: 'gemini', name: 'Gemini CLI', kind: 'client', protocol: 'gemini',
    installed, version, configDir: hasConfig ? configDir : null,
    linked, currentBaseUrl: envBase,
    linkVia: 'env',
    linkHint: `export GEMINI_BASE_URL=http://localhost:${GATEWAY_PORT}`,
  };
}

// Ollama：本地模型服务（上游，不是客户端）。命令 `ollama --version` 表示装了，
// 但"是否在线"要探端口 11434。它应被注册为网关的 provider。
async function detectOllama() {
  const probe = await runProbe('ollama', ['--version']);
  const installed = probe.ok;
  const version = installed ? (probe.stdout.match(/[\d.]+/)?.[0] || probe.stdout) : null;
  const serviceUp = await probeHttp('http://127.0.0.1:11434/api/tags');

  return {
    id: 'ollama', name: 'Ollama', kind: 'upstream', protocol: 'openai',
    installed, version, serviceUp,
    suggestedProvider: serviceUp ? { id: 'ollama', base_url: 'http://127.0.0.1:11434/v1', type: 'free', tier: 'free' } : null,
    linkHint: serviceUp ? '在 Providers 里把 Ollama 添加为本地 free provider（base_url=http://127.0.0.1:11434/v1）' : 'Ollama 未在 11434 运行',
  };
}

// 通用 OpenAI 兼容工具：靠环境变量 OPENAI_BASE_URL 接入（无法靠命令探测具体工具）。
function detectGenericOpenAI() {
  const envBase = process.env.OPENAI_BASE_URL || null;
  return {
    id: 'openai-generic', name: 'OpenAI 兼容工具（Cursor 等）', kind: 'client', protocol: 'openai',
    installed: null, version: null, configDir: null,
    linked: pointsToGateway(envBase), currentBaseUrl: envBase,
    linkVia: 'env',
    linkHint: `export OPENAI_BASE_URL=http://localhost:${GATEWAY_PORT}/v1`,
  };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 扫描本机 AI 工具与本地服务。
 * @returns {Promise<{ ok, gatewayPort, scannedAt, clients, upstreams }>}
 */
async function scan() {
  const results = await Promise.all([
    detectClaude(), detectCodex(), detectGemini(), detectOllama(),
  ]);
  results.push(detectGenericOpenAI());

  const clients = results.filter(r => r.kind === 'client');
  const upstreams = results.filter(r => r.kind === 'upstream');

  return {
    ok: true,
    gatewayPort: GATEWAY_PORT,
    // scannedAt 由调用方按需打时间戳（此处不依赖 Date 以保持纯函数性）
    clients,
    upstreams,
    summary: {
      installedClients: clients.filter(c => c.installed).length,
      linkedClients: clients.filter(c => c.linked).length,
      upstreamsOnline: upstreams.filter(u => u.serviceUp).length,
    },
  };
}

module.exports = { scan, _internal: { runProbe, probeHttp, pointsToGateway } };
