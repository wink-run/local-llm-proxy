// client/cli/admin-api.js
// Admin HTTP API server for the CLI gateway.
// Mirrors all Electron IPC handlers as REST endpoints.
// Also serves the React frontend from ../dist/.
'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { readAgentConfig, writeAgentConfig, readLocalConfig, writeLocalConfig } = require('../shared/config-loader');

// ── Module state ──────────────────────────────────────────────────────────────

let _gateway = null;
let _server  = null;

const DIST_DIR = path.resolve(__dirname, '..', 'dist');

// ── Helpers ───────────────────────────────────────────────────────────────────

function rndHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (!buf) { resolve({}); return; }
      try { resolve(JSON.parse(buf)); }
      catch (_) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function parseBody(req, res) {
  try {
    return await readBody(req);
  } catch (_) {
    json(res, 400, { error: 'invalid JSON or body too large' });
    return null;
  }
}

// Serve a static file from DIST_DIR; returns false if file not found.
function serveStatic(res, relPath) {
  const filePath = path.join(DIST_DIR, relPath);

  // Prevent path traversal outside dist dir
  if (!filePath.startsWith(DIST_DIR + path.sep) && filePath !== DIST_DIR) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf':  'font/ttf',
  };
  const ct = mimeMap[ext] || 'application/octet-stream';

  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return false; // file not found or unreadable
  }
  res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length });
  res.end(data);
  return true;
}

// ── syncGateway ───────────────────────────────────────────────────────────────

function syncGateway(lc) {
  if (!_gateway) return;
  const routerMap = {};
  for (const r of (lc.scene_routes || [])) {
    if (r.model_key && r.steps?.length)
      routerMap[r.model_key] = { steps: r.steps, scene_name: r.scene_name };
  }
  _gateway.setRouterModelMap(routerMap);
  const cc = lc.cloud_config || {};
  if (cc.url && cc.token) _gateway.setBackendConfig({ url: cc.url, token: cc.token });
}

// ── testProvider ─────────────────────────────────────────────────────────────

function testProvider(base_url, token) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(base_url.replace(/\/$/, '') + '/models'); }
    catch (_) { resolve({ ok: false, status: 0 }); return; }

    const mod = url.protocol === 'https:' ? https : http;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'GET',
        headers,
        timeout: 8000,
      },
      (res) => {
        res.resume(); // drain
        res.on('end', () => {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
        });
      }
    );
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function isAuthRequired(urlPath) {
  // Skip auth for static assets and root
  if (urlPath === '/' || urlPath.startsWith('/assets/')) return false;
  return true;
}

function checkAuth(req, res) {
  const lc = readLocalConfig() || {};
  const configToken = lc.cloud_config?.token || '';
  if (!configToken) return true; // no token configured — allow all

  const urlPath = req.url.split('?')[0];
  if (!isAuthRequired(urlPath)) return true;

  const authHeader = req.headers['authorization'] || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (provided === configToken) return true;

  json(res, 401, { error: 'Unauthorized' });
  return false;
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  setCors(res);

  // Auth check (runs for all methods including OPTIONS)
  if (!checkAuth(req, res)) return;

  // OPTIONS preflight — after auth so unauthenticated clients don't probe the API
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // ── Gateway routes ──────────────────────────────────────────────────────────

  if (method === 'GET' && url === '/api/gateway/status') {
    return json(res, 200, _gateway.getStatus());
  }

  if (method === 'GET' && url === '/api/gateway/log') {
    return json(res, 200, { log: _gateway.getLog() });
  }

  if (method === 'GET' && url === '/api/gateway/stats') {
    return json(res, 200, _gateway.getDailyStats());
  }

  if (method === 'POST' && url === '/api/gateway/restart') {
    _gateway.restart();
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && url === '/api/gateway/test-provider') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const result = await testProvider(body.base_url || '', body.token || '');
    return json(res, 200, result);
  }

  // ── Agent config routes ─────────────────────────────────────────────────────

  if (method === 'GET' && url === '/api/config') {
    return json(res, 200, readAgentConfig());
  }

  if (method === 'POST' && url === '/api/config') {
    const body = await parseBody(req, res);
    if (body === null) return;
    writeAgentConfig(body);
    return json(res, 200, { ok: true });
  }

  // ── Local config routes ─────────────────────────────────────────────────────

  if (method === 'GET' && url === '/api/local-config') {
    return json(res, 200, readLocalConfig() || {});
  }

  if (method === 'POST' && url === '/api/local-config/cloud-config') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    lc.cloud_config = { url: body.url || '', token: body.token || '' };
    writeLocalConfig(lc);
    syncGateway(lc);
    return json(res, 200, { ok: true });
  }

  // ── Scene routes ────────────────────────────────────────────────────────────

  if (method === 'POST' && url === '/api/local-config/routes') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    if (!lc.scene_routes) lc.scene_routes = [];
    const route = {
      id: rndHex(8),
      scene_name: body.scene_name || '',
      icon: body.icon || '\u{1F500}',
      steps: body.steps || [],
      model_key: 'llm-router-' + rndHex(6),
      created_at: new Date().toISOString(),
    };
    lc.scene_routes.push(route);
    writeLocalConfig(lc);
    syncGateway(lc);
    return json(res, 200, route);
  }

  const routeUpdateMatch = url.match(/^\/api\/local-config\/routes\/([^/]+)$/);
  if (routeUpdateMatch) {
    const id = routeUpdateMatch[1];

    if (method === 'PUT') {
      const body = await parseBody(req, res);
      if (body === null) return;
      const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
      const idx = (lc.scene_routes || []).findIndex((r) => r.id === id);
      if (idx === -1) return json(res, 404, { error: 'not found' });
      lc.scene_routes[idx] = Object.assign({}, lc.scene_routes[idx], {
        scene_name: body.scene_name,
        icon: body.icon,
        steps: body.steps,
      });
      writeLocalConfig(lc);
      syncGateway(lc);
      return json(res, 200, lc.scene_routes[idx]);
    }

    if (method === 'DELETE') {
      const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
      lc.scene_routes = (lc.scene_routes || []).filter((r) => r.id !== id);
      writeLocalConfig(lc);
      syncGateway(lc);
      return json(res, 200, { ok: true });
    }
  }

  // ── Local keys ──────────────────────────────────────────────────────────────

  if (method === 'POST' && url === '/api/local-config/keys') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    if (!lc.local_keys) lc.local_keys = [];
    const key = {
      id: rndHex(8),
      key: 'sk-local-' + rndHex(16),
      note: body.note || '',
      model_key: null,
      created_at: new Date().toISOString(),
    };
    lc.local_keys.push(key);
    writeLocalConfig(lc);
    syncGateway(lc);
    return json(res, 200, key);
  }

  const keyMatch = url.match(/^\/api\/local-config\/keys\/([^/]+)(\/bind)?$/);
  if (keyMatch) {
    const id   = keyMatch[1];
    const bind = !!keyMatch[2];

    if (method === 'DELETE' && !bind) {
      const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
      lc.local_keys = (lc.local_keys || []).filter((k) => k.id !== id);
      writeLocalConfig(lc);
      syncGateway(lc);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && bind) {
      const body = await parseBody(req, res);
      if (body === null) return;
      const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
      const key = (lc.local_keys || []).find((k) => k.id === id);
      if (!key) return json(res, 404, { error: 'not found' });
      key.model_key = body.model_key || null;
      writeLocalConfig(lc);
      syncGateway(lc);
      return json(res, 200, key);
    }
  }

  // ── Static file serving (SPA) ───────────────────────────────────────────────

  if (!fs.existsSync(DIST_DIR)) {
    return json(res, 404, { error: 'Frontend not built. Run: npm run build' });
  }

  // Try to serve the exact path first
  const relPath = url === '/' ? 'index.html' : url.replace(/^\//, '');
  if (serveStatic(res, relPath)) return;

  // SPA fallback — serve index.html for non-asset paths
  if (!url.startsWith('/assets/')) {
    if (serveStatic(res, 'index.html')) return;
  }

  json(res, 404, { error: 'Not found' });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start the admin API server.
 * @param {number} port
 * @param {object} gatewayInstance  — the local-gateway module
 * @returns {http.Server}
 */
function start(port, gatewayInstance) {
  _gateway = gatewayInstance;

  const lc = readLocalConfig() || {};
  const configToken = lc.cloud_config?.token || '';
  if (!configToken) {
    console.warn('[admin-api] WARNING: No cloud token configured — admin API is unauthenticated. Set cloud_config.token to secure it.');
  }

  _server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[admin-api] unhandled error:', err.message);
      try { json(res, 500, { error: 'Internal server error' }); } catch (_) {}
    });
  });

  _server.listen(port, '127.0.0.1', () => {
    // Listening
  });

  return _server;
}

/**
 * Stop the admin API server.
 */
function stop() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

module.exports = { start, stop };
