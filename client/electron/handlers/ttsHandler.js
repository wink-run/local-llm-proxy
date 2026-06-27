// handlers/ttsHandler.js
// TTS modality handler — per-provider adapter pattern (mirrors 9router ttsCore + genericFormats).
//
// Provider lookup: model field uses "providerId/voice-model" format (e.g. "openai/tts-1").
// Adapters are looked up first by provider.id, then by provider.tts_config.format.
// All adapters return { base64: string, format: string } or throw.
'use strict';

const https = require('https');
const http  = require('http');

// ── Helpers ──────────────────────────────────────────────────────────────────

function responseToBase64(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const buf  = Buffer.concat(chunks);
      if (buf.length < 100) return reject(new Error('Upstream returned empty audio'));
      const ct   = res.headers['content-type'] || '';
      const fmt  = ct.includes('wav') ? 'wav' : ct.includes('ogg') ? 'ogg' : 'mp3';
      resolve({ base64: buf.toString('base64'), format: fmt });
    });
    res.on('error', reject);
  });
}

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const mod  = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req  = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 60_000,
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TTS request timed out')); });
    req.write(data);
    req.end();
  });
}

// ── Format handlers (config-driven, same as 9router genericFormats) ──────────
// Each receives { baseUrl, apiKey, text, modelId, voiceId } → { base64, format }

const FORMAT_HANDLERS = {
  // OpenAI /v1/audio/speech
  openai: async ({ baseUrl, apiKey, text, modelId, voiceId }) => {
    const url = baseUrl || 'https://api.openai.com/v1/audio/speech';
    const res = await postJson(url,
      { Authorization: `Bearer ${apiKey}` },
      { model: modelId || 'tts-1', input: text, voice: voiceId || 'alloy', response_format: 'mp3', speed: 1.0 },
    );
    if (res.statusCode >= 400) {
      const body = await new Promise(r => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>r(d)); });
      throw new Error(`OpenAI TTS ${res.statusCode}: ${body}`);
    }
    return responseToBase64(res);
  },
};

// ── Provider lookup ───────────────────────────────────────────────────────────
// Parses "providerId/voice" or "providerId" from model string.
// Falls back to matching by tts_config presence if no slash prefix.
function resolveProvider(modelStr, providers) {
  if (!modelStr) return null;
  const slash = modelStr.indexOf('/');
  if (slash > 0) {
    const pid = modelStr.slice(0, slash);
    const p   = providers.find(p => p.id === pid || p.id?.startsWith(pid));
    return p ? { provider: p, modelId: modelStr.slice(slash + 1), voiceId: '' } : null;
  }
  // No prefix: try any provider that declares tts support
  const p = providers.find(p => p.tts_config || FORMAT_HANDLERS[p.id]);
  return p ? { provider: p, modelId: modelStr, voiceId: '' } : null;
}

// ── Core synthesize ───────────────────────────────────────────────────────────
async function synthesize(provider, modelId, voiceId, text) {
  const apiKey = provider.token;
  const baseUrl = provider.base_url || '';

  // tts_config.format → FORMAT_HANDLERS dispatch (config-driven)
  const cfg    = provider.tts_config || {};
  const format = cfg.format || provider.id;  // fall back to id (e.g. "openai")
  const handler = FORMAT_HANDLERS[format];
  if (!handler) throw new Error(`No TTS handler for provider "${provider.id}" (format: "${format}")`);

  return handler({
    baseUrl: cfg.baseUrl || baseUrl,
    apiKey,
    text,
    modelId: modelId || cfg.defaultModel || '',
    voiceId,
  });
}

// ── Public handler ────────────────────────────────────────────────────────────
/**
 * @param {object} body  - Parsed request body { model, input, voice, response_format, speed }
 * @param {object} res   - Node HTTP ServerResponse
 * @param {function} getProviders - Returns array of enabled providers
 */
async function handleTts(body, res, getProviders) {
  const text = (body.input || '').trim();
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required field: input' }));
    return;
  }

  const modelStr  = body.model || '';
  const providers = getProviders();
  const resolved  = resolveProvider(modelStr, providers);

  if (!resolved) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No TTS provider found for model "${modelStr}". Configure a provider with tts_config or use "providerId/model" format.` }));
    return;
  }

  const { provider, modelId, voiceId } = resolved;
  const voice = body.voice || voiceId || '';

  try {
    const { base64, format } = await synthesize(provider, modelId, voice, text);
    const buf = Buffer.from(base64, 'base64');
    const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', opus: 'audio/opus' };
    const mime    = mimeMap[format] || 'audio/mpeg';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': String(buf.length),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } catch (err) {
    console.error('[tts] error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'TTS synthesis failed' }));
    }
  }
}

module.exports = { handleTts };
