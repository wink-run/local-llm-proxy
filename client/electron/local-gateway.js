// client/electron/local-gateway.js
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const codexTransform = require('./codex-transform');
const reqRouter = require('./request-router');
const oauth = require('./oauth');
const { estimateCost } = require('./pricing');
const { compressBody, compressionRatio } = require('./compressor');

// 出站代理：境外供给源（如 Google Gemini）常需走本机代理才能连通。
// 优先级：provider.proxy > 全局 cfg.network_proxy > 环境变量(HTTPS_PROXY/HTTP_PROXY，遵守 NO_PROXY)。
let _HttpsProxyAgent = null, _getProxyForUrl = null;
try { _HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch {}
try { _getProxyForUrl = require('proxy-from-env').getProxyForUrl; } catch {}
function resolveProxyAgent(provider, urlStr) {
  if (!_HttpsProxyAgent) return undefined;
  let proxyUrl = provider && provider.proxy;
  if (!proxyUrl && _getConfig) { try { proxyUrl = _getConfig().network_proxy; } catch {} }
  if (!proxyUrl && _getProxyForUrl) { try { proxyUrl = _getProxyForUrl(urlStr); } catch {} }
  return proxyUrl ? new _HttpsProxyAgent(proxyUrl) : undefined;
}

// ── In-memory state ───────────────────────────────────────────────────────────

const LOG_MAX = 100;
const log = []; // circular, newest last

// 路由明细持久化：进程重启后 in-memory log 会清空，落盘后可恢复（与 stats DB 对齐）
const ROUTE_LOG_FILE = path.join(os.homedir(), '.tokenbank', 'gateway-route-log.json');
let _routeLogSaveTimer = null;
function _loadRouteLog() {
  try {
    const arr = JSON.parse(fs.readFileSync(ROUTE_LOG_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const e of arr.slice(-LOG_MAX)) log.push(e);
  } catch {}
}
function _saveRouteLog() {
  // 节流：合并 1s 内的多次写入，避免每请求一次磁盘 IO
  if (_routeLogSaveTimer) return;
  _routeLogSaveTimer = setTimeout(() => {
    _routeLogSaveTimer = null;
    try {
      fs.mkdirSync(path.dirname(ROUTE_LOG_FILE), { recursive: true });
      fs.writeFileSync(ROUTE_LOG_FILE, JSON.stringify(log));
    } catch {}
  }, 1000);
}
_loadRouteLog();

// ── 压缩比数据记录 ───────────────────────────────────────────────────────────
// 每次无损压缩的 before/after/ratio 追加到 JSONL（best-effort，不阻塞热路径），
// 并维护累计聚合，便于回看整体压缩效果。
const COMPRESSION_LOG_FILE = path.join(os.homedir(), '.tokenbank', 'compression-log.jsonl');
const _compAgg = { count: 0, before: 0, after: 0 };
function _recordCompression(model, before, after) {
  _compAgg.count += 1; _compAgg.before += before; _compAgg.after += after;
  const rec = {
    ts: new Date().toISOString(), model: model || null,
    before, after, saved: before - after, ratio: +compressionRatio(before, after).toFixed(4),
  };
  try {
    fs.mkdirSync(path.dirname(COMPRESSION_LOG_FILE), { recursive: true });
    fs.appendFile(COMPRESSION_LOG_FILE, JSON.stringify(rec) + '\n', () => {});
  } catch {}
  return rec;
}
/** 累计压缩比（供调试/查看）。 */
function compressionStats() {
  return { ...(_compAgg), ratio: +compressionRatio(_compAgg.before, _compAgg.after).toFixed(4) };
}

// 调试日志：把完整请求/响应写到文件，便于排查 Claude Desktop 等客户端实际发了什么
const DEBUG_LOG_FILE = path.join(os.homedir(), 'tokenbank-gateway-debug.log');
function debugLog(label, data) {
  try {
    const line = `\n[${new Date().toISOString()}] ${label}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`;
    fs.appendFileSync(DEBUG_LOG_FILE, line);
  } catch {}
}

let _getConfig   = null;     // () => config object (set at start)
let _saveConfig  = null;     // (config) => void  写回配置（OAuth 刷新后回写凭证）
let _server      = null;
let _port        = 11430;
// 'llm-router-{id}' → { steps: [{model, tier, ...}], scene_name }
let _routerModelMap = {};
// P2P models with active workers (for UI display only, not used in routing)
let _peerModels   = new Set();
// Backend config: p2p providers forward here by default
let _backendUrl   = null;
let _cloudToken   = null;

// Stats recorder callback — set by main process via setStatsRecorder()
let _statsRecorder = null;
// Local stats module — set by main process via setLocalStats(), used for HTTP queries
let _localStats    = null;
// local-config 读取器（由 main 注入，供策略组调度查 policies[]）
let _getLocalConfig = null;

// ── Format conversion (Anthropic ↔ OpenAI) ───────────────────────────────────

function anthropicToOpenai(body) {
  const messages = [...(body.messages || [])];
  if (body.system) messages.unshift({ role: 'system', content: body.system });
  const oai = { model: body.model || '', messages, stream: !!body.stream };
  if (body.max_tokens  != null) oai.max_tokens  = body.max_tokens;
  if (body.temperature != null) oai.temperature = body.temperature;
  if (body.top_p       != null) oai.top_p       = body.top_p;
  if (body.stop_sequences)      oai.stop        = body.stop_sequences;
  return oai;
}

function openaiToAnthropic(oai, model) {
  const choice = (oai.choices || [{}])[0];
  const text   = ((choice.message || {}).content) || '';
  const finish = choice.finish_reason || 'stop';
  const usage  = oai.usage || {};
  return {
    id: oai.id || ('msg_' + Math.random().toString(36).slice(2, 26)),
    type: 'message', role: 'assistant',
    content: [{ type: 'text', text }],
    model,
    stop_reason: (finish === 'stop' || finish == null) ? 'end_turn' : finish,
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

// Convert OpenAI request body → Anthropic request body
function oaiRequestToAnthropic(oai) {
  const msgs = (oai.messages || []).filter(m => m.role !== 'system');
  const sys  = (oai.messages || []).find(m => m.role === 'system');
  const anth = { model: oai.model, max_tokens: oai.max_tokens || 4096, messages: msgs };
  if (sys) anth.system = typeof sys.content === 'string' ? sys.content : (sys.content?.[0]?.text || '');
  if (oai.temperature != null) anth.temperature = oai.temperature;
  if (oai.top_p       != null) anth.top_p       = oai.top_p;
  if (oai.stop) anth.stop_sequences = Array.isArray(oai.stop) ? oai.stop : [oai.stop];
  if (oai.stream) anth.stream = true;
  return anth;
}

// Convert Anthropic response body → OpenAI response body
function anthropicRespToOai(anth) {
  const text   = (anth.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const finish = anth.stop_reason === 'end_turn' ? 'stop' : (anth.stop_reason || 'stop');
  const inTok  = anth.usage?.input_tokens  || 0;
  const outTok = anth.usage?.output_tokens || 0;
  return {
    id: anth.id || ('chatcmpl-' + Math.random().toString(36).slice(2)),
    object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: anth.model || '',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish, logprobs: null }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// ── Provider helpers ──────────────────────────────────────────────────────────

// 归一 base_url：去掉尾部斜杠 + 任意版本尾段（/v1 /v2 /v3 …）。
// 网关转发时用 base + '/' + apiVer(原url) + '/chat/completions'，
// 保留原版本号（如 /v3）而不是一律改成 /v1。
function normBase(url) {
  return (url || '').replace(/\/+$/, '').replace(/\/v\d+$/, '');
}
// 提取 base_url 末尾版本号，默认 v1。
function apiVer(url) {
  const m = (url || '').replace(/\/+$/, '').match(/\/(v\d+)$/);
  return m ? m[1] : 'v1';
}

// OAI 流式默认不返回 usage，需在请求体加 stream_options.include_usage=true 才会在末帧返回。
// 上游不识别此选项时会被忽略（不报错），所以默认注入是安全的。
function withUsageOption(body) {
  if (!body?.stream || body.stream_options) return body;
  return { ...body, stream_options: { include_usage: true } };
}

// All enabled providers, each with an effective models list.
// P2P providers: base_url/token come from backend config; models come from live _peerModels.
// Other providers: models from their configured models array (empty = serves any model).
function enabledProviders() {
  if (!_getConfig) return [];
  const cfg = _getConfig();
  return (cfg.providers || [])
    .filter(p => {
      if (!p.enabled) return false;
      if (p.type === 'p2p') return !!_backendUrl;
      return !!p.base_url;
    })
    .map(p => {
      if (p.type === 'p2p') {
        return { ...p, base_url: _backendUrl, token: _cloudToken || p.token, models: [..._peerModels] };
      }
      return p;
    });
}

// Returns true if provider can serve the given model
function providerHasModel(provider, model) {
  const list = provider.models;
  // P2P 仅服务云端在线模型列表，不能因 models 为空就匹配任意模型（否则会抢在付费源之前回退）
  if (provider.type === 'p2p') {
    return _peerModels.size > 0 && _peerModels.has(model);
  }
  if (!Array.isArray(list) || list.length === 0) return true; // 无列表 = 接受任意（付费/免费自定义源）
  return list.some(m => (typeof m === 'string' ? m : m.name) === model);
}

/** 从上游 4xx/5xx 响应体提取可读错误信息 */
function formatHttpError(statusCode, bodyStr) {
  let msg = `HTTP_${statusCode}`;
  if (!bodyStr) return msg;
  try {
    const j = JSON.parse(bodyStr);
    const em = j.error?.message || j.error?.detail || (typeof j.error === 'string' ? j.error : '');
    if (em) return `${msg}: ${em}`;
  } catch {}
  const t = String(bodyStr).trim().slice(0, 240);
  return t ? `${msg}: ${t}` : msg;
}

function readProxyError(proxyRes, reject) {
  const chunks = [];
  proxyRes.on('data', c => chunks.push(c));
  proxyRes.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const msg = formatHttpError(proxyRes.statusCode, body);
    reject(Object.assign(new Error(msg), { status: proxyRes.statusCode, body }));
  });
  proxyRes.on('error', () => {
    reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
  });
}

/** 路由失败时优先展示付费/本地源错误，避免 P2P 401 掩盖上游真实原因 */
function pickBestRouteError(errors) {
  if (!errors?.length) return null;
  const nonP2p = errors.find(e => e.id !== 'tokenbank-p2p');
  return (nonP2p || errors[0]).err;
}

// ── HTTP proxy ────────────────────────────────────────────────────────────────

function proxyRequest(provider, reqPath, body, res) {
  return new Promise((resolve, reject) => {
    const base    = normBase(provider.base_url);
    const ver     = apiVer(provider.base_url);
    const fullUrl = base + reqPath.replace(/^\/v1\//, `/${ver}/`);
    let u;
    try { u = new URL(fullUrl); }
    catch { return reject(new Error('invalid_url')); }

    const mod      = u.protocol === 'https:' ? https : http;
    // 只对 OAI 路径注入 stream_options（Anthropic /v1/messages 不识别）
    let sendBody = /\/chat\/completions$/.test(reqPath) ? withUsageOption(body) : body;
    let headers  = {
      'Content-Type':   'application/json',
      'Accept':         'text/event-stream, application/json',
    };
    if (provider._oauth) {
      // OAuth 供给源：注入 Bearer + 指纹头 + system，覆盖默认认证头
      const ap = provider._oauth.applyAuth({ headers, body: sendBody, credentials: provider.credentials });
      headers = ap.headers; sendBody = ap.body;
    } else if (provider.token) {
      if (/anthropic/i.test(provider.base_url || '') || provider.api_format === 'anthropic') {
        headers['x-api-key'] = provider.token;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${provider.token}`;
      }
    }
    const bodyStr = JSON.stringify(sendBody);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method:  'POST',
      headers,
      timeout: 120_000,
    };

    const t0 = Date.now();
    let firstTokenMs = null;
    const isStream = !!body.stream;

    const proxyReq = mod.request(opts, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        return readProxyError(proxyRes, reject);
      }
      if (res.headersSent) {
        proxyRes.resume();
        return reject(new Error('headers_already_sent'));
      }
      res.writeHead(proxyRes.statusCode, {
        'Content-Type':          proxyRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control':         'no-cache',
        'X-Accel-Buffering':     'no',
        'Access-Control-Allow-Origin': '*',
      });

      const status = proxyRes.statusCode;
      if (isStream) {
        // Streaming: pipe to client while sniffing SSE events for usage + upstream message id.
        // Cache tokens may appear too (Anthropic message_start / message_delta).
        let usageIn = 0, usageOut = 0, cacheCreate = 0, cacheRead = 0, msgId = null;
        let sseBuf = '';
        proxyRes.on('data', (chunk) => {
          res.write(chunk);
          sseBuf += chunk.toString();
          const lines = sseBuf.split('\n');
          sseBuf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const ds = line.slice(6).trim();
            if (!ds || ds === '[DONE]') continue;
            if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
            try {
              const obj = JSON.parse(ds);
              // 上游响应 id：OpenAI chunk 顶层 id；Anthropic message_start 在 message.id
              if (!msgId) msgId = obj.id || obj.message?.id || null;
              // Anthropic 缓存 token 分布在 message_start / message_delta
              const au = obj.message?.usage || (obj.type === 'message_delta' ? obj.usage : null);
              if (au) {
                if (au.input_tokens                != null) usageIn     = au.input_tokens;
                if (au.output_tokens               != null) usageOut    = au.output_tokens;
                if (au.cache_creation_input_tokens != null) cacheCreate = au.cache_creation_input_tokens;
                if (au.cache_read_input_tokens     != null) cacheRead   = au.cache_read_input_tokens;
              }
              if (obj.usage) {
                usageIn  = obj.usage.prompt_tokens     || obj.usage.input_tokens     || usageIn;
                usageOut = obj.usage.completion_tokens || obj.usage.output_tokens    || usageOut;
              }
            } catch {}
          }
        });
        const done = () => ({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: usageIn, output_tokens: usageOut, cache_create_tokens: cacheCreate, cache_read_tokens: cacheRead,
          message_id: msgId, status_code: status });
        proxyRes.on('end',   () => { res.end();        resolve(done()); });
        proxyRes.on('error', (err) => { res.destroy(err); resolve(done()); });
      } else {
        // Non-streaming: buffer, forward, then parse usage + id from JSON
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          const buf = Buffer.concat(chunks);
          res.end(buf);
          let usageIn = 0, usageOut = 0, cacheCreate = 0, cacheRead = 0, msgId = null;
          try {
            const obj = JSON.parse(buf.toString());
            msgId = obj.id || null; // OpenAI chatcmpl_xxx / Anthropic msg_xxx 都在顶层 id
            const u   = obj.usage || {};
            usageIn  = u.prompt_tokens     || u.input_tokens                || 0;
            usageOut = u.completion_tokens || u.output_tokens               || 0;
            cacheCreate = u.cache_creation_input_tokens || 0;
            cacheRead   = u.cache_read_input_tokens     || 0;
          } catch {}
          resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: Date.now() - t0,
            input_tokens: usageIn, output_tokens: usageOut, cache_create_tokens: cacheCreate, cache_read_tokens: cacheRead,
            message_id: msgId, status_code: status });
        });
        proxyRes.on('error', (err) => { res.destroy(err); resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: Date.now() - t0, input_tokens: 0, output_tokens: 0, status_code: status }); });
      }
    });

    proxyReq.on('error',   reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Converted proxy: non-streaming Anthropic ─────────────────────────────────

function proxyConvertSync(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (provider._oauth) Object.assign(headers, provider._oauth.applyAuth({ headers, credentials: provider.credentials }).headers);
    else if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const errChunks = [];
        proxyRes.on('data', c => errChunks.push(c));
        proxyRes.on('end', () => {
          const body = Buffer.concat(errChunks).toString().slice(0, 200);
          console.warn(`[gateway] proxyConvertSync ${proxyRes.statusCode} body:`, body);
        });
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        try {
          const oaiResp = JSON.parse(Buffer.concat(chunks).toString());
          const resp    = JSON.stringify(openaiToAnthropic(oaiResp, model));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(resp);
          const latency = Date.now() - t0;
          const usage   = oaiResp?.usage || {};
          resolve({ provider: provider.id, latency, first_token_ms: latency,
            input_tokens:  usage.prompt_tokens     || usage.input_tokens     || 0,
            output_tokens: usage.completion_tokens || usage.output_tokens    || 0,
            message_id: oaiResp?.id || null, status_code: proxyRes.statusCode });
        } catch (err) { reject(err); }
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Converted proxy: streaming Anthropic ─────────────────────────────────────

function proxyConvertStream(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(withUsageOption(oaiBody));
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider._oauth) Object.assign(headers, provider._oauth.applyAuth({ headers, credentials: provider.credentials }).headers);
    else if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        proxyRes.resume();
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
      });

      const msgId = 'msg_' + Math.random().toString(36).slice(2, 26);
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: {
        id: msgId, type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      }})}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      })}\n\n`);
      res.write('event: ping\ndata: {"type":"ping"}\n\n');

      let buf = '', outputTokens = 0, stopReason = 'end_turn', firstTokenMs = null;
      let usageIn = 0, usageOut = 0; // from actual usage field in SSE, if present
      // dedup 用客户端实际收到的 id：本路径把上游 OpenAI 流重新包成 Anthropic SSE，
      // 客户端（如 Claude Code）写进 transcript 的是上面这个合成的 msgId，所以 dedup 键用它。

      proxyRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ds = line.slice(6).trim();
          if (ds === '[DONE]') continue;
          try {
            const c      = JSON.parse(ds);
            const choice = (c.choices || [{}])[0];
            const text   = (choice.delta || {}).content || '';
            const finish = choice.finish_reason;
            if (text) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              outputTokens++;
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index: 0,
                delta: { type: 'text_delta', text },
              })}\n\n`);
            }
            if (finish) stopReason = finish === 'stop' ? 'end_turn' : finish;
            // Capture actual usage if provider includes it (e.g. final chunk with usage)
            if (c.usage) {
              usageIn  = c.usage.prompt_tokens     || c.usage.input_tokens     || usageIn;
              usageOut = c.usage.completion_tokens || c.usage.output_tokens    || usageOut;
            }
          } catch {}
        }
      });

      proxyRes.on('end', () => {
        // Prefer actual usage from provider; fall back to manual output token count
        const finalOut = usageOut || outputTokens;
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: finalOut },
        })}\n\n`);
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
        resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0, input_tokens: usageIn, output_tokens: finalOut, message_id: msgId, status_code: proxyRes.statusCode });
      });

      proxyRes.on('error', (err) => { res.destroy(err); resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0, input_tokens: usageIn, output_tokens: usageOut || outputTokens, message_id: msgId, status_code: proxyRes.statusCode }); });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── OpenAI client → Anthropic provider: format bridge ───────────────────────

function proxyAnthropicSync(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    let anthBody    = oaiRequestToAnthropic({ ...oaiBody, stream: false });
    const base      = normBase(provider.base_url);
    const fullUrl   = base + '/v1/messages';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    let headers   = {
      'Content-Type':      'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (provider._oauth) {
      const ap = provider._oauth.applyAuth({ headers, body: anthBody, credentials: provider.credentials });
      headers = ap.headers; anthBody = ap.body;
    } else if (provider.token) headers['x-api-key'] = provider.token;
    const bodyStr = JSON.stringify(anthBody);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const errChunks = [];
        proxyRes.on('data', c => errChunks.push(c));
        proxyRes.on('end', () => console.warn(`[gateway] proxyAnthropicSync ${proxyRes.statusCode}:`, Buffer.concat(errChunks).toString().slice(0, 200)));
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        try {
          const anthResp = JSON.parse(Buffer.concat(chunks).toString());
          const oaiResp  = anthropicRespToOai(anthResp);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(oaiResp));
          const latency = Date.now() - t0;
          resolve({ provider: provider.id, latency, first_token_ms: latency,
            input_tokens:        anthResp.usage?.input_tokens                || 0,
            output_tokens:       anthResp.usage?.output_tokens               || 0,
            cache_create_tokens: anthResp.usage?.cache_creation_input_tokens || 0,
            cache_read_tokens:   anthResp.usage?.cache_read_input_tokens     || 0,
            message_id: anthResp.id || null, status_code: proxyRes.statusCode });
        } catch (err) { reject(err); }
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

function proxyAnthropicStream(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    let anthBody    = oaiRequestToAnthropic({ ...oaiBody, stream: true });
    const base      = normBase(provider.base_url);
    const fullUrl   = base + '/v1/messages';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    let headers   = {
      'Content-Type':      'application/json',
      'anthropic-version': '2023-06-01',
      'Accept':            'text/event-stream',
    };
    if (provider._oauth) {
      const ap = provider._oauth.applyAuth({ headers, body: anthBody, credentials: provider.credentials });
      headers = ap.headers; anthBody = ap.body;
    } else if (provider.token) headers['x-api-key'] = provider.token;
    const bodyStr = JSON.stringify(anthBody);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        proxyRes.resume();
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
      });

      const chatId  = 'chatcmpl-' + Math.random().toString(36).slice(2, 26);
      const created = Math.floor(Date.now() / 1000);
      // Send role delta
      res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);

      let buf = '', usageIn = 0, usageOut = 0, cacheCreate = 0, cacheRead = 0, firstTokenMs = null, msgId = null;

      proxyRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ds = line.slice(6).trim();
          if (!ds || ds === '[DONE]') continue;
          try {
            const evt = JSON.parse(ds);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }] })}\n\n`);
            } else if (evt.type === 'message_start') {
              msgId       = evt.message?.id                                 || msgId;
              usageIn     = evt.message?.usage?.input_tokens                || 0;
              cacheCreate = evt.message?.usage?.cache_creation_input_tokens || 0;
              cacheRead   = evt.message?.usage?.cache_read_input_tokens     || 0;
            } else if (evt.type === 'message_delta') {
              if (evt.usage?.output_tokens               != null) usageOut    = evt.usage.output_tokens;
              if (evt.usage?.cache_creation_input_tokens != null) cacheCreate = evt.usage.cache_creation_input_tokens;
              if (evt.usage?.cache_read_input_tokens     != null) cacheRead   = evt.usage.cache_read_input_tokens;
            }
          } catch {}
        }
      });

      proxyRes.on('end', () => {
        res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: usageIn, output_tokens: usageOut, cache_create_tokens: cacheCreate, cache_read_tokens: cacheRead,
          message_id: msgId, status_code: proxyRes.statusCode });
      });

      proxyRes.on('error', (err) => { res.destroy(err); resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: usageIn, output_tokens: usageOut, cache_create_tokens: cacheCreate, cache_read_tokens: cacheRead,
          message_id: msgId, status_code: proxyRes.statusCode }); });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Gemini (generateContent) ⇄ OpenAI ───────────────────────────────────────
// Google Gemini 用 generateContent / streamGenerateContent，认证头 x-goog-api-key，
// 请求体/响应体与 OpenAI 完全不同。这里做 OpenAI ⇄ Gemini 双向转换（与 server/virtual_worker.py 对齐）。
function isGeminiProvider(provider) {
  return /generativelanguage\.googleapis\.com/i.test(provider.base_url || '')
    || provider.api_format === 'gemini' || provider.api_style === 'gemini';
}

// gemini base：用户 base_url 已含 /v1beta 时不重复拼接
function geminiBase(rawBaseUrl) {
  const raw = (rawBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  return /\/v1beta/i.test(raw) ? raw : raw + '/v1beta';
}

// OpenAI chat body → Gemini generateContent body
function oaiToGeminiBody(oai) {
  const systemParts = [];
  const contents = [];
  const textOf = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(p => p && p.type === 'text').map(p => p.text || '').join('');
    return '';
  };
  for (const m of (oai.messages || [])) {
    const role = m.role || 'user';
    if (role === 'system') { systemParts.push({ text: textOf(m.content) }); continue; }
    const gRole = role === 'assistant' ? 'model' : 'user';
    contents.push({ role: gRole, parts: [{ text: textOf(m.content) }] });
  }
  const body = { contents };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };
  const gen = {};
  if (oai.max_tokens != null) gen.maxOutputTokens = oai.max_tokens;
  if (oai.temperature != null) gen.temperature = oai.temperature;
  if (oai.top_p != null) gen.topP = oai.top_p;
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

function geminiExtractText(data) {
  for (const cand of (data.candidates || [])) {
    for (const part of (cand.content?.parts || [])) {
      if (typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

// Gemini 非流式：generateContent → OpenAI json / Anthropic json（按客户端协议）
function proxyGeminiSync(provider, oaiBody, model, res, outAnthropic) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${geminiBase(provider.base_url)}/models/${model}:generateContent`;
    let u; try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }
    const mod = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiToGeminiBody(oaiBody));
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'x-goog-api-key': provider.token || '',
    };
    const t0 = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000, agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (proxyRes.statusCode >= 400) {
          debugLog('proxyGeminiSync 上游错误', { status: proxyRes.statusCode, body: raw.slice(0, 400) });
          return reject(Object.assign(new Error(formatHttpError(proxyRes.statusCode, raw)), { status: proxyRes.statusCode, body: raw }));
        }
        let data; try { data = JSON.parse(raw); } catch (err) { return reject(err); }
        const text = geminiExtractText(data);
        const um = data.usageMetadata || {};
        const inTok = um.promptTokenCount || 0, outTok = um.candidatesTokenCount || 0;
        const latency = Date.now() - t0;
        const oaiResp = {
          id: 'chatcmpl-' + Math.random().toString(36).slice(2, 12),
          object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
        };
        const out = outAnthropic ? openaiToAnthropic(oaiResp, model) : oaiResp;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(out));
        resolve({ provider: provider.id, latency, first_token_ms: latency,
          input_tokens: inTok, output_tokens: outTok, message_id: oaiResp.id, status_code: 200 });
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// Gemini 流式：streamGenerateContent?alt=sse → 客户端 SSE（OpenAI 或 Anthropic 格式）
function proxyGeminiStream(provider, oaiBody, model, res, outAnthropic) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${geminiBase(provider.base_url)}/models/${model}:streamGenerateContent?alt=sse`;
    let u; try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }
    const mod = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiToGeminiBody(oaiBody));
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept': 'text/event-stream',
      'x-goog-api-key': provider.token || '',
    };
    const t0 = Date.now();
    let firstTokenMs = null;
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000, agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const ec = [];
        proxyRes.on('data', c => ec.push(c));
        proxyRes.on('end', () => {
          const errBody = Buffer.concat(ec).toString().slice(0, 400);
          debugLog('proxyGeminiStream 上游错误', { status: proxyRes.statusCode, body: errBody });
          reject(Object.assign(new Error(formatHttpError(proxyRes.statusCode, errBody)), { status: proxyRes.statusCode, body: errBody }));
        });
        proxyRes.on('error', () => reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode })));
        return;
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });

      const chatId = 'chatcmpl-' + Math.random().toString(36).slice(2, 26);
      const msgId  = 'msg_' + Math.random().toString(36).slice(2, 26);
      const created = Math.floor(Date.now() / 1000);
      let usageIn = 0, usageOut = 0, stopReason = 'end_turn';

      // 开场事件
      if (outAnthropic) {
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: {
          id: msgId, type: 'message', role: 'assistant', content: [], model,
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      }

      const emitText = (text) => {
        if (!text) return;
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        if (outAnthropic) {
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
        }
      };

      let buf = '';
      proxyRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const ds = line.slice(5).replace(/^ /, '').trim();
          if (!ds || ds === '[DONE]') continue;
          let obj; try { obj = JSON.parse(ds); } catch { continue; }
          for (const cand of (obj.candidates || [])) {
            for (const part of (cand.content?.parts || [])) {
              if (typeof part.text === 'string') emitText(part.text);
            }
            if (cand.finishReason) stopReason = (cand.finishReason === 'STOP' || cand.finishReason === 'END_TURN') ? 'end_turn' : 'stop';
          }
          const um = obj.usageMetadata;
          if (um) { usageIn = um.promptTokenCount || usageIn; usageOut = um.candidatesTokenCount || usageOut; }
        }
      });

      const done = () => ({ provider: provider.id, latency: Date.now() - t0,
        first_token_ms: firstTokenMs ?? Date.now() - t0, input_tokens: usageIn, output_tokens: usageOut,
        message_id: outAnthropic ? msgId : chatId, status_code: 200 });

      proxyRes.on('end', () => {
        if (outAnthropic) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usageOut } })}\n\n`);
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        } else {
          res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        res.end();
        resolve(done());
      });
      proxyRes.on('error', (err) => { res.destroy(err); resolve(done()); });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── P2P: always stream from backend, buffer to sync response for non-streaming clients ──

function proxyP2PSync(provider, oaiBody, model, res) {
  // Sends stream:true to backend regardless of client request; assembles & returns Anthropic JSON
  return new Promise((resolve, reject) => {
    const streamBody = withUsageOption({ ...oaiBody, stream: true });
    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(streamBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider._oauth) Object.assign(headers, provider._oauth.applyAuth({ headers, credentials: provider.credentials }).headers);
    else if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const t0 = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const errChunks = [];
        proxyRes.on('data', c => errChunks.push(c));
        proxyRes.on('end', () => {
          const body = Buffer.concat(errChunks).toString().slice(0, 200);
          console.warn(`[gateway] proxyP2PSync ${proxyRes.statusCode} body:`, body);
        });
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      let buf = '', fullText = '', inputTokens = 0, outputTokens = 0, stopReason = 'end_turn', firstTokenMs = null, msgId = null;
      proxyRes.on('data', (chunk) => {
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ds = line.slice(6).trim();
          if (ds === '[DONE]') continue;
          try {
            const c      = JSON.parse(ds);
            if (!msgId) msgId = c.id || null;
            const choice = (c.choices || [{}])[0];
            const text   = (choice.delta || {}).content || '';
            if (text) fullText += text;
            const finish = choice.finish_reason;
            if (finish) stopReason = finish === 'stop' ? 'end_turn' : finish;
            if (c.usage) {
              inputTokens  = c.usage.prompt_tokens     || inputTokens;
              outputTokens = c.usage.completion_tokens || outputTokens;
            }
          } catch {}
        }
      });
      proxyRes.on('end', () => {
        try {
          const resp = JSON.stringify({
            id: 'msg_' + Math.random().toString(36).slice(2, 26),
            type: 'message', role: 'assistant',
            content: [{ type: 'text', text: fullText }],
            model, stop_reason: stopReason, stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(resp);
          }
          resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0, input_tokens: inputTokens, output_tokens: outputTokens, message_id: msgId, status_code: proxyRes.statusCode });
        } catch (err) { reject(err); }
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Codex Responses ⇄ Chat Completions ───────────────────────────────────────
// Codex 客户端走 Responses 协议（/v1/responses），但第三方上游只会 Chat Completions。
// 这里把 Responses 请求转成 Chat 请求转发上游，再把上游 Chat 响应（流式/非流式）转回 Responses。
function proxyResponsesViaChat(provider, responsesBody, model, res) {
  return new Promise((resolve, reject) => {
    const streaming = !!responsesBody.stream;
    // Responses → Chat 请求体（含 stream 时自动注入 include_usage）
    const chatBody = codexTransform.responsesToChat({ ...responsesBody, model });

    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(chatBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider._oauth) Object.assign(headers, provider._oauth.applyAuth({ headers, credentials: provider.credentials }).headers);
    else if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const t0 = Date.now();
    let firstTokenMs = null;
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const ec = [];
        proxyRes.on('data', c => ec.push(c));
        proxyRes.on('end', () => {
          const errBody = Buffer.concat(ec).toString().slice(0, 800);
          debugLog('proxyResponsesViaChat 上游错误', { status: proxyRes.statusCode, base_url: provider.base_url, provider: provider.id, body: errBody });
          reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode, body: errBody }));
        });
        proxyRes.on('error', () => reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode })));
        return;
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }
      const status = proxyRes.statusCode;

      if (streaming) {
        // 流式：上游 Chat SSE → 状态机 → Responses SSE，边转边写给客户端
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
        });
        const sm = new codexTransform.ChatToResponsesStream();
        let buf = '';
        const usageOf = () => { const u2 = sm.getUsage() || {}; return {
          provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: u2.input_tokens || 0, output_tokens: u2.output_tokens || 0,
          cache_read_tokens: u2.cache_read_input_tokens || u2.input_tokens_details?.cached_tokens || 0,
          message_id: sm.getResponseId(), status_code: status }; };

        proxyRes.on('data', (chunk) => {
          buf += chunk.toString();
          // 按行解析（兼容事件间为单个 \n 或标准 \n\n 的上游；每个 data: 行即一个 chat chunk）
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).replace(/^ /, '');
            if (!data) continue;
            if (data.trim() === '[DONE]') { res.write(sm.finalize()); continue; }
            let obj; try { obj = JSON.parse(data); } catch { continue; }
            if (obj.error) { res.write(sm.failedEvent(obj.error.message || 'upstream error', obj.error.type)); continue; }
            if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
            res.write(sm.handleChunk(obj));
          }
        });
        proxyRes.on('end',   () => { if (!sm.completed) res.write(sm.finalize()); res.end(); resolve(usageOf()); });
        proxyRes.on('error', (err) => { if (!sm.completed) res.write(sm.failedEvent(`Stream error: ${err.message}`, 'stream_error')); res.destroy(err); resolve(usageOf()); });
      } else {
        // 非流式：缓冲完整 Chat JSON → 转 Responses JSON
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let respObj, usageIn = 0, usageOut = 0, cacheRead = 0, msgId = null;
          try {
            const chatResp = JSON.parse(raw);
            respObj = codexTransform.chatToResponses(chatResp);
            const u2 = respObj.usage || {};
            usageIn = u2.input_tokens || 0; usageOut = u2.output_tokens || 0;
            cacheRead = u2.cache_read_input_tokens || u2.input_tokens_details?.cached_tokens || 0;
            msgId = respObj.id || null;
          } catch (err) { return reject(err); }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(respObj));
          resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: Date.now() - t0,
            input_tokens: usageIn, output_tokens: usageOut, cache_read_tokens: cacheRead,
            message_id: msgId, status_code: status });
        });
        proxyRes.on('error', reject);
      }
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Codex Responses → Anthropic 供给源（如 Claude OAuth）──────────────────────
// Codex 客户端走 Responses 协议，但 Claude 供给源是 Anthropic /v1/messages。
// 串联现有转换器：Responses→Chat（codexTransform）→ Anthropic（oaiRequestToAnthropic）出，
// 回程 Anthropic→Chat（anthropicRespToOai）→ Responses（chatToResponses / ChatToResponsesStream）。
function proxyResponsesViaAnthropic(provider, responsesBody, model, res) {
  return new Promise((resolve, reject) => {
    const streaming = !!responsesBody.stream;
    const chatBody  = codexTransform.responsesToChat({ ...responsesBody, model });
    let anthBody    = oaiRequestToAnthropic({ ...chatBody, stream: streaming });

    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/messages';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }
    const mod = u.protocol === 'https:' ? https : http;

    let headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (streaming) headers['Accept'] = 'text/event-stream';
    if (provider._oauth) {
      const ap = provider._oauth.applyAuth({ headers, body: anthBody, credentials: provider.credentials });
      headers = ap.headers; anthBody = ap.body;
    } else if (provider.token) headers['x-api-key'] = provider.token;
    const bodyStr = JSON.stringify(anthBody);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const t0 = Date.now();
    let firstTokenMs = null;
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const ec = [];
        proxyRes.on('data', c => ec.push(c));
        proxyRes.on('end', () => {
          const errBody = Buffer.concat(ec).toString().slice(0, 800);
          debugLog('proxyResponsesViaAnthropic 上游错误', { status: proxyRes.statusCode, body: errBody, sent_headers: Object.keys(headers) });
          reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode, body: errBody }));
        });
        proxyRes.on('error', () => reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode })));
        return;
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }
      const status = proxyRes.statusCode;

      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
        const sm = new codexTransform.ChatToResponsesStream();
        const chatId = 'chatcmpl-' + Math.random().toString(36).slice(2, 26);
        let buf = '', usageIn = 0, usageOut = 0, started = false;
        const feed = (obj) => { res.write(sm.handleChunk(obj)); };
        proxyRes.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const ds = line.slice(5).replace(/^ /, '').trim();
            if (!ds || ds === '[DONE]') continue;
            let evt; try { evt = JSON.parse(ds); } catch { continue; }
            if (evt.type === 'message_start') {
              usageIn = evt.message?.usage?.input_tokens || 0;
              if (!started) { started = true; feed({ id: chatId, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }); }
            } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              feed({ id: chatId, choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }] });
            } else if (evt.type === 'message_delta') {
              if (evt.usage?.output_tokens != null) usageOut = evt.usage.output_tokens;
              const stop = evt.delta?.stop_reason;
              if (stop) feed({ id: chatId, choices: [{ index: 0, delta: {}, finish_reason: stop === 'end_turn' ? 'stop' : stop }],
                usage: { prompt_tokens: usageIn, completion_tokens: usageOut, total_tokens: usageIn + usageOut } });
            }
          }
        });
        const done = () => ({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: usageIn, output_tokens: usageOut, message_id: sm.getResponseId ? sm.getResponseId() : null, status_code: status });
        proxyRes.on('end', () => { if (!sm.completed) res.write(sm.finalize()); res.end(); resolve(done()); });
        proxyRes.on('error', (err) => { if (!sm.completed) res.write(sm.failedEvent(`Stream error: ${err.message}`, 'stream_error')); res.destroy(err); resolve(done()); });
      } else {
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          try {
            const anthResp = JSON.parse(Buffer.concat(chunks).toString());
            const respObj  = codexTransform.chatToResponses(anthropicRespToOai(anthResp));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(respObj));
            const latency = Date.now() - t0;
            resolve({ provider: provider.id, latency, first_token_ms: latency,
              input_tokens: anthResp.usage?.input_tokens || 0, output_tokens: anthResp.usage?.output_tokens || 0,
              cache_read_tokens: anthResp.usage?.cache_read_input_tokens || 0,
              message_id: anthResp.id || null, status_code: status });
          } catch (err) { reject(err); }
        });
        proxyRes.on('error', reject);
      }
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

// Call one provider with format conversion; throws on HTTP error.
// provider is already resolved (base_url/token correct, models populated).
async function callProvider(provider, isAnthropic, streaming, reqPath, body, attemptModel, res) {
  // OAuth 供给源：确保 access_token 有效（必要时刷新并回写 config），附加 _oauth 模块
  provider = await oauth.prepare(provider, _getConfig, _saveConfig);

  debugLog(`callProvider 选中 provider`, {
    provider_id: provider.id,
    provider_type: provider.type,
    base_url: provider.base_url,
    api_format: provider.api_format,
    isAnthropic,
    streaming,
    reqPath,
    attemptModel,
  });
  // 转发请求日志（控制台常驻）：看清每次请求实际转发到哪个 provider / 哪个模型
  console.log(`[gateway] → forward model="${attemptModel}" via provider="${provider.id}" (${provider.type}) ${provider.base_url}`);

  // Codex Responses 请求：anthropic 供给源走 Responses→Anthropic 桥，否则走 Responses⇄Chat
  if (reqPath === '/v1/responses' || reqPath === '/responses') {
    const toAnthropic = /anthropic/i.test(provider.base_url || '') || provider.api_format === 'anthropic';
    const rb = { ...body, model: attemptModel };
    return toAnthropic
      ? await proxyResponsesViaAnthropic(provider, rb, attemptModel, res)
      : await proxyResponsesViaChat(provider, rb, attemptModel, res);
  }
  const attemptBody = { ...body, model: attemptModel };

  // Gemini provider（generateContent）：先把客户端请求归一成 OpenAI 体，再转 Gemini
  if (isGeminiProvider(provider)) {
    const oaiBody = isAnthropic ? anthropicToOpenai(attemptBody) : attemptBody;
    return streaming
      ? await proxyGeminiStream(provider, oaiBody, attemptModel, res, isAnthropic)
      : await proxyGeminiSync(provider, oaiBody, attemptModel, res, isAnthropic);
  }

  // Anthropic-compatible provider
  const isAnthropicProvider = /anthropic/i.test(provider.base_url || '') || provider.api_format === 'anthropic';
  if (isAnthropicProvider) {
    if (isAnthropic) {
      // Anthropic client → Anthropic provider: direct proxy to /v1/messages
      return await proxyRequest(provider, '/v1/messages', attemptBody, res);
    } else {
      // OpenAI client → Anthropic provider: convert request/response format
      return streaming
        ? await proxyAnthropicStream(provider, attemptBody, attemptModel, res)
        : await proxyAnthropicSync(provider, attemptBody, attemptModel, res);
    }
  }

  const oaiBody = isAnthropic ? anthropicToOpenai(attemptBody) : null;
  if (isAnthropic) {
    return streaming
      ? await proxyConvertStream(provider, oaiBody, attemptModel, res)
      // P2P backends often only support streaming; use proxyP2PSync (sends stream:true internally)
      : (provider.type === 'p2p'
          ? await proxyP2PSync(provider, oaiBody, attemptModel, res)
          : await proxyConvertSync(provider, oaiBody, attemptModel, res));
  }
  return await proxyRequest(provider, reqPath, attemptBody, res);
}

// ── 条件路由规则引擎（零成本条件）──────────────────────────────────────────────
// 请求模态（从路径推断）：chat / image / video / embedding / audio
function modalityOf(reqPath) {
  const p = String(reqPath || '');
  if (/\/images?(\/|$)/.test(p)) return 'image';
  if (/\/video/.test(p)) return 'video';
  if (/\/embeddings$/.test(p)) return 'embedding';
  if (/\/audio\//.test(p)) return 'audio';
  return 'chat';  // /chat/completions /messages /responses /v1beta(gemini) 等
}
// 拼接输入文本（messages / input / prompt）—— 给 keyword/未来分类器用
function extractText(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  const push = (c) => {
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) for (const s of c) { if (typeof s === 'string') parts.push(s); else if (s && typeof s.text === 'string') parts.push(s.text); }
  };
  if (Array.isArray(body.messages)) for (const m of body.messages) push(m && m.content);
  if (Array.isArray(body.input))    for (const m of body.input)    push(typeof m === 'string' ? m : (m && m.content));
  if (typeof body.prompt === 'string') parts.push(body.prompt);
  if (typeof body.input === 'string')  parts.push(body.input);
  return parts.join('\n');
}
// 粗估输入 token：约 4 字符/token（零成本，足够做长上下文分流）
function estimateInputTokens(body) { return Math.ceil(extractText(body).length / 4); }

// 单条 when 求值。type: request_type|model|input_tokens|keyword|caller；op: is/not/in/gt/lt/gte/lte/match/contains
function evalWhen(when, ctx) {
  if (!when || !when.type) return false;
  const op = when.op || 'is', val = when.value;
  let cur;
  switch (when.type) {
    case 'request_type': cur = ctx.modality; break;
    case 'model':        cur = ctx.model; break;
    case 'input_tokens': cur = ctx.input_tokens; break;
    case 'keyword':      cur = ctx.text; break;
    case 'caller':       cur = ctx.caller; break;
    case 'classifier':   cur = ctx.classifier_label; break;   // 语义分类结果（懒计算，见 resolveSteps）
    default: return false;
  }
  switch (op) {
    case 'is':       return String(cur) === String(val);
    case 'not':      return String(cur) !== String(val);
    case 'in':       return Array.isArray(val) && val.map(String).includes(String(cur));
    case 'gt':       return Number(cur) >  Number(val);
    case 'lt':       return Number(cur) <  Number(val);
    case 'gte':      return Number(cur) >= Number(val);
    case 'lte':      return Number(cur) <= Number(val);
    case 'match':    try { return new RegExp(val, 'i').test(String(cur || '')); } catch { return false; }
    case 'contains': return String(cur || '').toLowerCase().includes(String(val).toLowerCase());
    default: return false;
  }
}
// 按规则选路由链（同步，不含分类器）：第一条命中的 rule.steps；都不中 → 默认 scene.steps。
function pickSteps(scene, ctx) {
  if (Array.isArray(scene && scene.rules)) {
    for (const rule of scene.rules) {
      if (rule && Array.isArray(rule.steps) && rule.steps.length && evalWhen(rule.when, ctx)) return rule.steps;
    }
  }
  return (scene && scene.steps) || [];
}

// ── 语义分类器（有成本条件：先用便宜模型把输入归类，再按 label 路由）──────────────
// 内部「调一次模型拿纯文本」，不写 res。支持 OpenAI / Anthropic 两种上游格式。
function internalComplete(provider, model, prompt, maxTokens = 8) {
  return new Promise((resolve, reject) => {
    const isAnthropic = /anthropic/i.test(provider.base_url || '') || provider.api_format === 'anthropic';
    const _ver = apiVer(provider.base_url);
    let u; try { u = new URL(normBase(provider.base_url) + (isAnthropic ? `/${_ver}/messages` : `/${_ver}/chat/completions`)); }
    catch { return reject(new Error('invalid_url')); }
    const body = isAnthropic
      ? { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }
      : { model, max_tokens: maxTokens, temperature: 0, stream: false, messages: [{ role: 'user', content: prompt }] };
    const bodyStr = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
    if (provider.token) {
      if (isAnthropic) { headers['x-api-key'] = provider.token; headers['anthropic-version'] = '2023-06-01'; }
      else headers['Authorization'] = `Bearer ${provider.token}`;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 15000 }, (rs) => {
      let data = '';
      rs.on('data', c => data += c);
      rs.on('end', () => {
        if (rs.statusCode >= 400) return reject(new Error('HTTP_' + rs.statusCode));
        try {
          const j = JSON.parse(data);
          const text = isAnthropic
            ? (Array.isArray(j.content) ? j.content.map(b => b.text || '').join('') : '')
            : (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          resolve(String(text || ''));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(bodyStr); req.end();
  });
}

const _classifyCache = new Map();   // key(model|cats|snippet) → { ts, label }；5min 缓存
async function classifyInput(text, classifier) {
  if (!classifier || !classifier.model || !Array.isArray(classifier.categories) || !classifier.categories.length) return null;
  const cats = classifier.categories.map(String);
  const snippet = String(text || '').slice(0, classifier.max_chars || 600);
  if (!snippet) return null;
  const key = classifier.model + '|' + cats.join(',') + '|' + snippet;
  const now = Date.now();
  const hit = _classifyCache.get(key);
  if (hit && now - hit.ts < 300000) return hit.label;
  const provider = enabledProviders().find(p => providerHasModel(p, classifier.model));
  if (!provider) return null;
  const prompt = `把下面这条用户请求归到这些类别之一，只回类别词本身，不要解释。\n类别: ${cats.join(', ')}\n\n请求:\n${snippet}`;
  let out;
  try { out = await internalComplete(provider, classifier.model, prompt, 8); } catch { return null; }
  const low = String(out || '').toLowerCase();
  const label = cats.find(c => low.includes(String(c).toLowerCase())) || null;
  _classifyCache.set(key, { ts: now, label });
  if (_classifyCache.size > 500) _classifyCache.delete(_classifyCache.keys().next().value);
  return label;
}

// 选路由链（异步）：含分类器规则时懒计算 label（每请求只分类一次）；第一条命中即用。
async function resolveSteps(scene, ctx) {
  if (Array.isArray(scene && scene.rules)) {
    let classified = false;
    for (const rule of scene.rules) {
      if (!rule || !Array.isArray(rule.steps) || !rule.steps.length || !rule.when) continue;
      if (rule.when.type === 'classifier' && !classified) {
        ctx.classifier_label = await classifyInput(ctx.text, scene.classifier);
        classified = true;
      }
      if (evalWhen(rule.when, ctx)) return rule.steps;
    }
  }
  return (scene && scene.steps) || [];
}

async function route(model, reqPath, body, res, callerKey, skipP2P = false) {
  const t0          = Date.now();
  let lastErr       = null;
  const isAnthropic = reqPath === '/v1/messages';
  const isResponses = reqPath === '/v1/responses' || reqPath === '/responses';
  const streaming   = !!body.stream;

  // 保留原始请求名 origModel。Claude 客户端模型名（claude-*）经 keyScene 透明改写成
  // 应用绑定的真实模型；claudeFrom 仅用于路由明细展示「claude名 → 真实」这层透明转化。
  const origModel = model;
  const claudeFrom = _claudeModels.includes(origModel) ? origModel : null;

  function fail(scene_name, failedModels) {
    debugLog(`<<< 路由失败 fail()`, {
      requested_model: origModel,
      scene_name,
      failedModels,
      lastErr: lastErr?.message,
      lastErr_stack: lastErr?.stack,
    });
    pushLog({
      ts: t0, requested_model: origModel, model, scene_name, claude_from: claudeFrom,
      tried: failedModels?.length ? [...failedModels] : undefined,
      via: null, latency_ms: Date.now() - t0, status: 'error', error: lastErr?.message,
    });
    recordError(model, callerKey, lastErr); // 失败也落账，保证不丢账
    if (!res.headersSent) {
      // Codex Responses 客户端只识别 Responses 风格错误体；其余路径维持原 Chat 风格。
      const detail = lastErr?.message || 'all_providers_failed';
      const payload = isResponses
        ? codexTransform.chatErrorToResponseError({ error: { message: detail, type: 'all_providers_failed' } })
        : { error: 'all_providers_failed', detail };
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }
  }

  // ── Scene route：应用绑定路由（keyScene）/ llm-router-* ──
  // Claude 应用绑 route_id 后，keyScene[key] 把 claude-* 请求透明改写成绑定的真实模型/路由链。
  const boundScene = (callerKey && _keyScene[callerKey]) || null;
  const isLlmRouter = origModel.startsWith('llm-router-');
  const interceptScene = !boundScene ? _routerModelMap[origModel] : null;
  debugLog(`route() 路由判定`, {
    requested_model: origModel,
    callerKey: callerKey?.slice(0, 20),
    has_boundScene: !!boundScene,
    boundScene_steps: boundScene?.steps,
    is_llm_router: isLlmRouter,
    has_intercept: !!interceptScene,
  });
  const hasScene = (s) => !!(s && (s.steps?.length || s.rules?.length));
  if (hasScene(boundScene) || isLlmRouter || hasScene(interceptScene)) {
    const scene = hasScene(boundScene) ? boundScene : (interceptScene || _routerModelMap[origModel]);
    if (!hasScene(scene)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'scene_not_found', model }));
      return;
    }

    // 按请求特征选本次路由链：命中的规则链 / 默认链（零成本条件，从路径+body 提取）
    const ruleCtx = {
      modality: modalityOf(reqPath), model: origModel,
      input_tokens: estimateInputTokens(body), text: extractText(body), caller: callerKey,
    };
    const steps = await resolveSteps(scene, ruleCtx);
    if (!steps.length) {   // 规则全不命中且无默认链
      lastErr = new Error(`no rule matched for ${ruleCtx.modality} request and route has no default chain`);
      fail(scene.scene_name, null);
      return;
    }

    const all          = enabledProviders().filter(p => !skipP2P || p.type !== 'p2p');
    const failedModels = [];
    const stepErrors   = [];

    for (const step of steps) {
      // 场景步骤就是真实模型；claudeFrom 标记原始 claude 名（路由明细展示透明转化）。
      const stepModel     = step.model;
      const stepClaudeFrom = claudeFrom;
      // Match providers by model list；step.tier 指定时只走对应供给层（同模型跨 P2P/付费）
      let stepCandidates = all.filter(p => providerHasModel(p, stepModel));
      if (step.tier) stepCandidates = stepCandidates.filter(p => p.type === step.tier);
      const stepProviders = [
        ...stepCandidates.filter(p => Array.isArray(p.models) && p.models.length > 0),
        ...stepCandidates.filter(p => !Array.isArray(p.models) || p.models.length === 0),
      ];
      let   stepSucceeded = false;

      for (const provider of stepProviders) {
        try {
          const result = await callProvider(provider, isAnthropic, streaming, reqPath, body, stepModel, res);
          pushLog({
            ts: t0, requested_model: origModel, model: stepModel,
            scene_name: scene.scene_name, claude_from: stepClaudeFrom,
            tried: failedModels.length ? [...failedModels] : undefined,
            tier: provider.type, via: provider.id, via_label: provider.label,
            latency_ms: result.latency, first_token_ms: result.first_token_ms, status: 'ok',
          });
          const stepTok  = (result.input_tokens || 0) + (result.output_tokens || 0);
          const stepTier = _providerTier(provider);
          recordStats(provider.id, stepModel, result, stepTier, callerKey, streaming, provider.billing_type || null);
          reportUsage(provider.id, stepModel, stepTok);
          stepSucceeded = true;
          return;
        } catch (err) {
          stepErrors.push({ id: provider.id, err });
          lastErr = err;
          if (res.headersSent) return;
        }
      }
      if (!stepSucceeded) failedModels.push(stepModel);
    }

    lastErr = pickBestRouteError(stepErrors) || lastErr;
    fail(scene.scene_name, failedModels);
    return;
  }

  // ── Direct model request ──────────────────────────────────────────────────
  const allEnabled = enabledProviders().filter(p => !skipP2P || p.type !== 'p2p');

  // ★ 三层特征提取 + 策略组调度：按 policy 决定 provider 优先顺序
  let sorted;
  try {
    const { providerIds, fallthrough, features, policyRef } =
      reqRouter.resolveProviderOrder(body, callerKey, reqPath, _getLocalConfig);

    if (!fallthrough && providerIds.length > 0) {
      // 策略组有明确 provider 列表：按策略顺序排，不在策略组里的 enabled providers 追加兜底
      const inPolicy = providerIds
        .map(id => allEnabled.find(p => p.id === id))
        .filter(Boolean);
      const others   = allEnabled.filter(p => !providerIds.includes(p.id) && providerHasModel(p, model));
      sorted = [...inPolicy, ...others];
      pushLog({ ts: t0, requested_model: model, model, policy: policyRef,
                features: { task_type: features.task_type, has_tools: features.has_tools,
                            context_length: features.context_length }, status: 'routing' });
    } else {
      // fallthrough：策略组为空或未匹配，用原有 model 匹配逻辑
      const candidates = allEnabled.filter(p => providerHasModel(p, model));
      sorted = [
        ...candidates.filter(p => Array.isArray(p.models) && p.models.length > 0),
        ...candidates.filter(p => !Array.isArray(p.models) || p.models.length === 0),
      ];
    }
  } catch {
    // 策略路由出错不影响正常请求，回退到原逻辑
    const candidates = allEnabled.filter(p => providerHasModel(p, model));
    sorted = [
      ...candidates.filter(p => Array.isArray(p.models) && p.models.length > 0),
      ...candidates.filter(p => !Array.isArray(p.models) || p.models.length === 0),
    ];
  }

  debugLog(`直接模型路由候选 providers`, {
    requested_model: model,
    candidate_count: sorted.length,
    candidates: sorted.map(p => ({ id: p.id, type: p.type, models: p.models })),
  });

  const routeErrors = [];
  for (const provider of sorted) {
    try {
      const result = await callProvider(provider, isAnthropic, streaming, reqPath, body, model, res);
      // 记录延迟（供 latency 策略下次参考）
      if (result.latency) reqRouter.recordLatency(provider.id, result.latency);
      pushLog({
        ts: t0, requested_model: origModel, model, claude_from: claudeFrom,
        tier: provider.type, via: provider.id, via_label: provider.label,
        latency_ms: result.latency, first_token_ms: result.first_token_ms, status: 'ok',
      });
      const directTok  = (result.input_tokens || 0) + (result.output_tokens || 0);
      const directTier = _providerTier(provider);
      recordStats(provider.id, model, result, directTier, callerKey, streaming, provider.billing_type || null);
      reportUsage(provider.id, model, directTok);
      return;
    } catch (err) {
      routeErrors.push({ id: provider.id, err });
      lastErr = err;
      if (res.headersSent) return;
    }
  }

  lastErr = pickBestRouteError(routeErrors) || lastErr;
  fail(null, null);
}

function pushLog(entry) {
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
  _saveRouteLog();
}

// 把单次请求的真实用量（含输入/输出/缓存命中/缓存写入）推给 recorder（local-stats）。
// 兼容旧字段：tokens = input + output。
// request_id = 上游响应 id（msg_/chatcmpl_），用于与会话文件导入跨来源去重；
// data_source='proxy' 标记这是网关实时拦截记录；并补全延迟/首字/状态码/是否流式。
// 合成唯一 request_id：上游未返回 id（多为 401/502/404 等错误响应）时兜底，杜绝 NULL。
// 唯一 → 每条独立记录、不会误去重；成功响应仍优先用真实上游 msg_id（保证跨源去重）。
function synthReqId() { return 'gw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

function recordStats(providerId, model, usage, tier, apiKey, streaming, billingType) {
  const inTok   = usage?.input_tokens        || 0;
  const outTok  = usage?.output_tokens       || 0;
  const cCreate = usage?.cache_create_tokens || 0;
  const cRead   = usage?.cache_read_tokens   || 0;
  _statsRecorder?.({
    api_key:     apiKey     || null,
    app_id:      appIdForKey(apiKey),
    model:       model      || null,
    provider_id: providerId || null,
    tier:        tier       || null,
    tokens:               inTok + outTok,
    input_tokens:         inTok,
    output_tokens:        outTok,
    cache_create_tokens:  cCreate,
    cache_read_tokens:    cRead,
    request_id:           usage?.message_id || synthReqId(),   // 强制非空：有真实上游 msg_id 用之(跨源去重)，否则合成唯一 id
    data_source:          'proxy',
    status_code:          (usage?.status_code != null) ? usage.status_code : 200,
    is_streaming:         !!streaming,
    latency_ms:           (usage?.latency        != null) ? usage.latency        : null,
    first_token_ms:       (usage?.first_token_ms != null) ? usage.first_token_ms : null,
    cost_usd:             estimateCost(model, inTok, outTok, cCreate, cRead, providerId),
    billing_type:         billingType || null,
  });
}

// 失败也落账：所有 provider 都失败时记一条 0-token 的错误行（不丢账）。
// request_id 用合成唯一 id（强制非空）→ 每次失败独立记录、不会误去重。
function recordError(model, apiKey, err) {
  _statsRecorder?.({
    api_key:     apiKey || null,
    app_id:      appIdForKey(apiKey),
    model:       model  || null,
    provider_id: null,
    tier:        null,
    tokens: 0, input_tokens: 0, output_tokens: 0,
    request_id:  synthReqId(),
    data_source: 'proxy',
    status_code: err?.status || 502,
    error:       err?.message || 'all_providers_failed',
  });
}

// Determine routing tier from provider object or id string.
// Priority: explicit config tier > known P2P id > has token + non-local URL = paid > free
const _LOCAL_URL = /localhost|127\.0\.0\.1|::1|192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./;

function _providerTier(provider) {
  if (!provider) return 'free';
  const id   = typeof provider === 'string' ? provider : (provider.id || '');
  const obj  = typeof provider === 'object' ? provider : null;
  // Explicit tier in provider config
  if (obj?.tier) return obj.tier;
  // P2P
  if (id === 'tokenbank-p2p' || obj?.type === 'p2p') return 'p2p';
  // Known paid IDs (fallback for old persisted stats that only store id)
  const KNOWN_PAID = new Set(['openai','anthropic-paid','anthropic','openrouter','deepseek','xai','fireworks']);
  if (KNOWN_PAID.has(id)) return 'paid';
  // Has API token + non-local base URL → paid
  if (obj?.token && obj?.base_url && !_LOCAL_URL.test(obj.base_url)) return 'paid';
  return 'free';
}

// Fire-and-forget: report a completed non-P2P call to the backend so it appears
// in dashboard stats. P2P calls are already recorded server-side.
function reportUsage(providerId, model, totalTokens) {
  if (!_backendUrl || !_cloudToken) return;
  const tier = _providerTier(providerId);
  if (tier === 'p2p') return; // already recorded by backend
  const body = JSON.stringify({ model, tokens: totalTokens, tier, provider_id: providerId });
  try {
    const u   = new URL(_backendUrl + '/api/gateway/record-usage');
    const mod = u.protocol === 'https:' ? require('https') : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${_cloudToken}`,
      },
      timeout: 10_000,
    }, res => { res.resume(); }); // drain response
    req.on('error', () => {}); // ignore errors — best-effort
    req.write(body);
    req.end();
  } catch {}
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, anthropic-version');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { method, url } = req;
  // 归一化路径：去查询串、折叠多斜杠、去尾斜杠。
  // 容忍客户端用尾斜杠 baseURL（如 http://host:11430/）拼出的 //v1/models、带 ?查询、/v1/models/ 等变体。
  const cleanPath = (url.split('?')[0] || '/').replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  console.log('[gw-req]', method, url, 'auth=' + (req.headers['authorization'] ? req.headers['authorization'].slice(0,25) : (req.headers['x-api-key'] ? 'x-api-key:'+String(req.headers['x-api-key']).slice(0,18) : 'none')));

  // Health
  if (method === 'GET' && cleanPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: _port }));
    return;
  }

  // Models list：返回全部可用模型 + Claude 客户端模型名。
  //   Claude 模型名（claude-*）让 Claude Desktop 通过「必须 Anthropic 模型」校验、有名字可选；
  //   真实模型（在线 P2P + 各 provider）供其他客户端直接选用。
  //   Claude 发的 claude-* 请求由 keyScene（应用绑定的路由）透明改写成真实模型。
  if (method === 'GET' && (cleanPath === '/v1/models' || cleanPath === '/models')) {
    const seen = new Set();
    const data = [];
    const add = (id, owned) => {
      if (id && !seen.has(id)) { seen.add(id); data.push({ id, object: 'model', created: 0, owned_by: owned || 'tokenbank' }); }
    };
    // Claude 客户端模型名（透明逻辑）
    for (const id of _claudeModels) add(id, 'anthropic');
    // 真实模型：在线 P2P + 各 provider
    for (const id of _peerModels) add(id, 'p2p');
    try {
      for (const p of enabledProviders()) {
        for (const m of (p.models || [])) add(typeof m === 'string' ? m : m.name, p.id);
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
    return;
  }

  // Local stats query — used by CLI/browser frontend
  if (method === 'GET' && url.startsWith('/api/local-stats')) {
    const qs   = new URL('http://x' + url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 1));
    const data = _localStats ? _localStats.queryDashboard(days) : {
      total_calls: 0, total_tokens: 0, total_cost: 0,
      tiers: { free: 0, p2p: 0, paid: 0 },
      hourly: Array(24).fill(0),
      models: [], keys: [], providers: [], agent_sources: [],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // 压缩比统计（盘点页用）
  if (method === 'GET' && url.startsWith('/api/compression-stats')) {
    const qs   = new URL('http://x' + url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 1));
    let summary = { count: 0, before: 0, after: 0, saved: 0, ratio: 0, models: [] };
    try { summary = require('./compression-report').readCompressionSummary(days); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    return;
  }

  // Gateway status for CLI frontend
  if (method === 'GET' && cleanPath === '/api/gateway/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
    return;
  }

  // Chat completions (OpenAI + Anthropic) + Codex Responses
  const isChatPath   = cleanPath === '/v1/chat/completions' || cleanPath === '/v1/messages'
                    || cleanPath === '/v1/responses' || cleanPath === '/responses';
  if (!isChatPath || method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  req.on('error', (err) => {
    console.error('[gateway] request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'request_error' }));
    }
  });

  // Extract caller's API key (used to attribute stats to the right scene/key)
  const authRaw = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const callerKey = authRaw.startsWith('Bearer ') ? authRaw.slice(7).trim() : authRaw.trim();

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString();
    let body = {};
    try { body = JSON.parse(rawBody); } catch {}
    const model = body.model || '';

    // 调试：记录入站请求关键信息（不 dump 完整 body，避免日志膨胀）
    debugLog(`>>> 入站请求 ${method} ${url}`, {
      model,
      auth: callerKey.slice(0, 20),
      stream: !!body.stream,
      user_agent: req.headers['user-agent'],
    });

    // ── 应用匹配（api-key 按 key、shim 按路径，用于统计归因）────────────────
    const ctrl = resolveAppControl(callerKey, cleanPath);
    debugLog(`匹配的 app control`, ctrl ? { app_name: ctrl.app_name, has_match_key: !!ctrl.match?.key } : 'null（未匹配任何应用，按默认策略路由）');

    // ── 压缩 stage（默认关闭，opt-in）──────────────────────────────────────
    // 转发前对 chat 请求做无损 JSON 压缩，减少发给上游的输入 token。
    // 开关：cfg.compress.enabled 或环境变量 TOKENBANK_COMPRESS=1。
    if (modalityOf(cleanPath) === 'chat') {
      let compCfg = {};
      try { compCfg = _getConfig?.()?.compress || {}; } catch {}
      const enabled = process.env.TOKENBANK_COMPRESS === '1' || !!compCfg.enabled;
      if (enabled) {
        try {
          const r = compressBody(body, { enabled: true });
          if (r.saved > 0) {
            body = r.body;
            const rec = _recordCompression(model, r.before, r.after);
            debugLog('压缩 stage（无损）', { ...rec, 累计: compressionStats() });
          }
        } catch (e) { debugLog('压缩 stage 失败（跳过）', e.message); }
      }
    }

    const skipP2P = !!req.headers['x-p2p-hop'];
    try {
      await route(model, cleanPath, body, res, callerKey, skipP2P);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(port, getConfig, saveConfig, bindHost = '127.0.0.1') {
  if (_server) return;
  _port       = port || 11430;
  _getConfig  = getConfig;
  _saveConfig = saveConfig || null;
  _server     = http.createServer(handleRequest);
  _server.listen(_port, bindHost, () => {
    console.log(`[gateway] listening on ${bindHost}:${_port}`);
  });
  _server.on('error', (err) => {
    console.error('[gateway] server error:', err.message);
  });
}

function stop() {
  if (!_server) return;
  const s = _server;
  _server = null;
  s.close(() => {
    console.log('[gateway] stopped');
  });
}

function restart() {
  return new Promise((resolve) => {
    const port = _port;
    const getConfig = _getConfig;
    if (_server) {
      const s = _server;
      _server = null;
      s.close(() => {
        console.log('[gateway] restarting...');
        start(port, getConfig);
        resolve({ ok: true });
      });
    } else {
      start(port, getConfig);
      resolve({ ok: true });
    }
  });
}

function setStrategy() { /* deprecated */ }

function getStatus() {
  return { running: !!_server, port: _port, peerModels: [..._peerModels] };
}

function getLog() {
  return [...log].reverse(); // newest first
}

// api-key 应用的 route_id → 路由覆盖：callerKey → { steps, scene_name }
let _keyScene = {};
function setKeySceneMap(map) { _keyScene = map && typeof map === 'object' ? map : {}; }

// Claude 客户端模型名（内部透明逻辑）：仅用于 /v1/models 暴露给 Claude + 标记 Claude 请求。
// 真实使用的模型来自「应用绑定的 route_id」（keyScene 透明改写），这里不做映射。
let _claudeModels = [];
function setClaudeModels(list) { _claudeModels = Array.isArray(list) ? list.filter(x => typeof x === 'string') : []; }

// ── 应用匹配（api-key 按 key 匹配，shim 按协议路径匹配）─────────────────────
// 每项：{ app_id, app_name, match:{key|path} }
let _appControls = [];

function setAppControls(list) {
  _appControls = Array.isArray(list) ? list : [];
}

function resolveAppControl(callerKey, reqPath) {
  if (callerKey) {
    const byKey = _appControls.find(c => c.match && c.match.key && c.match.key === callerKey);
    if (byKey) return byKey;
  }
  return _appControls.find(c => c.match && c.match.path && reqPath.startsWith(c.match.path)) || null;
}

// 按 caller key 反查应用 id（api-key 应用按 key 匹配）→ 统计按稳定的 app_id 记账，
// 不受 api_key 变化/取消重新纳管影响（与 shim 用 data_source 同理）。
function appIdForKey(callerKey) {
  if (!callerKey) return null;
  const c = _appControls.find(c => c.match && c.match.key && c.match.key === callerKey);
  return c?.app_id || null;
}

function setRouterModelMap(map) {
  _routerModelMap = map && typeof map === 'object' ? map : {};
}

function setPeerModels(list) {
  _peerModels = Array.isArray(list) ? new Set(list) : new Set();
  console.log(`[gateway] P2P models updated: ${_peerModels.size} models`);
}

function setBackendConfig({ url, token } = {}) {
  _backendUrl  = url   || null;
  _cloudToken  = token || null;
  console.log(`[gateway] backend config: url=${_backendUrl} token=${_cloudToken ? '***' : 'none'}`);
}

function setStatsRecorder(fn) {
  _statsRecorder = typeof fn === 'function' ? fn : null;
}

function setLocalStats(mod) {
  _localStats = mod && typeof mod.queryDashboard === 'function' ? mod : null;
}

// 注入 local-config 读取器（供策略组调度查 policies[]）
function setLocalConfigReader(fn) {
  _getLocalConfig = typeof fn === 'function' ? fn : null;
}

module.exports = {
  start, stop, restart, setStrategy, getStatus, getLog,
  setKeySceneMap, setRouterModelMap, setPeerModels, setBackendConfig,
  setStatsRecorder, setLocalStats, setLocalConfigReader, setAppControls,
  setClaudeModels,
  // 条件路由规则引擎（供单测/复用）
  pickSteps, evalWhen, modalityOf, estimateInputTokens, extractText,
};
