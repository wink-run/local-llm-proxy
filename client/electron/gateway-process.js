/**
 * Local Gateway subprocess manager.
 *
 * Spawns `uvicorn local_gateway:app --host 127.0.0.1 --port 11435` and
 * keeps it alive while Electron is running. Auto-restarts on crash.
 *
 * Dev mode only for now — packaged mode would need PyInstaller bundle.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const GATEWAY_PORT = parseInt(process.env.LLP_PORT || '11435', 10);
const GATEWAY_HOST = process.env.LLP_HOST || '127.0.0.1';

let child = null;
let restartCount = 0;
const MAX_RESTARTS = 3;
let _onStatus = null;
let _onLog = null;

function log(msg) {
  console.log('[gateway-process]', msg);
  _onLog?.(msg);
}

function resolveServerDir() {
  // dev: electron __dirname = .../local-llm-proxy/client/electron
  // server lives at .../local-llm-proxy/server/
  const candidates = [
    path.resolve(__dirname, '..', '..', 'server'),
    path.resolve(__dirname, '..', 'server'),
    process.env.LLP_SERVER_DIR,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'local_gateway.py'))) return c;
  }
  return null;
}

function pickPython() {
  // Try common names; spawn will fail loudly if none work
  const cmds = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  return cmds[0]; // try the most likely; user can override via LLP_PYTHON env
}

function probeAlive(cb) {
  const req = http.get(
    { host: GATEWAY_HOST, port: GATEWAY_PORT, path: '/__local__/health', timeout: 1000 },
    (res) => {
      cb(res.statusCode === 200);
      res.resume();
    },
  );
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

function start() {
  if (child) {
    log('Gateway already running');
    return;
  }
  const serverDir = resolveServerDir();
  if (!serverDir) {
    log('ERROR: cannot locate server/local_gateway.py — gateway will not start');
    _onStatus?.({ running: false, error: 'server dir not found' });
    return;
  }

  const py = process.env.LLP_PYTHON || pickPython();
  const args = ['-m', 'uvicorn', 'local_gateway:app',
    '--host', GATEWAY_HOST, '--port', String(GATEWAY_PORT),
    '--log-level', 'warning'];

  log(`Spawning: ${py} ${args.join(' ')}  (cwd=${serverDir})`);

  child = spawn(py, args, {
    cwd: serverDir,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (d) => log(`[stdout] ${d.toString().trim()}`));
  child.stderr.on('data', (d) => log(`[stderr] ${d.toString().trim()}`));

  child.on('exit', (code, signal) => {
    log(`Gateway exited code=${code} signal=${signal}`);
    const wasRunning = !!child;
    child = null;
    _onStatus?.({ running: false, exitCode: code });
    // Auto-restart on unexpected exit, up to MAX_RESTARTS
    if (wasRunning && code !== 0 && code !== null && restartCount < MAX_RESTARTS) {
      restartCount++;
      log(`Auto-restart attempt ${restartCount}/${MAX_RESTARTS} in 2s…`);
      setTimeout(start, 2000);
    }
  });

  child.on('error', (err) => {
    log(`Spawn error: ${err.message}. Make sure 'python' is on PATH, or set LLP_PYTHON.`);
    _onStatus?.({ running: false, error: err.message });
    child = null;
  });

  // Probe for liveness after a short delay
  setTimeout(() => {
    probeAlive((alive) => {
      log(`Health probe: ${alive ? 'ALIVE' : 'not responding yet'}`);
      _onStatus?.({ running: alive });
    });
  }, 1500);
}

function stop() {
  if (!child) return;
  log('Stopping gateway…');
  // give it a chance to clean up
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
  } else {
    child.kill('SIGTERM');
  }
  child = null;
  _onStatus?.({ running: false });
}

function isRunning() {
  return !!child;
}

async function isAlive() {
  return new Promise((resolve) => probeAlive(resolve));
}

function attachListeners({ onLog, onStatus }) {
  _onLog = onLog;
  _onStatus = onStatus;
}

module.exports = {
  start, stop, isRunning, isAlive, attachListeners,
  GATEWAY_PORT, GATEWAY_HOST,
};
