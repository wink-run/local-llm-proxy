// client/cli/gateway.js
// CLI entry point — same gateway functionality as the Electron desktop app.
// Usage:
//   node gateway.js start [--port 11430] [--admin-port 11431]
//   node gateway.js status
//   node gateway.js restart
//   node gateway.js keys
//   node gateway.js help
'use strict';

const http = require('http');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const gateway  = require('../electron/local-gateway');
const adminApi = require('./admin-api');
const reporter = require('../shared/device-reporter');
const { readLocalConfig, readAgentConfig } = require('../shared/config-loader');
const { defaultServerUrlFromEnv } = require('../shared/default-server-url');
const { initGatewayTelemetry } = require('../shared/telemetry');

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { command: null, port: 11430, adminPort: 11431 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!args.command && !a.startsWith('--')) {
      args.command = a;
    } else if (a === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10);
    } else if (a === '--admin-port' && argv[i + 1]) {
      args.adminPort = parseInt(argv[++i], 10);
    }
  }
  return args;
}

// ── Helpers for remote commands ───────────────────────────────────────────────

function adminRequest(adminPort, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: adminPort,
        path: urlPath,
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token ? { Authorization: `Bearer ${token}` } : {},
          data ? { 'Content-Length': Buffer.byteLength(data) } : {}
        ),
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch (_) { resolve({ status: res.statusCode, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getToken(adminPort) {
  const lc = readLocalConfig() || {};
  return lc.cloud_config?.token || '';
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStart(port, adminPort) {
  const lc = readLocalConfig() || { scene_routes: [], local_keys: [], cloud_config: {} };
  // Docker 端口映射需监听 0.0.0.0；本机 CLI 默认仍用 127.0.0.1
  const bindHost = process.env.GATEWAY_BIND_HOST
    || (fs.existsSync('/.dockerenv') ? '0.0.0.0' : '127.0.0.1');

  // Build router map from scene_routes
  const routerMap = {};
  for (const r of (lc.scene_routes || [])) {
    if (r.model_key && r.steps?.length) {
      routerMap[r.model_key] = { steps: r.steps, scene_name: r.scene_name };
    }
  }
  gateway.setRouterModelMap(routerMap);

  // Configure P2P backend if cloud config is present
  const cc = lc.cloud_config || {};
  const serverUrl = cc.url || defaultServerUrlFromEnv() || null;
  if (serverUrl && cc.token) {
    gateway.setBackendConfig({ url: serverUrl, token: cc.token });
    gateway.setPeerModels([]);
  }

  // Start HTTP gateway
  gateway.start(port, readAgentConfig, undefined, bindHost);
  console.log(`[gateway] HTTP gateway started on port ${port}`);

  // 本地统计 + 会话补录（与 Electron 共用 ~/.tokenbank/local-stats.db）
  const telemetry = initGatewayTelemetry(gateway);

  // Start admin API
  adminApi.start(adminPort, gateway, bindHost);
  console.log(`[gateway] Admin API started on port ${adminPort}`);

  // Init device reporter
  await reporter.init({
    type: 'cli',
    name: os.hostname(),
    platform: `${process.platform}/${os.release()}`,
    version: '1.0.0',
    serverUrl: serverUrl,
    token: cc.token || null,
  });

  reporter.start(() => {
    const s = gateway.getDailyStats();
    return {
      calls: s.calls || 0,
      errors: s.errors || 0,
      providers_active: Object.keys(s.by_provider || {}).length,
    };
  });

  console.log(`[gateway] Ready. Gateway :${port}  Admin :${adminPort}`);
  console.log('[gateway] Press Ctrl+C to stop.');

  // Graceful shutdown
  function shutdown() {
    console.log('\n[gateway] Shutting down...');
    reporter.stop();
    telemetry.shutdown();
    gateway.stop();
    adminApi.stop();
    process.exit(0);
  }

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdStatus(adminPort) {
  const token = getToken(adminPort);
  try {
    const r = await adminRequest(adminPort, 'GET', '/api/gateway/status', null, token);
    console.log('Gateway status:', JSON.stringify(r.body, null, 2));
  } catch (err) {
    console.error('Could not reach admin API:', err.message);
    process.exit(1);
  }
}

async function cmdRestart(adminPort) {
  const token = getToken(adminPort);
  try {
    const r = await adminRequest(adminPort, 'POST', '/api/gateway/restart', {}, token);
    console.log('Restart:', JSON.stringify(r.body, null, 2));
  } catch (err) {
    console.error('Could not reach admin API:', err.message);
    process.exit(1);
  }
}

async function cmdKeys(adminPort) {
  const token = getToken(adminPort);
  try {
    const r = await adminRequest(adminPort, 'GET', '/api/local-config', null, token);
    if (r.status !== 200) {
      console.error('Error fetching config:', r.status, r.body);
      process.exit(1);
    }
    const keys = (r.body.local_keys || []);
    if (!keys.length) {
      console.log('No local keys configured.');
      return;
    }
    console.log('Local keys:');
    for (const k of keys) {
      const binding = k.model_key ? `  [bound → ${k.model_key}]` : '  [unbound]';
      console.log(`  ${k.key}  note: ${k.note || '(none)'}${binding}`);
    }
  } catch (err) {
    console.error('Could not reach admin API:', err.message);
    process.exit(1);
  }
}

function cmdHelp() {
  console.log(`
Usage: node gateway.js <command> [options]

Commands:
  start         Start the gateway and admin API server
  status        Show gateway status (requires running instance)
  restart       Restart the gateway (requires running instance)
  keys          List local API keys (requires running instance)
  help          Show this help message

Options (start only):
  --port        Gateway port       (default: 11430)
  --admin-port  Admin API port     (default: 11431)
`.trim());
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'start':
      await cmdStart(args.port, args.adminPort);
      break;
    case 'status':
      await cmdStatus(args.adminPort);
      break;
    case 'restart':
      await cmdRestart(args.adminPort);
      break;
    case 'keys':
      await cmdKeys(args.adminPort);
      break;
    case 'help':
    case null:
    default:
      cmdHelp();
      if (!args.command) process.exit(1);
      break;
  }
})().catch((err) => {
  console.error('[gateway] Fatal error:', err.message);
  process.exit(1);
});
