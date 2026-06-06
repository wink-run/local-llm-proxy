// client/electron/mitm-proxy.js
// 选择性 MITM forward proxy（策略3 mitm-env 用）。
//   - 收 CONNECT；目标域名是否解密 → 查 config-loader.shouldMitm（来自 yaml，无硬编码）
//   - 命中：ca-manager 动态签证书解密 → 读 path + usage → 交 onUsage 记账 → 转发真上游
//   - 未命中：裸 TCP 隧道，不解密（隐私零接触）
// 复用本机已验证的 PoC 方式：握手错误会上报，非 AI 流量全透传保证系统不断网。
'use strict';

const http = require('http');
const net  = require('net');
const tls  = require('tls');
const configLoader = require('./config-loader');
const caManager    = require('./ca-manager');

let _server = null;
let _port = 8888;
let _onUsage = null;      // (info) => void  记账回调
let _onError = null;      // (host, err) => void

function setUsageRecorder(fn) { _onUsage = typeof fn === 'function' ? fn : null; }

// 从解密后的响应里提取 usage。响应可能是非流式 JSON 或 SSE 流，统一兜底解析。
function extractUsage(host, firstReqLine, respBuf) {
  const txt = respBuf.toString('utf8');
  const sep = txt.indexOf('\r\n\r\n');
  let body = sep >= 0 ? txt.slice(sep + 4) : txt;

  // 若是 chunked 传输编码，去掉每个 chunk 的长度行（简单清洗）
  const headers = sep >= 0 ? txt.slice(0, sep).toLowerCase() : '';
  if (headers.includes('transfer-encoding: chunked')) {
    body = body.replace(/^[0-9a-fA-F]+\r\n/gm, '').replace(/\r\n0\r\n[\s\S]*$/, '');
  }

  // ① 尝试整体 JSON（非流式）
  const fromJson = (raw) => {
    try {
      const obj = JSON.parse(raw);
      const u = obj.usage || obj.message?.usage || {};
      const i = u.prompt_tokens ?? u.input_tokens;
      const o = u.completion_tokens ?? u.output_tokens;
      if (i != null || o != null) return { input_tokens: i || 0, output_tokens: o || 0, message_id: obj.id || null };
    } catch {}
    return null;
  };
  // 截取第一个 { 到最后一个 }，容忍前后噪声
  const s = body.indexOf('{'), e = body.lastIndexOf('}');
  let usage = (s >= 0 && e > s) ? fromJson(body.slice(s, e + 1)) : null;

  // ② SSE 流：逐 data: 行找带 usage 的 JSON
  if (!usage && body.includes('data:')) {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const ds = t.slice(5).trim();
      if (!ds || ds === '[DONE]') continue;
      const u = fromJson(ds);
      if (u) { usage = u; /* 取最后一个带 usage 的（通常末帧）*/ }
    }
  }
  return usage;
}

function handleConnect(req, clientSocket, head) {
  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;
  clientSocket.on('error', () => {});

  // ★ 拦截判断完全来自 yaml（config-loader），不硬编码
  if (!configLoader.shouldMitm(host)) {
    return blindTunnel(host, port, clientSocket, head);
  }
  console.log('[mitm] CONNECT(拦截)', host);

  let leaf;
  try { leaf = caManager.signLeaf(host); }
  catch (e) { console.error('[mitm] signLeaf 失败', host, e.message); _onError && _onError(host, e); return blindTunnel(host, port, clientSocket, head); }

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  // 仅协商 HTTP/1.1（避免 Chromium 用 h2 而我们只会 h1 导致连不上）
  const tlsClient = new tls.TLSSocket(clientSocket, {
    isServer: true, cert: leaf.cert, key: leaf.key, ALPNProtocols: ['http/1.1'],
  });
  tlsClient.on('error', (e) => { console.error('[mitm] 客户端 TLS 错误', host, e.code || e.message); _onError && _onError(host, e); });
  tlsClient.on('secure', () => console.log('[mitm] 客户端 TLS 握手成功', host, 'alpn=' + (tlsClient.alpnProtocol || 'none')));

  let reqFirstLine = null;
  tlsClient.once('data', (buf) => {
    reqFirstLine = buf.toString('latin1').split('\r\n')[0];  // 看到 PATH
    console.log('[mitm] 请求', host, reqFirstLine);
    // 连真上游，转发解密后的明文请求（强制 h1）
    const up = tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] }, () => up.write(buf));
    const respChunks = [];
    up.on('data', (d) => { respChunks.push(d); tlsClient.write(d); });
    up.on('end', () => {
      tlsClient.end();
      if (_onUsage) {
        const usage = extractUsage(host, reqFirstLine, Buffer.concat(respChunks));
        _onUsage({ host, path: (reqFirstLine || '').split(' ')[1] || '', usage, data_source: 'mitm' });
      }
    });
    up.on('error', (e) => { console.error('[mitm] 上游错误', host, e.code || e.message); tlsClient.destroy(); });
    // 客户端后续数据也转发（流式请求体）
    tlsClient.on('data', (d) => { try { up.write(d); } catch {} });
  });
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
  // CA 就绪（auto 会按 yaml mitm-domains 生成约束 CA）
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

function setErrorHandler(fn) { _onError = typeof fn === 'function' ? fn : null; }

module.exports = { start, stop, setUsageRecorder, setErrorHandler, getStatus: () => ({ running: !!_server, port: _port }) };
