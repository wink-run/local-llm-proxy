/**
 * Inline Node.js agent — runs directly in the Electron main process.
 * Connects to the proxy server via WebSocket, forwards requests to the local LLM.
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.llm-agent', 'config.json');
const { normalizeAgentForwardCfg } = require('../shared/agent-forward-url');

let ws = null;
let running = false;
let _onLog = null;
let _onStatus = null;

// ── Stats ─────────────────────────────────────────────────────────────────────
let activeRequests = 0;
// Sliding token window: [{ts, tokens}] — used to compute tokens/min
const tokenWindow = [];
const TOKEN_WINDOW_MS = 60000;

function recordTokens(n) {
  const now = Date.now();
  tokenWindow.push({ ts: now, n });
  // trim old entries
  const cutoff = now - TOKEN_WINDOW_MS;
  while (tokenWindow.length && tokenWindow[0].ts < cutoff) tokenWindow.shift();
}

function getStats() {
  const now = Date.now();
  const cutoff = now - TOKEN_WINDOW_MS;
  const recent = tokenWindow.filter(e => e.ts >= cutoff);
  const tokensPerMin = recent.reduce((s, e) => s + e.n, 0);
  return { running, activeRequests, tokensPerMin };
}

function log(msg) { _onLog?.(msg); }

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return null; }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** 从贡献配置中移除指定模型（服务端下线通知后持久化） */
function removeModelsFromCfg(cfg, names) {
  const drop = new Set(names);
  const keepModel = (m) => {
    const n = typeof m === 'string' ? m : m?.name;
    return n && !drop.has(n);
  };
  if (cfg.model_groups?.length) {
    for (const g of cfg.model_groups) {
      g.models = (g.models || []).filter(keepModel);
    }
  }
  if (Array.isArray(cfg.models)) {
    cfg.models = cfg.models.filter(keepModel);
  }
  return cfg;
}

function applyOfflineModels(names, reason) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return;
  const cfg = loadConfig();
  if (!cfg) return;
  const before = new Set(contributedModelNames(cfg));
  const removed = list.filter(n => before.has(n));
  if (!removed.length) return;
  saveConfig(removeModelsFromCfg(cfg, removed));
  log(`[agent] 模型已下线: ${removed.join(', ')}${reason ? ` (${reason})` : ''}`);
}

// ── Anthropic ↔ OpenAI conversion ─────────────────────────────────────────────

function isAnthropicStyle(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.pathname.toLowerCase().includes('anthropic') ||
           u.hostname.toLowerCase().includes('anthropic');
  } catch { return false; }
}

function openaiToAnthropic(payload) {
  const msgs = payload.messages || [];
  const sys = msgs.find(m => m.role === 'system');
  const sysText = !sys ? undefined
    : typeof sys.content === 'string' ? sys.content
    : Array.isArray(sys.content) ? sys.content.map(b => b.text || '').join('') : '';
  return {
    model: payload.model,
    max_tokens: payload.max_tokens || 8096,
    stream: !!payload.stream,
    messages: msgs.filter(m => m.role !== 'system'),
    ...(sysText ? { system: sysText } : {}),
  };
}

function anthropicToOpenAI(body) {
  const text = (body.content || []).map(b => b.text || '').join('');
  return {
    id: body.id || 'chatcmpl-0',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || '',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: body.usage ? {
      prompt_tokens: body.usage.input_tokens,
      completion_tokens: body.usage.output_tokens,
      total_tokens: (body.usage.input_tokens || 0) + (body.usage.output_tokens || 0),
    } : undefined,
  };
}

// Parse buffered Anthropic SSE (event+data pairs) and emit OpenAI SSE lines.
// Returns { lines: string[], usage: object|null }
function parseAnthropicSSE(buf, model) {
  const lines = [];
  let usage = null;
  const blocks = buf.split(/\n\n+/);
  for (const block of blocks) {
    let eventType = null;
    let dataStr = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr = line.slice(5).trim();
    }
    if (!eventType || !dataStr) continue;
    let data;
    try { data = JSON.parse(dataStr); } catch { continue; }

    if (eventType === 'content_block_delta' && data.delta?.type === 'text_delta') {
      lines.push('data: ' + JSON.stringify({
        id: 'chatcmpl-0', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }],
      }));
    } else if (eventType === 'message_delta') {
      // 保留 message_start 已拿到的 input_tokens，不要用 0 覆盖（否则输入 token 漏记账）
      if (data.usage) { const inTok = (usage && usage.prompt_tokens) || 0; const outTok = data.usage.output_tokens || 0; usage = { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok }; }
      lines.push('data: ' + JSON.stringify({
        id: 'chatcmpl-0', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: data.delta?.stop_reason || 'stop' }],
      }));
    } else if (eventType === 'message_start' && data.message?.usage) {
      usage = { prompt_tokens: data.message.usage.input_tokens, completion_tokens: 0, total_tokens: data.message.usage.input_tokens };
    } else if (eventType === 'message_stop') {
      lines.push('data: [DONE]');
    }
  }
  return { lines, usage };
}

// ── Per-model config resolution ───────────────────────────────────────────────

function resolveModelCfg(cfg, modelName) {
  if (cfg.model_groups?.length) {
    const group = cfg.model_groups.find(g =>
      (g.models || []).some(m => (typeof m === 'string' ? m : m.name) === modelName)
    );
    if (group?.base_url) {
      return normalizeAgentForwardCfg({
        ...cfg,
        llm_base_url: group.base_url,
        llm_token: group.token || '',
      });
    }
    return normalizeAgentForwardCfg(cfg);
  }
  // legacy per-model base_url
  const entry = (cfg.models || []).find(m =>
    (typeof m === 'string' ? m : m.name) === modelName
  );
  if (!entry || typeof entry === 'string' || !entry.base_url) return normalizeAgentForwardCfg(cfg);
  return normalizeAgentForwardCfg({ ...cfg, llm_base_url: entry.base_url });
}

/** 贡献节点已声明、可对外提供的模型名 */
function contributedModelNames(cfg) {
  if (cfg.model_groups?.length) {
    return cfg.model_groups.flatMap(g => (g.models || []).map(m => (typeof m === 'string' ? m : m.name)));
  }
  return (cfg.models || []).map(m => (typeof m === 'string' ? m : m.name));
}

/** 未在贡献配置中的模型直接拒绝，避免误走本地网关 P2P 回环并报 API Key 错误 */
function assertModelContributed(cfg, modelName) {
  const names = new Set(contributedModelNames(cfg).filter(Boolean));
  if (!names.has(modelName)) {
    throw new Error(`Model '${modelName}' is not configured on this contributor node`);
  }
}

// ── HTTP forward ──────────────────────────────────────────────────────────────

function openaiCompletionPath(baseUrl, explicitChatPath) {
  const e = (explicitChatPath || '').trim().replace(/^\//, '');
  if (e) return e;
  const base = baseUrl.trim().replace(/\/+$/, '');
  const lower = base.toLowerCase();
  if (
    /\/v\d+(\/|$)/.test(base) ||
    lower.includes('compatible-mode') ||
    lower.includes('bigmodel.cn') ||
    lower.includes('volces.com/api') ||
    lower.includes('qianfan.baidubce.com') ||
    (lower.includes('generativelanguage.googleapis.com') && lower.includes('openai'))
  ) {
    return 'chat/completions';
  }
  return 'v1/chat/completions';
}

function buildUrl(baseUrl, anthropic, explicitChatPath) {
  const base = baseUrl.replace(/\/+$/, '');
  if (anthropic) {
    const v1Base = base.endsWith('/v1') ? base : `${base}/v1`;
    return new URL(`${v1Base}/messages`);
  }
  const path = openaiCompletionPath(baseUrl, explicitChatPath);
  const baseForJoin = base.endsWith('/') ? base : `${base}/`;
  return new URL(path, baseForJoin);
}

// OAI 流式需 stream_options.include_usage 才在末帧返回 usage
function withUsageOption(body) {
  if (!body?.stream || body.stream_options) return body;
  return { ...body, stream_options: { include_usage: true } };
}

function extractText(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  const push = (c) => {
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) for (const s of c) {
      if (typeof s === 'string') parts.push(s);
      else if (s && typeof s.text === 'string') parts.push(s.text);
    }
  };
  if (Array.isArray(body.messages)) for (const m of body.messages) push(m && m.content);
  if (typeof body.prompt === 'string') parts.push(body.prompt);
  return parts.join('\n');
}

/** 流式仅有 output 时粗估 input（与服务端 usage_utils 对齐） */
function fillMissingInputUsage(usage, body) {
  if (!usage || !body) return usage;
  const inTok = usage.prompt_tokens || usage.input_tokens || 0;
  const outTok = usage.completion_tokens || usage.output_tokens || 0;
  if (inTok || !outTok) return usage;
  const est = Math.max(1, Math.ceil(extractText(body).length / 4));
  return {
    ...usage,
    prompt_tokens: est,
    input_tokens: est,
    total_tokens: est + outTok,
  };
}

function forwardRequest(reqId, payload, cfg) {
  const anthropic  = isAnthropicStyle(cfg.llm_base_url);
  const outPayload = anthropic ? openaiToAnthropic(payload) : withUsageOption(payload);

  const url = buildUrl(cfg.llm_base_url, anthropic, cfg.llm_chat_path);
  const mod = url.protocol === 'https:' ? https : http;
  const streaming = payload.stream === true;
  const body = JSON.stringify(outPayload);

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-P2P-Hop': '1',  // tells the gateway to skip P2P to break forwarding loops
  };
  if (cfg.llm_token) headers['Authorization'] = `Bearer ${cfg.llm_token}`;
  if (anthropic) headers['anthropic-version'] = '2023-06-01';

  return new Promise((resolve) => {
    const req = mod.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST', headers, timeout: 120000 },
      (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            send({ type: 'error', req_id: reqId, error: `HTTP ${res.statusCode}: ${raw.slice(0, 500)}` });
            resolve();
          });
          res.on('error', (e) => { send({ type: 'error', req_id: reqId, error: e.message }); resolve(); });
          return;
        }
        if (streaming) {
          let buf = '';
          let lastUsage = null;

          res.on('data', (chunk) => {
            buf += chunk.toString();

            if (anthropic) {
              // Anthropic SSE: parse complete event blocks (separated by blank lines)
              const boundary = buf.lastIndexOf('\n\n');
              if (boundary === -1) return;
              const complete = buf.slice(0, boundary + 2);
              buf = buf.slice(boundary + 2);
              const { lines, usage } = parseAnthropicSSE(complete, payload.model);
              if (usage) lastUsage = usage;
              for (const line of lines) send({ type: 'chunk', req_id: reqId, data: line + '\n\n' });
            } else {
              // OpenAI SSE: pass through line by line
              const lines = buf.split('\n');
              buf = lines.pop();
              for (const line of lines) {
                const trimmed = line.trimEnd();
                if (!trimmed) continue;
                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                  try { const d = JSON.parse(trimmed.slice(6)); if (d.usage) lastUsage = d.usage; } catch {}
                }
                send({ type: 'chunk', req_id: reqId, data: trimmed + '\n\n' });
              }
            }
          });

          res.on('end', () => {
            if (anthropic && buf.trim()) {
              const { lines, usage } = parseAnthropicSSE(buf, payload.model);
              if (usage) lastUsage = usage;
              for (const line of lines) send({ type: 'chunk', req_id: reqId, data: line + '\n\n' });
            } else if (buf.trim()) {
              send({ type: 'chunk', req_id: reqId, data: buf.trim() + '\n\n' });
            }
            if (lastUsage?.completion_tokens) recordTokens(lastUsage.completion_tokens);
            else if (lastUsage?.output_tokens) recordTokens(lastUsage.output_tokens);
            send({ type: 'done', req_id: reqId, usage: fillMissingInputUsage(lastUsage, payload) });
            resolve();
          });

          res.on('error', (e) => { send({ type: 'error', req_id: reqId, error: e.message }); resolve(); });
        } else {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            let rawBody = Buffer.concat(chunks).toString();
            let usage = null;
            try {
              const json = JSON.parse(rawBody);
              if (json?.error) {
                send({ type: 'error', req_id: reqId, error: `HTTP ${res.statusCode}: ${rawBody.slice(0, 500)}` });
                resolve();
                return;
              }
              if (anthropic) {
                const converted = anthropicToOpenAI(json);
                usage = converted.usage;
                rawBody = JSON.stringify(converted);
              } else {
                usage = json.usage;
              }
            } catch {}
            if (usage?.completion_tokens) recordTokens(usage.completion_tokens);
            else if (usage?.output_tokens) recordTokens(usage.output_tokens);
            send({ type: 'chunk', req_id: reqId, data: rawBody });
            send({ type: 'done', req_id: reqId, usage });
            resolve();
          });
          res.on('error', (e) => { send({ type: 'error', req_id: reqId, error: e.message }); resolve(); });
        }
      }
    );

    req.on('error', (e) => { send({ type: 'error', req_id: reqId, error: e.message }); resolve(); });
    req.on('timeout', () => { req.destroy(); send({ type: 'error', req_id: reqId, error: 'LLM request timeout' }); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Image generation forward ──────────────────────────────────────────────────

function imageGenPath(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+(\/|$)/.test(base)) return 'images/generations';
  return 'v1/images/generations';
}

function forwardImageRequest(reqId, payload, cfg) {
  const base = cfg.llm_base_url.replace(/\/+$/, '');
  const p = imageGenPath(cfg.llm_base_url);
  const url = new URL(`${base.endsWith('/') ? base : base + '/'}${p}`);
  const mod = url.protocol === 'https:' ? https : http;

  // Always request b64_json so agent can relay raw bytes without file I/O
  const outPayload = { ...payload, response_format: 'b64_json' };
  const body = JSON.stringify(outPayload);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-P2P-Hop': '1',  // 贡献节点转发：禁止本地网关再回 P2P
  };
  if (cfg.llm_token) headers['Authorization'] = `Bearer ${cfg.llm_token}`;

  return new Promise((resolve) => {
    const req = mod.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST', headers, timeout: 120000 },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            const rawStr = Buffer.concat(chunks).toString();
            log(`[agent] image upstream status=${res.statusCode} body[:300]=${rawStr.slice(0, 300)}`);
            if (res.statusCode >= 400) {
              send({ type: 'error', req_id: reqId, error: `HTTP ${res.statusCode}: ${rawStr.slice(0, 300)}` });
              resolve();
              return;
            }
            const json = JSON.parse(rawStr);
            const images = (json.data || []).map(item => ({
              b64: item.b64_json || '',
              revised_prompt: item.revised_prompt,
            }));
            if (images.length === 0) {
              log(`[agent] image upstream returned no images, full body: ${rawStr.slice(0, 500)}`);
            }
            send({ type: 'image_done', req_id: reqId, images });
          } catch (e) {
            send({ type: 'error', req_id: reqId, error: `image parse error: ${e.message}` });
          }
          resolve();
        });
        res.on('error', (e) => { send({ type: 'error', req_id: reqId, error: e.message }); resolve(); });
      }
    );
    req.on('error', (e) => { send({ type: 'error', req_id: reqId, error: e.message }); resolve(); });
    req.on('timeout', () => { req.destroy(); send({ type: 'error', req_id: reqId, error: 'image request timeout' }); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── 公网 IP（WebSocket 连 localhost 时服务端只能看到 127.0.0.1，需客户端主动上报）──

let _cachedPublicIp = null;
let _cachedPublicIpAt = 0;
const PUBLIC_IP_TTL_MS = 5 * 60 * 1000;

/** 简单 IPv4 公网校验（与服务端 is_global 语义一致，够用即可） */
function isPublicIpv4(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(ip || '').trim());
  if (!m) return false;
  const o = m.slice(1, 5).map(Number);
  if (o.some(n => n > 255)) return false;
  if (o[0] === 10) return false;
  if (o[0] === 127) return false;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
  if (o[0] === 192 && o[1] === 168) return false;
  if (o[0] === 169 && o[1] === 254) return false;
  return true;
}

function httpGetText(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'tokenbank-agent/1.0' } }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** 多源探测公网 IP，失败返回 null（不阻塞 Agent 注册） */
async function fetchPublicIp() {
  const now = Date.now();
  if (_cachedPublicIp && now - _cachedPublicIpAt < PUBLIC_IP_TTL_MS) {
    return _cachedPublicIp;
  }
  const providers = [
    async () => {
      const body = await httpGetText('https://api.ipify.org?format=json');
      const ip = JSON.parse(body).ip;
      return isPublicIpv4(ip) ? ip : null;
    },
    async () => {
      const body = await httpGetText('https://cloudflare.com/cdn-cgi/trace');
      const m = body.match(/^ip=(.+)$/m);
      const ip = m ? m[1].trim() : '';
      return isPublicIpv4(ip) ? ip : null;
    },
    async () => {
      const ip = (await httpGetText('https://ifconfig.me/ip')).trim();
      return isPublicIpv4(ip) ? ip : null;
    },
    async () => {
      const ip = (await httpGetText('https://api.ip.sb/ip')).trim();
      return isPublicIpv4(ip) ? ip : null;
    },
  ];
  for (const probe of providers) {
    try {
      const ip = await probe();
      if (ip) {
        _cachedPublicIp = ip;
        _cachedPublicIpAt = now;
        return ip;
      }
    } catch { /* 换下一个源 */ }
  }
  return null;
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── WebSocket session ─────────────────────────────────────────────────────────

function connect(cfg) {
  log(`[agent] connecting → ${cfg.server_url}`);
  ws = new WebSocket(cfg.server_url, { handshakeTimeout: 10000 });

  ws.on('open', () => {
    (async () => {
      const models = cfg.model_groups?.length
        ? cfg.model_groups.flatMap(g => g.models || [])
        : (cfg.models || []);
      const regMsg = {
        type: 'register',
        worker_key: cfg.worker_key,
        models,
        name: cfg.name || os.hostname(),
      };
      if (cfg.contribute_circle_ids?.length) {
        regMsg.circle_ids = cfg.contribute_circle_ids;
      } else if (cfg.contribute_circle_id) {
        regMsg.circle_ids = [cfg.contribute_circle_id];
      }
      const publicIp = await fetchPublicIp();
      if (publicIp) {
        regMsg.public_ip = publicIp;
        log(`[agent] public_ip=${publicIp}`);
      } else {
        log('[agent] public_ip unavailable — map may use fallback location');
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(regMsg));
      }
    })();
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'registered') {
      log(`[agent] connected worker_id=${msg.worker_id}`);
      const allModels = cfg.model_groups?.length
        ? cfg.model_groups.flatMap(g => g.models || [])
        : (cfg.models || []);
      const modelsSummary = allModels
        .map(m => typeof m === 'string' ? m : `${m.name}(${m.type || 'chat'})`)
        .join(', ');
      log(`[agent] models: ${modelsSummary}`);
      return;
    }

    if (msg.type === 'offline_models') {
      applyOfflineModels(msg.models, msg.reason);
      return;
    }

    if (msg.type === 'request') {
      const { req_id, payload } = msg;
      log(`[agent] → req_id=${req_id} model=${payload.model} stream=${!!payload.stream}`);
      activeRequests++;
      try {
        const liveCfg = loadConfig() || cfg;
        assertModelContributed(liveCfg, payload.model);
        await forwardRequest(req_id, payload, resolveModelCfg(liveCfg, payload.model));
      } catch (e) {
        log(`[agent] error req_id=${req_id}: ${e.message}`);
        send({ type: 'error', req_id, error: e.message });
      } finally {
        activeRequests = Math.max(0, activeRequests - 1);
      }
    }

    if (msg.type === 'image_request') {
      const { req_id, payload } = msg;
      log(`[agent] image → req_id=${req_id} model=${payload.model}`);
      activeRequests++;
      try {
        const liveCfg = loadConfig() || cfg;
        assertModelContributed(liveCfg, payload.model);
        await forwardImageRequest(req_id, payload, resolveModelCfg(liveCfg, payload.model));
      } catch (e) {
        log(`[agent] image error req_id=${req_id}: ${e.message}`);
        send({ type: 'error', req_id, error: e.message });
      } finally {
        activeRequests = Math.max(0, activeRequests - 1);
      }
    }
  });

  ws.on('error', (err) => log(`[agent] ws error: ${err.message}`));

  ws.on('close', (code) => {
    log(`[agent] disconnected code=${code}`);
    ws = null;
    if (running) {
      log('[agent] reconnecting in 5s…');
      setTimeout(() => { if (running) connect(cfg); }, 5000);
    } else {
      _onStatus?.({ running: false });
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function start({ onLog, onStatus } = {}) {
  console.log('[agent-worker] start called, running=', running);
  if (running) return;
  _onLog = onLog;
  _onStatus = onStatus;

  const cfg = loadConfig();
  console.log('[agent-worker] config loaded:', cfg ? 'ok' : 'null');
  if (!cfg) {
    onLog?.('[agent] config not found — save Agent config first');
    onStatus?.({ running: false, error: 'config missing' });
    return;
  }
  if (!cfg.worker_key) {
    onLog?.('[agent] worker_key missing — please log in first');
    onStatus?.({ running: false, error: 'worker_key missing' });
    return;
  }
  const hasGroups = cfg.model_groups?.length > 0 && cfg.model_groups.some(g => g.base_url);
  if (!hasGroups && !cfg.llm_base_url) {
    onLog?.('[agent] llm_base_url missing — set your local LLM address in Agent config');
    onStatus?.({ running: false, error: 'llm_base_url missing' });
    return;
  }

  running = true;
  _onStatus?.({ running: true });
  log(`[agent] starting: ${cfg.name || 'unnamed'}`);
  connect(cfg);
}

function stop() {
  if (!running) return;
  running = false;
  if (ws) { ws.close(); ws = null; }
  log('[agent] stopped');
  _onStatus?.({ running: false });
}

function isRunning() { return running; }

module.exports = { start, stop, isRunning, getStats };
