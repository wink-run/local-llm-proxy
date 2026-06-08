// client/electron/local-gateway.js
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const codexTransform = require('./codex-transform');
const reqRouter = require('./request-router');

// ── In-memory state ───────────────────────────────────────────────────────────

const LOG_MAX = 100;
const log = []; // circular, newest last

// 调试日志：把完整请求/响应写到文件，便于排查 Claude Desktop 等客户端实际发了什么
const DEBUG_LOG_FILE = path.join(os.homedir(), 'tokenbank-gateway-debug.log');
function debugLog(label, data) {
  try {
    const line = `\n[${new Date().toISOString()}] ${label}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`;
    fs.appendFileSync(DEBUG_LOG_FILE, line);
  } catch {}
}

let _getConfig   = null;     // () => config object (set at start)
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

// 归一 base_url：去掉尾部斜杠 + 尾部 /v1。
// 网关转发时统一用 base + '/v1/chat/completions'（或 '/v1/messages'），
// 所以无论用户填的 base 带不带 /v1 都能拼对（避免 /v1/v1 双段）。
function normBase(url) {
  return (url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
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
  if (!Array.isArray(list) || list.length === 0) return true; // no list = serves any
  // models may be strings or {name, type} objects
  return list.some(m => (typeof m === 'string' ? m : m.name) === model);
}

// ── HTTP proxy ────────────────────────────────────────────────────────────────

function proxyRequest(provider, reqPath, body, res) {
  return new Promise((resolve, reject) => {
    const base     = normBase(provider.base_url);
    const fullUrl  = base + reqPath;
    let u;
    try { u = new URL(fullUrl); }
    catch { return reject(new Error('invalid_url')); }

    const mod      = u.protocol === 'https:' ? https : http;
    // 只对 OAI 路径注入 stream_options（Anthropic /v1/messages 不识别）
    const sendBody = /\/chat\/completions$/.test(reqPath) ? withUsageOption(body) : body;
    const bodyStr  = JSON.stringify(sendBody);
    const headers  = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider.token) {
      if (/anthropic/i.test(provider.base_url || '') || provider.api_format === 'anthropic') {
        headers['x-api-key'] = provider.token;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${provider.token}`;
      }
    }

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
        proxyRes.resume();
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
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
    const fullUrl = base + '/v1/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

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
    const fullUrl = base + '/v1/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(withUsageOption(oaiBody));
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

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
    const anthBody  = oaiRequestToAnthropic({ ...oaiBody, stream: false });
    const base      = normBase(provider.base_url);
    const fullUrl   = base + '/v1/messages';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(anthBody);
    const headers = {
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(bodyStr),
      'anthropic-version': '2023-06-01',
    };
    if (provider.token) headers['x-api-key'] = provider.token;

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
    const anthBody  = oaiRequestToAnthropic({ ...oaiBody, stream: true });
    const base      = normBase(provider.base_url);
    const fullUrl   = base + '/v1/messages';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(anthBody);
    const headers = {
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(bodyStr),
      'anthropic-version': '2023-06-01',
      'Accept':            'text/event-stream',
    };
    if (provider.token) headers['x-api-key'] = provider.token;

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

// ── P2P: always stream from backend, buffer to sync response for non-streaming clients ──

function proxyP2PSync(provider, oaiBody, model, res) {
  // Sends stream:true to backend regardless of client request; assembles & returns Anthropic JSON
  return new Promise((resolve, reject) => {
    const streamBody = withUsageOption({ ...oaiBody, stream: true });
    const base    = normBase(provider.base_url);
    const fullUrl = base + '/v1/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(streamBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

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
    const fullUrl = base + '/v1/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(chatBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const t0 = Date.now();
    let firstTokenMs = null;
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        proxyRes.resume();
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
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

// ── Route ─────────────────────────────────────────────────────────────────────

// Call one provider with format conversion; throws on HTTP error.
// provider is already resolved (base_url/token correct, models populated).
async function callProvider(provider, isAnthropic, streaming, reqPath, body, attemptModel, res) {
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

  // Codex Responses 请求：统一走 Responses⇄Chat 转换（上游按 Chat Completions 处理）
  if (reqPath === '/v1/responses' || reqPath === '/responses') {
    return await proxyResponsesViaChat(provider, { ...body, model: attemptModel }, attemptModel, res);
  }
  const attemptBody = { ...body, model: attemptModel };

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

async function route(model, reqPath, body, res, callerKey) {
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
  // Claude 应用绑 route_id 后，keyScene[key] 把 claude-* 请求透明改写成绑定的真实模型/降级链。
  const boundScene = (callerKey && _keyScene[callerKey]) || null;
  const isLlmRouter = origModel.startsWith('llm-router-');
  debugLog(`route() 路由判定`, {
    requested_model: origModel,
    callerKey: callerKey?.slice(0, 20),
    has_boundScene: !!boundScene,
    boundScene_steps: boundScene?.steps,
    is_llm_router: isLlmRouter,
  });
  if (boundScene?.steps?.length || isLlmRouter) {
    const scene = boundScene?.steps?.length ? boundScene : _routerModelMap[origModel];
    if (!scene?.steps?.length) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'scene_not_found', model }));
      return;
    }

    const all          = enabledProviders();
    const failedModels = [];

    for (const step of scene.steps) {
      // 场景步骤就是真实模型；claudeFrom 标记原始 claude 名（路由明细展示透明转化）。
      const stepModel     = step.model;
      const stepClaudeFrom = claudeFrom;
      // Match providers by model list, not by tier — tier is informational only
      const stepCandidates = all.filter(p => providerHasModel(p, stepModel));
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
          recordStats(provider.id, stepModel, result, stepTier, callerKey, streaming);
          reportUsage(provider.id, stepModel, stepTok);
          stepSucceeded = true;
          return;
        } catch (err) {
          lastErr = err;
          if (res.headersSent) return;
        }
      }
      if (!stepSucceeded) failedModels.push(stepModel);
    }

    fail(scene.scene_name, failedModels);
    return;
  }

  // ── Direct model request ──────────────────────────────────────────────────
  const allEnabled = enabledProviders();

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
      recordStats(provider.id, model, result, directTier, callerKey, streaming);
      reportUsage(provider.id, model, directTok);
      return;
    } catch (err) {
      lastErr = err;
      if (res.headersSent) return;
    }
  }

  fail(null, null);
}

function pushLog(entry) {
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
}

// 把单次请求的真实用量（含输入/输出/缓存命中/缓存写入）推给 recorder（local-stats）。
// 兼容旧字段：tokens = input + output。
// request_id = 上游响应 id（msg_/chatcmpl_），用于与会话文件导入跨来源去重；
// data_source='proxy' 标记这是网关实时拦截记录；并补全延迟/首字/状态码/是否流式。
function recordStats(providerId, model, usage, tier, apiKey, streaming) {
  const inTok   = usage?.input_tokens        || 0;
  const outTok  = usage?.output_tokens       || 0;
  const cCreate = usage?.cache_create_tokens || 0;
  const cRead   = usage?.cache_read_tokens   || 0;
  _statsRecorder?.({
    api_key:     apiKey     || null,
    model:       model      || null,
    provider_id: providerId || null,
    tier:        tier       || null,
    tokens:               inTok + outTok,
    input_tokens:         inTok,
    output_tokens:        outTok,
    cache_create_tokens:  cCreate,
    cache_read_tokens:    cRead,
    request_id:           usage?.message_id || null,
    data_source:          'proxy',
    status_code:          (usage?.status_code != null) ? usage.status_code : 200,
    is_streaming:         !!streaming,
    latency_ms:           (usage?.latency        != null) ? usage.latency        : null,
    first_token_ms:       (usage?.first_token_ms != null) ? usage.first_token_ms : null,
  });
}

// 失败也落账：所有 provider 都失败时记一条 0-token 的错误行（不丢账）。
// request_id 留空 → 不参与去重、每次失败都独立记录。
function recordError(model, apiKey, err) {
  _statsRecorder?.({
    api_key:     apiKey || null,
    model:       model  || null,
    provider_id: null,
    tier:        null,
    tokens: 0, input_tokens: 0, output_tokens: 0,
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
      total_calls: 0, total_tokens: 0,
      tiers: { free: 0, p2p: 0, paid: 0 },
      hourly: Array(24).fill(0),
      models: [], keys: [], providers: [],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
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

    // ── 请求控制（按 app 配置强制执行）──────────────────────────────────────
    const ctrl = resolveAppControl(callerKey, cleanPath);
    debugLog(`匹配的 app control`, ctrl ? { app_name: ctrl.app_name, has_match_key: !!ctrl.match?.key } : 'null（未匹配任何应用，按默认策略路由）');
    let release = () => {};
    if (ctrl) {
      // 1) 允许模型白名单
      if (Array.isArray(ctrl.allowed_models) && ctrl.allowed_models.length
          && model && !ctrl.allowed_models.includes(model)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'model_not_allowed', detail: `模型 ${model} 不在「${ctrl.app_name}」的允许列表内`, allowed: ctrl.allowed_models }));
        return;
      }
      // 3) 是否允许流式
      if (ctrl.allow_stream === false && body.stream) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'stream_not_allowed', detail: `「${ctrl.app_name}」已禁用流式输出` }));
        return;
      }
      // 4) 限流（RPM / 并发）
      const rl = rateLimitAcquire(ctrl);
      if (!rl.ok) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate_limited', detail: rl.reason === 'rpm'
          ? `「${ctrl.app_name}」超过每分钟请求上限 (${ctrl.max_rpm})`
          : `「${ctrl.app_name}」超过并发上限 (${ctrl.max_concurrent})` }));
        return;
      }
      release = rl.release;
      res.on('finish', release);
      res.on('close', release);
    }

    try {
      await route(model, cleanPath, body, res, callerKey);
    } catch (err) {
      release();
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(port, getConfig) {
  if (_server) return;
  _port      = port || 11430;
  _getConfig = getConfig;
  _server    = http.createServer(handleRequest);
  _server.listen(_port, '127.0.0.1', () => {
    console.log(`[gateway] listening on 127.0.0.1:${_port}`);
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

// ── 应用请求控制（api-key 按 key 匹配，shim 按协议路径匹配）─────────────────────
// 每项：{ app_id, app_name, match:{key|path}, allow_stream, allowed_models[],
//         max_rpm, max_concurrent }
let _appControls = [];
const _rlState   = new Map();   // app_id → { ts: number[], active: number }

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

// 限流检查：返回 { ok } 或 { ok:false, reason }；ok 时返回 release() 释放并发计数
function rateLimitAcquire(ctrl) {
  if (!ctrl.max_rpm && !ctrl.max_concurrent) return { ok: true, release: () => {} };
  const st = _rlState.get(ctrl.app_id) || { ts: [], active: 0 };
  const now = Date.now();
  if (ctrl.max_rpm) {
    st.ts = st.ts.filter(t => now - t < 60000);
    if (st.ts.length >= ctrl.max_rpm) { _rlState.set(ctrl.app_id, st); return { ok: false, reason: 'rpm' }; }
  }
  if (ctrl.max_concurrent && st.active >= ctrl.max_concurrent) {
    _rlState.set(ctrl.app_id, st); return { ok: false, reason: 'concurrent' };
  }
  st.ts.push(now); st.active += 1;
  _rlState.set(ctrl.app_id, st);
  let released = false;
  return { ok: true, release: () => {
    if (released) return; released = true;
    const s = _rlState.get(ctrl.app_id);
    if (s) s.active = Math.max(0, s.active - 1);
  } };
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
};
