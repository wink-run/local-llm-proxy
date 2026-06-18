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
const { defaultServerUrlFromEnv } = require('../shared/default-server-url');
const { localStats } = require('../shared/telemetry');
const billingConfig = require('../electron/billing-config');
const cloudBilling = require('../electron/cloud-billing-sync');

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
  const serverUrl = cc.url || defaultServerUrlFromEnv() || '';
  if (serverUrl && cc.token) _gateway.setBackendConfig({ url: serverUrl, token: cc.token });
}

/** 用户 JWT（个人页登录 token，非 P2P cloud_config.token） */
function userBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

function resolveBillingServerUrl(req) {
  const hdr = req?.headers?.['x-tokenbank-server'] || req?.headers?.['X-TokenBank-Server'];
  if (hdr) {
    const fromHdr = cloudBilling.normalizeBase(String(hdr));
    if (fromHdr) return fromHdr;
  }
  const cfg = readLocalConfig() || {};
  return cloudBilling.normalizeBase(cfg.cloud_config?.url) || defaultServerUrlFromEnv() || '';
}

function applyUserBillingCfg(cfg) {
  try { billingConfig.applyPricingOverrides(cfg.provider_pricing_overrides || {}); } catch {}
}

async function pullUserBillingApi(token, req) {
  let cfg = readLocalConfig() || { scene_routes: [], local_keys: [] };
  const base = resolveBillingServerUrl(req);
  if (token && base) {
    try {
      const remote = await cloudBilling.syncFromCloud(token, base, cfg);
      cfg = cloudBilling.applyToCfg(cfg, remote);
      writeLocalConfig(cfg);
      syncGateway(cfg);
    } catch (e) {
      console.warn('[admin-api] billing pull failed:', e.message);
    }
  } else if (token && !base) {
    console.warn('[admin-api] billing pull skipped: Token Bank server URL not configured');
  }
  applyUserBillingCfg(cfg);
  return billingConfig.getUserAccounts(cfg);
}

async function pushUserBillingApi(token, req, patch) {
  let cfg = readLocalConfig() || { scene_routes: [], local_keys: [] };
  if (Array.isArray(patch.user_subscriptions)) cfg.user_subscriptions = patch.user_subscriptions;
  if (Array.isArray(patch.user_payg_providers)) cfg.user_payg_providers = patch.user_payg_providers;
  if (patch.subscription_plans && typeof patch.subscription_plans === 'object') {
    cfg.subscription_plans = patch.subscription_plans;
  }
  if (patch.provider_pricing_overrides && typeof patch.provider_pricing_overrides === 'object') {
    cfg.provider_pricing_overrides = patch.provider_pricing_overrides;
  }
  writeLocalConfig(cfg);
  syncGateway(cfg);
  applyUserBillingCfg(cfg);
  if (token) {
    const base = resolveBillingServerUrl(req);
    if (base) {
      try {
        const remote = await cloudBilling.saveUserBilling(token, base, cloudBilling.pickBilling(cfg));
        cfg = cloudBilling.applyToCfg(cfg, remote);
        writeLocalConfig(cfg);
        syncGateway(cfg);
        applyUserBillingCfg(cfg);
      } catch (e) {
        console.warn('[admin-api] billing push failed:', e.message);
      }
    }
  }
  return billingConfig.getUserAccounts(cfg);
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

function checkAuth(_req, _res) {
  // The admin API is a local management interface — access control is left to
  // the operator (firewall / bind address).  Using cloud_config.token as an
  // admin password was a design mistake: it is a P2P connection credential,
  // not a local secret, and creates a circular dependency when trying to set
  // it for the first time via the UI.
  return true;
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

  // 本地 SQLite 统计（Dashboard / Profile / 盘点页；与 gateway :11430 同源逻辑）
  if (method === 'GET' && url.startsWith('/api/local-stats')) {
    const qs = new URL('http://x' + req.url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 1));
    const data = (localStats && typeof localStats.queryDashboard === 'function')
      ? localStats.queryDashboard(days)
      : {
          total_calls: 0, total_tokens: 0, total_cost: 0,
          tiers: { free: 0, p2p: 0, paid: 0 },
          hourly: Array(24).fill(0),
          models: [], keys: [], providers: [], agent_sources: [],
        };
    return json(res, 200, data);
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

  // 个人页：订阅 / 按量（与 Electron 相同，经云端 /user/accounts 同步）
  if (method === 'GET' && url === '/api/user-accounts') {
    const data = await pullUserBillingApi(userBearerToken(req), req);
    return json(res, 200, data);
  }

  if (method === 'PUT' && url === '/api/user-accounts') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const data = await pushUserBillingApi(userBearerToken(req), req, body);
    return json(res, 200, data);
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

  // 未实现的 /api/* 返回 JSON 404，避免 SPA index.html 被 fetch().json() 误解析
  if (url.startsWith('/api/')) {
    return json(res, 404, { error: 'Not found' });
  }

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
function start(port, gatewayInstance, bindHost = '127.0.0.1') {
  _gateway = gatewayInstance;

  _server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[admin-api] unhandled error:', err.message);
      try { json(res, 500, { error: 'Internal server error' }); } catch (_) {}
    });
  });

  _server.listen(port, bindHost, () => {
    console.log(`[admin-api] listening on ${bindHost}:${port}`);
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
