// client/electron/local-gateway.js
'use strict';

const http  = require('http');
const https = require('https');

// ── In-memory state ───────────────────────────────────────────────────────────

const LOG_MAX = 100;
const log = []; // circular, newest last

let _getConfig   = null;     // () => config object (set at start)
let _server      = null;
let _port        = 11430;
// 'llm-router-{id}' → { steps: [{model, tier, ...}], scene_name }
let _routerModelMap = {};
// P2P models with active workers (for UI display only, not used in routing)
let _peerModels   = new Set();
// Backend config: p2p providers forward here by default
let _backendUrl   = null;
let _cloudToken   = null;

// Daily stats reset when date changes
let _stats = newDayStats();

function newDayStats() {
  return {
    date: today(),
    calls: 0,
    errors: 0,
    by_provider: {},  // id → { calls }
    by_model:    {},  // name → { calls }
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ensureTodayStats() {
  if (_stats.date !== today()) _stats = newDayStats();
}

// ── Format conversion (Anthropic ↔ OpenAI) ───────────────────────────────────

function anthropicToOpenai(body) {
  const messages = [...(body.messages || [])];
  if (body.system) messages.unshift({ role: 'system', content: body.system });
  const oai = { model: body.model || '', messages, stream: !!body.stream };
  if (body.max_tokens  != null) oai.max_tokens  = body.max_tokens;
  if (body.temperature != null) oai.temperature = body.temperature;
  if (body.top_p       != null) oai.top_p       = body.top_p;
  if (body.stop_sequences)      oai.stop        = body.stop_sequences;
  return oai;
}

function openaiToAnthropic(oai, model) {
  const choice = (oai.choices || [{}])[0];
  const text   = ((choice.message || {}).content) || '';
  const finish = choice.finish_reason || 'stop';
  const usage  = oai.usage || {};
  return {
    id: oai.id || ('msg_' + Math.random().toString(36).slice(2, 26)),
    type: 'message', role: 'assistant',
    content: [{ type: 'text', text }],
    model,
    stop_reason: (finish === 'stop' || finish == null) ? 'end_turn' : finish,
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

// ── Provider helpers ──────────────────────────────────────────────────────────

// All enabled providers, each with an effective models list.
// P2P providers: base_url/token come from backend config; models come from live _peerModels.
// Other providers: models from their configured models array (empty = serves any model).
function enabledProviders() {
  if (!_getConfig) return [];
  const cfg = _getConfig();
  return (cfg.providers || [])
    .filter(p => {
      if (!p.enabled) return false;
      if (p.type === 'p2p') return !!_backendUrl;
      return !!p.base_url;
    })
    .map(p => {
      if (p.type === 'p2p') {
        return { ...p, base_url: _backendUrl, token: _cloudToken || p.token, models: [..._peerModels] };
      }
      return p;
    });
}

// Returns true if provider can serve the given model
function providerHasModel(provider, model) {
  const list = provider.models;
  if (!Array.isArray(list) || list.length === 0) return true; // no list = serves any
  // models may be strings or {name, type} objects
  return list.some(m => (typeof m === 'string' ? m : m.name) === model);
}

// ── HTTP proxy ────────────────────────────────────────────────────────────────

function proxyRequest(provider, reqPath, body, res) {
  return new Promise((resolve, reject) => {
    const base     = (provider.base_url || '').replace(/\/$/, '');
    const fullUrl  = base + reqPath;
    let u;
    try { u = new URL(fullUrl); }
    catch { return reject(new Error('invalid_url')); }

    const mod      = u.protocol === 'https:' ? https : http;
    const bodyStr  = JSON.stringify(body);
    const headers  = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider.token) {
      if (/anthropic/i.test(provider.base_url || '') || provider.api_format === 'anthropic') {
        headers['x-api-key'] = provider.token;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${provider.token}`;
      }
    }

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method:  'POST',
      headers,
      timeout: 120_000,
    };

    const t0 = Date.now();

    const proxyReq = mod.request(opts, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        proxyRes.resume();
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      if (res.headersSent) {
        proxyRes.resume();
        return reject(new Error('headers_already_sent'));
      }
      res.writeHead(proxyRes.statusCode, {
        'Content-Type':          proxyRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control':         'no-cache',
        'X-Accel-Buffering':     'no',
        'Access-Control-Allow-Origin': '*',
      });
      proxyRes.pipe(res);
      proxyRes.on('end',   () => resolve({ provider: provider.id, latency: Date.now() - t0 }));
      proxyRes.on('error', (err) => {
        res.destroy(err);
        resolve({ provider: provider.id, latency: Date.now() - t0 });
      });
    });

    proxyReq.on('error',   reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Converted proxy: non-streaming Anthropic ─────────────────────────────────

function proxyConvertSync(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    const base    = (provider.base_url || '').replace(/\/$/, '');
    const fullUrl = base + '/v1/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const errChunks = [];
        proxyRes.on('data', c => errChunks.push(c));
        proxyRes.on('end', () => {
          const body = Buffer.concat(errChunks).toString().slice(0, 200);
          console.warn(`[gateway] proxyConvertSync ${proxyRes.statusCode} body:`, body);
        });
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        try {
          const oaiResp = JSON.parse(Buffer.concat(chunks).toString());
          const resp    = JSON.stringify(openaiToAnthropic(oaiResp, model));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(resp);
          resolve({ provider: provider.id, latency: Date.now() - t0 });
        } catch (err) { reject(err); }
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Converted proxy: streaming Anthropic ─────────────────────────────────────

function proxyConvertStream(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    const base    = (provider.base_url || '').replace(/\/$/, '');
    const fullUrl = base + '/v1/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        proxyRes.resume();
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
      });

      const msgId = 'msg_' + Math.random().toString(36).slice(2, 26);
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: {
        id: msgId, type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      }})}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      })}\n\n`);
      res.write('event: ping\ndata: {"type":"ping"}\n\n');

      let buf = '', outputTokens = 0, stopReason = 'end_turn';

      proxyRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ds = line.slice(6).trim();
          if (ds === '[DONE]') continue;
          try {
            const c      = JSON.parse(ds);
            const choice = (c.choices || [{}])[0];
            const text   = (choice.delta || {}).content || '';
            const finish = choice.finish_reason;
            if (text) {
              outputTokens++;
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index: 0,
                delta: { type: 'text_delta', text },
              })}\n\n`);
            }
            if (finish) stopReason = finish === 'stop' ? 'end_turn' : finish;
          } catch {}
        }
      });

      proxyRes.on('end', () => {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        })}\n\n`);
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
        resolve({ provider: provider.id, latency: Date.now() - t0 });
      });

      proxyRes.on('error', (err) => { res.destroy(err); resolve({ provider: provider.id, latency: Date.now() - t0 }); });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── P2P: always stream from backend, buffer to sync response for non-streaming clients ──

function proxyP2PSync(provider, oaiBody, model, res) {
  // Sends stream:true to backend regardless of client request; assembles & returns Anthropic JSON
  return new Promise((resolve, reject) => {
    const streamBody = { ...oaiBody, stream: true };
    const base    = (provider.base_url || '').replace(/\/$/, '');
    const fullUrl = base + '/v1/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(streamBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const t0 = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const errChunks = [];
        proxyRes.on('data', c => errChunks.push(c));
        proxyRes.on('end', () => {
          const body = Buffer.concat(errChunks).toString().slice(0, 200);
          console.warn(`[gateway] proxyP2PSync ${proxyRes.statusCode} body:`, body);
        });
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      let buf = '', fullText = '', inputTokens = 0, outputTokens = 0, stopReason = 'end_turn';
      proxyRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ds = line.slice(6).trim();
          if (ds === '[DONE]') continue;
          try {
            const c      = JSON.parse(ds);
            const choice = (c.choices || [{}])[0];
            const text   = (choice.delta || {}).content || '';
            if (text) fullText += text;
            const finish = choice.finish_reason;
            if (finish) stopReason = finish === 'stop' ? 'end_turn' : finish;
            if (c.usage) {
              inputTokens  = c.usage.prompt_tokens     || inputTokens;
              outputTokens = c.usage.completion_tokens || outputTokens;
            }
          } catch {}
        }
      });
      proxyRes.on('end', () => {
        try {
          const resp = JSON.stringify({
            id: 'msg_' + Math.random().toString(36).slice(2, 26),
            type: 'message', role: 'assistant',
            content: [{ type: 'text', text: fullText }],
            model, stop_reason: stopReason, stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(resp);
          }
          resolve({ provider: provider.id, latency: Date.now() - t0 });
        } catch (err) { reject(err); }
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

// Call one provider with format conversion; throws on HTTP error.
// provider is already resolved (base_url/token correct, models populated).
async function callProvider(provider, isAnthropic, streaming, reqPath, body, attemptModel, res) {
  const attemptBody = { ...body, model: attemptModel };

  // Anthropic-compatible provider: proxy request directly without format conversion
  const isAnthropicProvider = /anthropic/i.test(provider.base_url || '') || provider.api_format === 'anthropic';
  if (isAnthropicProvider) {
    const targetPath = isAnthropic ? '/v1/messages' : '/v1/chat/completions';
    return await proxyRequest(provider, targetPath, attemptBody, res);
  }

  const oaiBody = isAnthropic ? anthropicToOpenai(attemptBody) : null;
  if (isAnthropic) {
    return streaming
      ? await proxyConvertStream(provider, oaiBody, attemptModel, res)
      // P2P backends often only support streaming; use proxyP2PSync (sends stream:true internally)
      : (provider.type === 'p2p'
          ? await proxyP2PSync(provider, oaiBody, attemptModel, res)
          : await proxyConvertSync(provider, oaiBody, attemptModel, res));
  }
  return await proxyRequest(provider, reqPath, attemptBody, res);
}

async function route(model, reqPath, body, res) {
  ensureTodayStats();
  const t0          = Date.now();
  let lastErr       = null;
  const isAnthropic = reqPath === '/v1/messages';
  const streaming   = !!body.stream;

  function fail(scene_name, failedModels) {
    pushLog({
      ts: t0, requested_model: model, model, scene_name,
      tried: failedModels?.length ? [...failedModels] : undefined,
      via: null, latency_ms: Date.now() - t0, status: 'error', error: lastErr?.message,
    });
    _stats.errors++;
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'all_providers_failed', detail: lastErr?.message }));
    }
  }

  // ── Scene route: llm-router-* ─────────────────────────────────────────────
  if (model.startsWith('llm-router-')) {
    const scene = _routerModelMap[model];
    if (!scene?.steps?.length) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'scene_not_found', model }));
      return;
    }

    const all          = enabledProviders();
    const failedModels = [];

    for (const step of scene.steps) {
      const stepModel     = step.model;
      // Match providers by model list, not by tier — tier is informational only
      const stepProviders = all.filter(p => providerHasModel(p, stepModel));
      let   stepSucceeded = false;

      for (const provider of stepProviders) {
        try {
          const result = await callProvider(provider, isAnthropic, streaming, reqPath, body, stepModel, res);
          pushLog({
            ts: t0, requested_model: model, model: stepModel,
            scene_name: scene.scene_name,
            tried: failedModels.length ? [...failedModels] : undefined,
            tier: provider.type, via: provider.id, via_label: provider.label,
            latency_ms: result.latency, status: 'ok',
          });
          recordStats(provider.id, stepModel);
          stepSucceeded = true;
          return;
        } catch (err) {
          lastErr = err;
          if (res.headersSent) return;
        }
      }
      if (!stepSucceeded) failedModels.push(stepModel);
    }

    fail(scene.scene_name, failedModels);
    return;
  }

  // ── Direct model request: try providers that list this model ─────────────
  for (const provider of enabledProviders().filter(p => providerHasModel(p, model))) {
    try {
      const result = await callProvider(provider, isAnthropic, streaming, reqPath, body, model, res);
      pushLog({
        ts: t0, requested_model: model, model,
        tier: provider.type, via: provider.id, via_label: provider.label,
        latency_ms: result.latency, status: 'ok',
      });
      recordStats(provider.id, model);
      return;
    } catch (err) {
      lastErr = err;
      if (res.headersSent) return;
    }
  }

  fail(null, null);
}

function pushLog(entry) {
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
}

function recordStats(providerId, model) {
  _stats.calls++;
  const ps = _stats.by_provider[providerId] || { calls: 0 };
  ps.calls++;
  _stats.by_provider[providerId] = ps;

  if (model) {
    const ms = _stats.by_model[model] || { calls: 0 };
    ms.calls++;
    _stats.by_model[model] = ms;
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, anthropic-version');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { method, url } = req;

  // Health
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: _port }));
    return;
  }

  // Models list — return stub
  if (method === 'GET' && (url === '/v1/models' || url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }

  // Chat completions (OpenAI + Anthropic)
  const isChatPath   = url === '/v1/chat/completions' || url === '/v1/messages';
  if (!isChatPath || method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  req.on('error', (err) => {
    console.error('[gateway] request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'request_error' }));
    }
  });

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const model = body.model || '';
    try {
      await route(model, url, body, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(port, getConfig) {
  if (_server) return;
  _port      = port || 11430;
  _getConfig = getConfig;
  _server    = http.createServer(handleRequest);
  _server.listen(_port, '127.0.0.1', () => {
    console.log(`[gateway] listening on 127.0.0.1:${_port}`);
  });
  _server.on('error', (err) => {
    console.error('[gateway] server error:', err.message);
  });
}

function stop() {
  if (!_server) return;
  const s = _server;
  _server = null;
  s.close(() => {
    console.log('[gateway] stopped');
  });
}

function setStrategy() { /* deprecated */ }

function getStatus() {
  return { running: !!_server, port: _port };
}

function getLog() {
  return [...log].reverse(); // newest first
}

function getDailyStats() {
  ensureTodayStats();
  return { ..._stats };
}

function setKeySceneMap() { /* deprecated */ }

function setRouterModelMap(map) {
  _routerModelMap = map && typeof map === 'object' ? map : {};
}

function setPeerModels(list) {
  _peerModels = Array.isArray(list) ? new Set(list) : new Set();
  console.log(`[gateway] P2P models updated: ${_peerModels.size} models`);
}

function setBackendConfig({ url, token } = {}) {
  _backendUrl  = url   || null;
  _cloudToken  = token || null;
  console.log(`[gateway] backend config: url=${_backendUrl} token=${_cloudToken ? '***' : 'none'}`);
}

module.exports = {
  start, stop, setStrategy, getStatus, getLog, getDailyStats,
  setKeySceneMap, setRouterModelMap, setPeerModels, setBackendConfig,
};
