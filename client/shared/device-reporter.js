// client/shared/device-reporter.js
// Works in both Electron main process and Node.js CLI — no Electron imports.
'use strict';

const https  = require('https');
const http   = require('http');
const os     = require('os');
const { readAgentConfig, writeAgentConfig } = require('./config-loader');
const deviceIdentity = require('./device-identity');
const { ensureDeviceId, readDeviceId, writeDeviceId } = require('./device-id');

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60s（服务端 2 分钟无心跳会标离线）

// ── Module state ──────────────────────────────────────────────────────────────

let _config   = null;  // { type, name, platform, version, serverUrl, token, device_id }
let _timer    = null;
let _getStats = null;  // () => { calls, errors, providers_active }  (may be async)

// ── Low-level HTTP helper ─────────────────────────────────────────────────────

/**
 * POST JSON body to url, authenticated with Bearer token.
 * Resolves to { status, body } or rejects on network/timeout error.
 */
function _post(url, body, token) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const mod  = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);

    const req = mod.request({
      hostname : u.hostname,
      port     : u.port || (u.protocol === 'https:' ? 443 : 80),
      path     : u.pathname,
      method   : 'POST',
      headers  : {
        'Content-Type'   : 'application/json',
        'Content-Length' : Buffer.byteLength(data),
        'Authorization'  : `Bearer ${token}`,
      },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

/** 读取/生成本机唯一设备 ID（~/.tokenbank/device-id 或 device-id-cli） */
function _ensureLocalDeviceId(existing, kind = 'desktop') {
  const persisted = readDeviceId(kind);
  if (persisted) return persisted;
  if (existing && /^dev-[a-f0-9]{16}$/.test(existing)) {
    writeDeviceId(existing, kind);
    return existing;
  }
  return ensureDeviceId(kind);
}

/**
 * POST to /device/register → returns device_id string.
 * 失败时沿用已持久化的本地 ID，避免每次启动随机生成新设备。
 */
async function _register() {
  const persisted = _config?.device_id || '';

  if (!_config?.serverUrl || !_config?.token) return persisted;

  try {
    const res = await _post(
      `${_config.serverUrl}/device/register`,
      {
        type         : _config.type,
        name         : _config.name,
        platform     : _config.platform,
        version      : _config.version,
        gateway_port : 11430,
        device_id    : persisted,
      },
      _config.token
    );

    if (res.status >= 200 && res.status < 300) {
      const json = JSON.parse(res.body);
      // 服务端 devices 表主键字段为 id
      const id = json?.id || json?.device_id;
      if (id) return id;
    }
  } catch (_) {
    // Network or parse error — keep persisted id
  }

  return persisted;
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

/** POST to /device/heartbeat — never throws. */
async function _sendHeartbeat(online = true) {
  if (!_config?.serverUrl || !_config?.token) return;

  let stats = { calls: 0, errors: 0, providers_active: 0 };
  try {
    if (typeof _getStats === 'function') {
      const result = await Promise.resolve(_getStats());
      if (result && typeof result === 'object') stats = { ...stats, ...result };
    }
  } catch (_) {
    // getStats failure is non-fatal
  }

  // Extract inventory from stats if provided, keep stats clean for server
  const inventory = stats.inventory || null;
  const { inventory: _inv, ...statsClean } = stats;

  try {
      await _post(
      `${_config.serverUrl}/device/heartbeat`,
      {
        device_id: _config.device_id,
        online,
        type     : _config.type || '',
        version  : _config.version || '',
        name     : _config.name || '',
        platform : _config.platform || '',
        stats    : { ...statsClean, inventory },
      },
      _config.token
    );
  } catch (_) {
    // Heartbeat is best-effort; swallow all errors
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once on startup.
 * options: { type: 'desktop'|'cli', name, platform, version, serverUrl, token }
 * Reads/generates device_id from config.json and persists it back.
 */
async function init(options) {
  // Merge options with any existing agent config
  const existing = readAgentConfig() || {};

  const deviceKind = options.type === 'cli' ? 'cli' : 'desktop';
  const localDeviceId = _ensureLocalDeviceId(existing.device_id || null, deviceKind);

  const identity = deviceIdentity.collect({
    type     : options.type || 'desktop',
    port     : options.port || options.gateway_port || null,
    version  : options.version || '0.0.0',
    customName: options.name || '',
  });

  _config = {
    type      : options.type     || 'desktop',
    name      : options.name     || identity.name,
    platform  : options.platform || identity.platform,
    version   : options.version  || identity.version,
    serverUrl : options.serverUrl || existing.serverUrl || null,
    token     : options.token    || existing.token      || null,
    device_id : localDeviceId,
  };

  // Always call register on startup: confirms the device_id with the server,
  // re-registers if it was previously a local-only fallback ID, and creates
  // a new ID if we have none. The server reuses the existing ID if it already
  // belongs to this user.
  const registeredId = await _register();
  _config.device_id = registeredId;
  // 持久化到 ~/.tokenbank/device-id 与 agent config
  if (registeredId) writeDeviceId(registeredId, deviceKind);
  const cfg = readAgentConfig() || {};
  cfg.device_id = registeredId;
  try { writeAgentConfig(cfg); } catch (_) {}
}

/**
 * Start the 60-second heartbeat loop.
 * getStats: optional async/sync () => { calls, errors, providers_active }
 */
function start(getStats) {
  _getStats = getStats || null;

  // Immediate heartbeat (best-effort, don't block)
  _sendHeartbeat(true).catch(() => {});

  // Clear any existing timer before starting a new one
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => {
    _sendHeartbeat(true).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  // Allow the process to exit even if this timer is running
  if (_timer.unref) _timer.unref();
}

/**
 * Stop the heartbeat loop and send a final offline heartbeat (best-effort).
 */
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _sendHeartbeat(false).catch(() => {});
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { init, start, stop };
