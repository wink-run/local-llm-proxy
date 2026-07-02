// handlers/imageHandler.js
// Image generation modality handler — OpenAI-compatible base + per-provider body/url
// configs (mirrors 9router PROVIDER_MEDIA.imageConfig).
//
// Provider lookup: model field uses "providerId/model-name" format (e.g. "agnes-ai/agnes-image-2.0-flash").
// OpenAI-compatible providers only need URL/body tweaks → BODY_CONFIGS. All normalize to
// OpenAI shape: { created, data: [{ url?, b64_json? }] }.
'use strict';

const https = require('https');
const http  = require('http');
const { TIER_ROUTE_RE } = require('../../shared/route-binding');

// ── Helpers ──────────────────────────────────────────────────────────────────

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const mod  = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req  = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 120_000,
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Image request timed out')); });
    req.write(data);
    req.end();
  });
}

async function readJson(res) {
  return new Promise((resolve, reject) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    res.on('error', reject);
  });
}

// ── Base adapter ──────────────────────────────────────────────────────────────
// OpenAI-compatible base. Per-provider URL/body overrides live in BODY_CONFIGS.
// Interface: { buildUrl, buildHeaders, buildBody, normalize }

const ADAPTERS = {
  // OpenAI DALL-E — direct POST, returns OpenAI shape already
  openai: {
    buildUrl: (model, provider) => `${provider.base_url || 'https://api.openai.com'}/v1/images/generations`,
    buildHeaders: (provider) => ({ Authorization: `Bearer ${provider.token}` }),
    buildBody: (model, body) => ({
      model,
      prompt: body.prompt,
      n: body.n || 1,
      size: body.size || '1024x1024',
      ...(body.quality  ? { quality: body.quality }   : {}),
      ...(body.style    ? { style: body.style }        : {}),
      ...(body.response_format ? { response_format: body.response_format } : {}),
    }),
    normalize: (parsed) => parsed,
  },
};

// Parse "WxH" → { width, height }, enforcing a minimum pixel floor.
// Doubao SeedDream requires ≥ 3686400 px (≈ 1920×1920).
function sizeToWH(sizeStr, minPx = 0) {
  const [w, h] = (sizeStr || '').split('x').map(Number);
  if (!w || !h) return null;
  if (minPx && w * h < minPx) {
    // Scale up uniformly to meet the minimum
    const scale = Math.ceil(Math.sqrt(minPx / (w * h)) * 10) / 10;
    return { width: Math.ceil(w * scale), height: Math.ceil(h * scale) };
  }
  return { width: w, height: h };
}

// ── Provider-specific body configs (mirrors 9router PROVIDER_MEDIA.imageConfig) ──
// OpenAI-compatible providers that only need URL/body tweaks live here instead of a
// full ADAPTERS entry (reserved for providers needing a custom request cycle).
// Each entry overrides only the fields that differ.
//   { match, buildUrl?, buildBody? }
//   match(provider) → bool              identify the provider by base_url / id
//   buildUrl?(model, provider)          override the {base_url}/images/generations default
//   buildBody?(model, body)             override the OpenAI request body
const BODY_CONFIGS = [
  {
    // Doubao / Ark — SeedDream models: width+height instead of size, min 3686400 px
    match: (provider) => /volces\.com|ark\.cn|doubao/i.test(provider.base_url || '') || /seedream|seedance/i.test(provider.id || ''),
    buildBody: (model, body) => {
      const wh = sizeToWH(body.size || '1920x1920', 3_686_400);
      return {
        model,
        prompt: body.prompt,
        n: body.n || 1,
        ...(wh || { width: 1920, height: 1920 }),
        ...(body.response_format ? { response_format: body.response_format } : {}),
      };
    },
  },
  {
    // Agnes AI (agnes-image-2.0-flash) — OpenAI Images compatible, with quirks:
    //  · base_url may omit /v1 (endpoint is /v1/images/generations) → normalize
    //  · response_format MUST live inside extra_body (top-level → HTTP 400)
    //  · img2img uses a top-level `image` array (url or data-uri base64); no `tags`
    //  · return_base64:true for base64 output
    match: (provider) => /apihub\.agnes-ai\.com/i.test(provider.base_url || '') || /agnes/i.test(provider.id || ''),
    buildUrl: (_model, p) => {
      let base = (p.base_url || 'https://apihub.agnes-ai.com').replace(/\/+$/, '');
      if (!/\/v\d+$/.test(base)) base += '/v1';
      return `${base}/images/generations`;
    },
    buildBody: (model, body) => {
      const out = { model, prompt: body.prompt, size: body.size || '1024x1024' };
      if (body.n && body.n > 1) out.n = body.n;
      if (Array.isArray(body.image) && body.image.length) out.image = body.image;
      // response_format must never be top-level (causes 400); route through extra_body,
      // or use return_base64 for base64 output.
      if (body.return_base64) out.return_base64 = true;
      else out.extra_body = { response_format: body.response_format || 'url' };
      return out;
    },
  },
];

// ── Provider lookup ───────────────────────────────────────────────────────────
function modelEntryName(m) {
  if (typeof m === 'string') return m;
  return m?.name || m?.id || '';
}

function modelEntryType(m) {
  if (typeof m === 'string') return 'chat';
  return m?.type || m?.modality || 'chat';
}

function hasImageModel(provider, modelStr) {
  return (provider.models || []).some(m =>
    modelEntryType(m) === 'image' && modelEntryName(m) === modelStr
  );
}

function isAgnesImageModel(modelStr) {
  return /agnes[-_]image|^agnes-image/i.test(modelStr || '');
}

function isAgnesProvider(p) {
  return /agnes/i.test(p.id || '')
    || p.handler === 'agnes-image'
    || /apihub\.agnes-ai\.com/i.test(p.base_url || '');
}

function resolveProvider(modelStr, providers) {
  if (!modelStr) return null;
  const slash = modelStr.indexOf('/');
  if (slash > 0) {
    const pid = modelStr.slice(0, slash);
    const p   = providers.find(p => p.id === pid || p.id?.startsWith(pid));
    return p ? { provider: p, model: modelStr.slice(slash + 1) } : null;
  }
  // Match by image model list entry first
  const byModel = providers.find(p => hasImageModel(p, modelStr));
  if (byModel) return { provider: byModel, model: modelStr };
  // agnes-image-* 必须走 Agnes 供给源，避免误选 volcengine 等首个 BODY_CONFIGS 命中项
  if (isAgnesImageModel(modelStr)) {
    const p = providers.find(isAgnesProvider);
    if (p) return { provider: p, model: modelStr };
  }
  // Fall back: provider with image_config, a known adapter, or a matching body config
  const p = providers.find(p => p.image_config || ADAPTERS[p.id] || BODY_CONFIGS.some(c => c.match(p)));
  return p ? { provider: p, model: modelStr } : null;
}

function getAdapter(provider) {
  // Full adapter by id — providers needing a custom request cycle
  if (ADAPTERS[provider.id]) return ADAPTERS[provider.id];
  // OpenAI-compatible base, with per-provider overrides from BODY_CONFIGS
  // (mirrors 9router PROVIDER_MEDIA.imageConfig — detail diffs like Doubao sizing,
  //  Agnes /v1 path + extra_body.response_format).
  const cfg = BODY_CONFIGS.find(c => c.match(provider));
  const base = {
    ...ADAPTERS.openai,
    buildUrl: (_model, p) => `${(p.image_config?.baseUrl || p.base_url || '').replace(/\/+$/, '')}/images/generations`,
  };
  if (!cfg) return base;
  return {
    ...base,
    ...(cfg.buildUrl  ? { buildUrl: cfg.buildUrl }   : {}),
    ...(cfg.buildBody ? { buildBody: cfg.buildBody } : {}),
  };
}

// ── Public handler ────────────────────────────────────────────────────────────
async function handleImageGeneration(body, res, getProviders) {
  if (!body.prompt) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required field: prompt' }));
    return;
  }

  let modelStr = body.model || '';
  // 与 chat 路由一致：剥离 tier 前缀（free:/paid:/p2p:），上游只认裸模型名
  let requestTier = null;
  const tierMatch = TIER_ROUTE_RE.exec(modelStr);
  if (tierMatch) {
    requestTier = tierMatch[1];
    modelStr = tierMatch[2];
  }

  let providers = getProviders();
  if (requestTier) providers = providers.filter(p => p.type === requestTier);

  const resolved  = resolveProvider(modelStr, providers);

  if (!resolved) {
    const tierHint = requestTier ? ` (tier=${requestTier})` : '';
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No image provider found for model "${body.model}"${tierHint}. Use "providerId/model" format or configure a provider with image_config.` }));
    return;
  }

  const { provider, model } = resolved;
  const adapter = getAdapter(provider);

  if (!adapter) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Provider "${provider.id}" has no image generation adapter.` }));
    return;
  }

  try {
    const url      = adapter.buildUrl(model, provider);
    const headers  = adapter.buildHeaders(provider);
    const reqBody  = await adapter.buildBody(model, body);

    console.log(`[image] → ${provider.id}/${model} prompt="${body.prompt.slice(0, 50)}..."`);

    const upstream = await postJson(url, headers, reqBody);

    if (upstream.statusCode >= 400) {
      const errBody = await readJson(upstream);
      const msg = errBody?.error?.message || errBody?.message || `HTTP ${upstream.statusCode}`;
      res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
      return;
    }

    let parsed = await readJson(upstream);
    const normalized = adapter.normalize(parsed, body.prompt);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(normalized));
  } catch (err) {
    console.error('[image] error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Image generation failed' }));
    }
  }
}

module.exports = { handleImageGeneration, ADAPTERS, getAdapter, resolveProvider };
