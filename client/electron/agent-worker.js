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

let ws = null;
let running = false;
let _onLog = null;
let _onStatus = null;

function log(msg) { _onLog?.(msg); }

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return null; }
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
      if (data.usage) usage = { prompt_tokens: 0, completion_tokens: data.usage.output_tokens, total_tokens: data.usage.output_tokens };
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

// ── HTTP forward ──────────────────────────────────────────────────────────────

function buildUrl(baseUrl, anthropic) {
  // Strip trailing slashes, normalize /v1 dedup, then append endpoint.
  const base = baseUrl.replace(/\/+$/, '');
  const v1Base = base.endsWith('/v1') ? base : base + '/v1';
  return new URL(v1Base + (anthropic ? '/messages' : '/chat/completions'));
}

function forwardRequest(reqId, payload, cfg) {
  const anthropic  = isAnthropicStyle(cfg.llm_base_url);
  const outPayload = anthropic ? openaiToAnthropic(payload) : payload;

  const url = buildUrl(cfg.llm_base_url, anthropic);
  const mod = url.protocol === 'https:' ? https : http;
  const streaming = payload.stream === true;
  const body = JSON.stringify(outPayload);

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (cfg.llm_token) headers['Authorization'] = `Bearer ${cfg.llm_token}`;
  if (anthropic) headers['anthropic-version'] = '2023-06-01';

  return new Promise((resolve) => {
    const req = mod.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST', headers, timeout: 120000 },
      (res) => {
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
            send({ type: 'done', req_id: reqId, usage: lastUsage });
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
              if (anthropic) {
                const converted = anthropicToOpenAI(json);
                usage = converted.usage;
                rawBody = JSON.stringify(converted);
              } else {
                usage = json.usage;
              }
            } catch {}
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

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── WebSocket session ─────────────────────────────────────────────────────────

function connect(cfg) {
  log(`[agent] connecting → ${cfg.server_url}`);
  ws = new WebSocket(cfg.server_url, { handshakeTimeout: 10000 });

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'register',
      worker_key: cfg.worker_key,
      models: cfg.models || [],
      name: cfg.name || os.hostname(),
    }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'registered') {
      log(`[agent] connected worker_id=${msg.worker_id}`);
      log(`[agent] models: ${(cfg.models || []).join(', ')}`);
      return;
    }

    if (msg.type === 'request') {
      const { req_id, payload } = msg;
      log(`[agent] → req_id=${req_id} model=${payload.model} stream=${!!payload.stream}`);
      try {
        await forwardRequest(req_id, payload, cfg);
      } catch (e) {
        log(`[agent] error req_id=${req_id}: ${e.message}`);
        send({ type: 'error', req_id, error: e.message });
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
  if (!cfg.llm_base_url) {
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

module.exports = { start, stop, isRunning };
