// client/electron/local-gateway.js
'use strict';

const http  = require('http');
const https = require('https');

// ── In-memory state ───────────────────────────────────────────────────────────

const LOG_MAX = 100;
const log = []; // circular, newest last

let _strategy  = 'cost';   // 'cost' | 'quality'
let _getConfig = null;     // () => config object (set at start)
let _server    = null;
let _port      = 11430;

// Daily stats reset when date changes
let _stats = newDayStats();

function newDayStats() {
  return {
    date: today(),
    calls: 0,
    errors: 0,
    by_provider: {},  // id → { calls, tokens }
    by_model:    {},  // name → { calls, tokens }
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ensureTodayStats() {
  if (_stats.date !== today()) _stats = newDayStats();
}

// ── Provider helpers ──────────────────────────────────────────────────────────

function orderedProviders() {
  const cfg = _getConfig ? _getConfig() : {};
  const providers = (cfg.providers || []).filter(p => p.enabled && p.base_url);
  const typeOrder = _strategy === 'cost'
    ? ['free', 'p2p', 'paid']
    : ['paid', 'p2p', 'free'];
  return typeOrder.flatMap(t => providers.filter(p => p.type === t));
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
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

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
      res.writeHead(proxyRes.statusCode, {
        'Content-Type':          proxyRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control':         'no-cache',
        'X-Accel-Buffering':     'no',
        'Access-Control-Allow-Origin': '*',
      });
      proxyRes.pipe(res);
      proxyRes.on('end',   () => resolve({ provider: provider.id, latency: Date.now() - t0 }));
      proxyRes.on('error', reject);
    });

    proxyReq.on('error',   reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

async function route(model, reqPath, body, res) {
  ensureTodayStats();
  const providers = orderedProviders();
  const t0 = Date.now();
  let lastErr = null;

  for (const provider of providers) {
    try {
      const result = await proxyRequest(provider, reqPath, body, res);
      // record success
      const entry = {
        ts: t0, model, via: provider.id, via_label: provider.label,
        latency_ms: result.latency, status: 'ok',
      };
      pushLog(entry);
      recordStats(provider.id, model);
      return;
    } catch (err) {
      lastErr = err;
      // try next provider
    }
  }

  // All providers failed
  pushLog({ ts: t0, model, via: null, latency_ms: Date.now() - t0, status: 'error', error: lastErr?.message });
  _stats.errors++;
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'all_providers_failed', detail: lastErr?.message }));
}

function pushLog(entry) {
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
}

function recordStats(providerId, model) {
  _stats.calls++;
  const ps = _stats.by_provider[providerId] || { calls: 0, tokens: 0 };
  ps.calls++;
  _stats.by_provider[providerId] = ps;

  if (model) {
    const ms = _stats.by_model[model] || { calls: 0, tokens: 0 };
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
    res.end(JSON.stringify({ ok: true, port: _port, strategy: _strategy }));
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
  _server.close();
  _server = null;
}

function setStrategy(s) {
  if (s === 'cost' || s === 'quality') _strategy = s;
}

function getStatus() {
  return { running: !!_server, port: _port, strategy: _strategy };
}

function getLog() {
  return [...log].reverse(); // newest first
}

function getDailyStats() {
  ensureTodayStats();
  return { ..._stats };
}

module.exports = { start, stop, setStrategy, getStatus, getLog, getDailyStats };
