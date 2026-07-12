// agent-dispatch-server.js
// 主进程本地 HTTP 派发服务：供 Codex 沙箱内的 bridge MCP 子进程调用，避免子进程写 SQLite。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TB_DIR = path.join(os.homedir(), '.tokenbank');
const INFO_PATH = path.join(TB_DIR, 'dispatch-server.json');

let server = null;
let endpoint = null;

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function writeInfo(info) {
  fs.mkdirSync(TB_DIR, { recursive: true });
  fs.writeFileSync(INFO_PATH, JSON.stringify(info, null, 2), 'utf8');
  endpoint = info;
}

/** 供 bridge launcher 读取派发端点（url + token） */
function getDispatchEndpoint() {
  if (endpoint?.url && endpoint?.token) return endpoint;
  try {
    if (fs.existsSync(INFO_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8'));
      if (parsed?.url && parsed?.token) {
        endpoint = parsed;
        return endpoint;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 2 * 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/**
 * 启动派发 HTTP 服务（仅监听 127.0.0.1）
 * @param {import('./agent-executor')} agentExecutor
 * @param {import('./resource-manager')} resourceManager
 */
function startDispatchServer(agentExecutor, resourceManager) {
  if (server) return getDispatchEndpoint();

  const token = generateToken();

  server = http.createServer(async (req, res) => {
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (bearer !== token) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const host = req.headers.host || '127.0.0.1';
      const url = new URL(req.url || '/', `http://${host}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/agents') {
        const agents = await agentExecutor.listAvailableAgents();
        sendJson(res, 200, { agents });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/prompt') {
        const name = url.searchParams.get('name') || '';
        const args = url.searchParams.get('args') || '';
        const clientId = url.searchParams.get('clientId') || '';
        const result = resourceManager.resolvePromptForClient(name, args, clientId);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/dispatch') {
        const body = await readJsonBody(req);
        const agentId = String(body.agentId || body.agent_id || '').trim();
        const prompt = String(body.prompt || '').trim();
        if (!agentId || !prompt) {
          sendJson(res, 400, { error: 'missing agentId or prompt' });
          return;
        }

        const status = await agentExecutor.dispatchAndWait(agentId, prompt, {
          workingDir: body.workingDir || body.working_dir,
          parentTaskId: body.parentTaskId || body.parent_task_id,
          parentSessionKey: body.parentSessionKey || body.parent_session_key,
          parentSessionInstanceId: body.parentSessionInstanceId || body.parent_session_instance_id,
          mode: 'worker',
        });
        sendJson(res, 200, { status });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[dispatch-server] request failed:', e.message);
      sendJson(res, 500, { error: e.message || 'internal error' });
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeInfo({ url: `http://127.0.0.1:${port}`, token });
    console.log(`[dispatch-server] listening on ${endpoint.url}`);
  });

  return getDispatchEndpoint();
}

function stopDispatchServer() {
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
  try { if (fs.existsSync(INFO_PATH)) fs.unlinkSync(INFO_PATH); } catch {}
  endpoint = null;
}

module.exports = {
  startDispatchServer,
  stopDispatchServer,
  getDispatchEndpoint,
  INFO_PATH,
};
