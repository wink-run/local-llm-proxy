// client/electron/mitm-proxy.js
// 选择性 MITM forward proxy（mitm-env / mitm-system 用）。
//   - 收 CONNECT；目标域名是否解密 → 查 config-loader.shouldMitm（来自 yaml，无硬编码）
//   - 命中：ca-manager 动态签证书解密 → 用内置 http.Server 逐请求转发真上游（正确处理
//     keep-alive / chunked / SSE 流式）→ 抽 usage 交 onUsage 记账
//   - 未命中：裸 TCP 隧道，不解密（隐私零接触）
'use strict';

const http  = require('http');
const https = require('https');
const net   = require('net');
const tls   = require('tls');
const zlib  = require('zlib');
const configLoader = require('./config-loader');
const caManager    = require('./ca-manager');

let _server = null;
let _proxyServer = null;   // 解密后逐请求转发的内部 http.Server
let _port = 8888;
let _onUsage = null;      // (info) => void  记账回调
let _onError = null;      // (host, err) => void

function setUsageRecorder(fn) { _onUsage = typeof fn === 'function' ? fn : null; }
function setErrorHandler(fn) { _onError = typeof fn === 'function' ? fn : null; }

// 解压响应体（usage 解析用；客户端那份是原样转发的）
function decompress(buf, encoding) {
  try {
    if (/gzip/i.test(encoding)) return zlib.gunzipSync(buf);
    if (/deflate/i.test(encoding)) return zlib.inflateSync(buf);
    if (/br/i.test(encoding)) return zlib.brotliDecompressSync(buf);
  } catch {}
  return buf;
}

// 从（已解压）响应体抽 usage：兼容非流式 JSON 和 SSE 流。
function extractUsage(bodyBuf) {
  const body = bodyBuf.toString('utf8');
  const fromJson = (raw) => {
    try {
      const obj = JSON.parse(raw);
      const u = obj.usage || obj.message?.usage || obj.response?.usage || {};
      const i = u.prompt_tokens ?? u.input_tokens;
      const o = u.completion_tokens ?? u.output_tokens;
      if (i != null || o != null) {
        return { input_tokens: i || 0, output_tokens: o || 0, message_id: obj.id || obj.message?.id || null };
      }
    } catch {}
    return null;
  };
  // ① 整体 JSON（非流式）
  const s = body.indexOf('{'), e = body.lastIndexOf('}');
  let usage = (s >= 0 && e > s) ? fromJson(body.slice(s, e + 1)) : null;
  // ② SSE 流：逐 data: 行找带 usage 的 JSON（取最后一个）
  if (!usage && body.includes('data:')) {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const ds = t.slice(5).trim();
      if (!ds || ds === '[DONE]') continue;
      const u = fromJson(ds);
      if (u) usage = u;
    }
  }
  return usage;
}

// 解密后的请求 → 转发真上游（每条 TLS 连接内可有多条请求，由 http.Server 解析）
function getProxyServer() {
  if (_proxyServer) return _proxyServer;
  _proxyServer = http.createServer((creq, cres) => {
    const host = (creq.headers.host || '').split(':')[0];
    if (!host) { try { cres.destroy(); } catch {} return; }

    const headers = { ...creq.headers };
    delete headers['proxy-connection'];

    const ureq = https.request({
      host, port: 443, method: creq.method, path: creq.url,
      headers, servername: host,
    }, (ures) => {
      // 原样把响应头/体回给客户端（保持流式）
      try { cres.writeHead(ures.statusCode, ures.headers); } catch {}
      const collect = [];
      let total = 0;
      ures.on('data', (d) => {
        cres.write(d);
        if (_onUsage && total < 4 * 1024 * 1024) { collect.push(d); total += d.length; } // 限 4MB 防爆内存
      });
      ures.on('end', () => {
        try { cres.end(); } catch {}
        if (_onUsage && collect.length) {
          try {
            const raw = decompress(Buffer.concat(collect), ures.headers['content-encoding']);
            const usage = extractUsage(raw);
            if (usage) _onUsage({ host, path: creq.url, method: creq.method, usage, data_source: 'mitm' });
          } catch {}
        }
      });
      ures.on('error', () => { try { cres.destroy(); } catch {} });
    });
    ureq.on('error', (e) => {
      console.error('[mitm] 上游错误', host, e.code || e.message);
      _onError && _onError(host, e);
      try { if (!cres.headersSent) cres.writeHead(502); cres.end(); } catch {}
    });
    creq.on('error', () => { try { ureq.destroy(); } catch {} });
    creq.pipe(ureq);   // 转发请求体（流式）
  });
  _proxyServer.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
  return _proxyServer;
}

function handleConnect(req, clientSocket, head) {
  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;
  clientSocket.on('error', () => {});

  // ★ 拦截判断完全来自 yaml（config-loader），不硬编码
  if (!configLoader.shouldMitm(host)) {
    return blindTunnel(host, port, clientSocket, head);
  }

  let leaf;
  try { leaf = caManager.signLeaf(host); }
  catch (e) { console.error('[mitm] signLeaf 失败', host, e.message); _onError && _onError(host, e); return blindTunnel(host, port, clientSocket, head); }

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  // 仅协商 HTTP/1.1（Chromium 否则会用 h2，我们这里按 h1 解析）
  const tlsClient = new tls.TLSSocket(clientSocket, {
    isServer: true, cert: leaf.cert, key: leaf.key, ALPNProtocols: ['http/1.1'],
  });
  tlsClient.on('error', (e) => { _onError && _onError(host, e); });
  if (head && head.length) tlsClient.unshift(head);
  // 交给内部 http.Server 解析并逐请求转发
  getProxyServer().emit('connection', tlsClient);
}

function blindTunnel(host, port, clientSocket, head) {
  const up = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(clientSocket); clientSocket.pipe(up);
  });
  up.on('error', () => clientSocket.destroy());
}

function start(port) {
  if (_server) return { running: true, port: _port };
  _port = port || (configLoader.gatewayCtx().mitm || '127.0.0.1:8888').split(':')[1] || 8888;
  try { caManager.ensureCA(); } catch (e) { console.error('[mitm] ensureCA 失败:', e.message); }
  _server = http.createServer((req, res) => { res.writeHead(200); res.end('tokenbank-mitm'); });
  _server.on('connect', handleConnect);
  _server.listen(parseInt(_port, 10), '127.0.0.1', () => console.log(`[mitm] listening 127.0.0.1:${_port}`));
  _server.on('error', (e) => console.error('[mitm] server error:', e.message));
  return { running: true, port: _port };
}

function stop() {
  if (!_server) return;
  const s = _server; _server = null;
  try { s.close(); } catch {}
}

module.exports = { start, stop, setUsageRecorder, setErrorHandler, getStatus: () => ({ running: !!_server, port: _port }) };
