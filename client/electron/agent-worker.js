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

// ── HTTP forward ──────────────────────────────────────────────────────────────

function forwardRequest(reqId, payload, cfg) {
  const url = new URL('/v1/chat/completions', cfg.llm_base_url);
  const mod = url.protocol === 'https:' ? https : http;
  const streaming = payload.stream === true;
  const body = JSON.stringify(payload);

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (cfg.llm_token) headers['Authorization'] = `Bearer ${cfg.llm_token}`;

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
            // flush complete SSE lines
            const lines = buf.split('\n');
            buf = lines.pop(); // keep incomplete tail
            for (const line of lines) {
              const trimmed = line.trimEnd();
              if (!trimmed) continue;
              // extract usage from last data chunk
              if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                try { const d = JSON.parse(trimmed.slice(6)); if (d.usage) lastUsage = d.usage; }
                catch {}
              }
              send({ type: 'chunk', req_id: reqId, data: trimmed + '\n\n' });
            }
          });

          res.on('end', () => {
            // flush any remaining partial line
            if (buf.trim()) send({ type: 'chunk', req_id: reqId, data: buf.trim() + '\n\n' });
            send({ type: 'done', req_id: reqId, usage: lastUsage });
            resolve();
          });

          res.on('error', (e) => {
            send({ type: 'error', req_id: reqId, error: e.message });
            resolve();
          });
        } else {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString();
            let usage = null;
            try { usage = JSON.parse(rawBody).usage; } catch {}
            send({ type: 'chunk', req_id: reqId, data: rawBody });
            send({ type: 'done', req_id: reqId, usage });
            resolve();
          });
          res.on('error', (e) => {
            send({ type: 'error', req_id: reqId, error: e.message });
            resolve();
          });
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
      models: cfg.models,
      name: cfg.name || os.hostname(),
    }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'registered') {
      log(`[agent] connected worker_id=${msg.worker_id}`);
      log(`[agent] models: ${cfg.models.join(', ')}`);
      _onStatus?.({ running: true });
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
  if (running) return;
  _onLog = onLog;
  _onStatus = onStatus;

  const cfg = loadConfig();
  if (!cfg) {
    onLog?.('[agent] config not found — save Agent config first');
    onStatus?.({ running: false, error: 'config missing' });
    return;
  }
  if (!cfg.worker_key) {
    onLog?.('[agent] worker_key missing in config');
    onStatus?.({ running: false, error: 'worker_key missing' });
    return;
  }

  running = true;
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
