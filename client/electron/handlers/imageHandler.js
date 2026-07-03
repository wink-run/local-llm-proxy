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
const { resolveOutboundProxyAgent } = require('../../shared/outbound-proxy');

/** 图像生成默认超时（上游轮询型 API 常需 30–120s 才有首字节） */
const DEFAULT_IMAGE_TIMEOUT_MS = 300_000;
const MIN_IMAGE_TIMEOUT_MS = 180_000;

/** 从网关 config.req_timeout（秒）解析图像超时，至少 3 分钟 */
function resolveImageRequestTimeoutMs(config) {
  const sec = Number(config?.req_timeout);
  if (Number.isFinite(sec) && sec > 0) {
    return Math.max(sec * 1000, MIN_IMAGE_TIMEOUT_MS);
  }
  return DEFAULT_IMAGE_TIMEOUT_MS;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** 读取上游响应全文；maxLen=0 表示不截断（图像 base64 可能数 MB） */
function readResponseText(res, maxLen = 8000) {
  return new Promise((resolve, reject) => {
    let d = '';
    res.on('data', c => {
      d += c;
      if (maxLen > 0 && d.length > maxLen) d = d.slice(0, maxLen);
    });
    res.on('end', () => resolve(d));
    res.on('error', reject);
  });
}

async function readJson(res, maxLen = 8000) {
  const raw = await readResponseText(res, maxLen);
  try { return JSON.parse(raw); } catch { return raw; }
}

/** 成功响应：完整读取并解析 JSON（禁止截断，否则大图 b64 会破坏 JSON） */
async function readJsonFull(res) {
  const raw = await readResponseText(res, 0);
  try { return JSON.parse(raw); } catch (e) {
    throw new Error(`Invalid JSON from image upstream: ${e.message}`);
  }
}

/** 从上游 JSON / 纯文本提取可读错误信息 */
function extractErrorDetail(parsed, raw, status) {
  if (parsed && typeof parsed === 'object') {
    const e = parsed.error;
    if (e && typeof e === 'object') {
      const parts = [e.message, e.detail, e.status].filter(Boolean);
      if (Array.isArray(e.details) && e.details.length) {
        parts.push(e.details.map(d => d.message || JSON.stringify(d)).join('; '));
      }
      const joined = parts.join(' — ');
      if (joined) return joined;
      try { return JSON.stringify(e); } catch { /* fall through */ }
    }
    if (typeof e === 'string' && e.trim()) {
      const t = e.trim();
      // 跳过无实质内容的 "HTTP 404" 占位，继续尝试 raw 正文
      if (!/^HTTP \d{3}$/.test(t)) return t;
    }
    if (parsed.message) return String(parsed.message);
    if (parsed.detail) return String(parsed.detail);
    try { return JSON.stringify(parsed).slice(0, 4000); } catch { /* fall through */ }
  }
  const text = typeof parsed === 'string' ? parsed : (typeof raw === 'string' ? raw : '');
  if (text.trim()) return text.trim().slice(0, 4000);
  return status ? `HTTP ${status}` : 'Unknown upstream error';
}

/** Gemini base_url 规范化（与 local-gateway geminiBase 一致） */
function geminiBase(rawBaseUrl) {
  const raw = (rawBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  return /\/v1beta/i.test(raw) ? raw : `${raw}/v1beta`;
}

function isGeminiImageProvider(p = {}) {
  const fmt = String(p.api_format || p.handler || '').toLowerCase();
  const url = String(p.base_url || '');
  // 仅 Google 原生端点走 generateContent；OpenAI 兼容代理（apihub 等）仍走 /images/generations
  if (/generativelanguage\.googleapis\.com/i.test(url)) return true;
  if (fmt === 'gemini' && !/\/openai|apihub|agnes/i.test(url)) return true;
  return false;
}

/** OpenAI size → 分辨率档位（1k / 2k / 4k） */
function sizeToResolution(sizeStr) {
  const [w, h] = (sizeStr || '1024x1024').split('x').map(Number);
  const maxDim = Math.max(w || 1024, h || 1024);
  if (maxDim >= 3840) return '4k';
  if (maxDim >= 1920) return '2k';
  return '1k';
}

/** 是否使用 ratio + resolution 而非 size（Agnes 等 OpenAI 兼容图像 API） */
function needsRatioResolution(provider, model) {
  if (provider?.image_config?.sizeParams === 'ratio_resolution') return true;
  const url = String(provider?.base_url || '');
  const id = String(provider?.id || '');
  if (/apihub\.agnes-ai\.com/i.test(url) || /agnes/i.test(id)) return true;
  if (/agnes[-_]image|^agnes-image|-image$/i.test(model || '')) return true;
  return false;
}

/** 写入 ratio / resolution；禁止与 size 混用 */
function applyRatioResolution(out, body, { defaultFromSize = false } = {}) {
  const ratio = body.ratio || (defaultFromSize && body.size ? sizeToAspectRatio(body.size) : undefined);
  const resolution = body.resolution || (defaultFromSize && body.size ? sizeToResolution(body.size) : undefined);
  if (ratio) out.ratio = ratio;
  if (resolution) out.resolution = resolution;
  return !!(ratio || resolution);
}

/** OpenAI size → Gemini aspectRatio（如 1024x768 → 4:3） */
function sizeToAspectRatio(sizeStr) {
  const [w, h] = (sizeStr || '1024x1024').split('x').map(Number);
  if (!w || !h) return '1:1';
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

/** Gemini generateContent 响应 → OpenAI images 格式 */
function normalizeGeminiImageResponse(parsed) {
  if (Array.isArray(parsed?.data) && parsed.data.length) return parsed;

  const images = [];
  for (const cand of (parsed?.candidates || [])) {
    for (const part of (cand.content?.parts || [])) {
      if (part.inlineData?.data) {
        images.push({ b64_json: part.inlineData.data });
      }
    }
  }
  return {
    created: parsed?.createTime
      ? Math.floor(new Date(parsed.createTime).getTime() / 1000)
      : Math.floor(Date.now() / 1000),
    data: images,
  };
}

/** Gemini 原生 generateContent + OpenAI 兼容端点（404 时依次尝试） */
const GEMINI_IMAGE_ADAPTER = {
  buildUrl: (model, p) =>
    `${geminiBase(p.base_url)}/models/${encodeURIComponent(model)}:generateContent`,
  buildHeaders: (p) => ({ 'x-goog-api-key': p.token || '' }),
  buildBody: (_model, body) => {
    const genConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    const ratio = sizeToAspectRatio(body.size);
    if (ratio) genConfig.imageConfig = { aspectRatio: ratio };
    const parts = [{ text: body.prompt }];
    // 图生图：body.image 为 data-uri 或 base64 字符串数组
    if (Array.isArray(body.image)) {
      for (const img of body.image) {
        if (typeof img !== 'string') continue;
        const mm = img.match(/^data:([^;]+);base64,(.+)$/);
        if (mm) parts.push({ inlineData: { mimeType: mm[1], data: mm[2] } });
      }
    }
    return {
      contents: [{ parts }],
      generationConfig: genConfig,
    };
  },
  normalize: normalizeGeminiImageResponse,
  getAttempts(model, provider, body) {
    const token = provider.token || '';
    const nativeUrl = this.buildUrl(model, provider);
    const nativeHeaders = this.buildHeaders(provider);
    const nativeBody = this.buildBody(model, body);
    const base = geminiBase(provider.base_url);
    const openaiUrl = `${base}/openai/v1/images/generations`;
    const openaiBody = {
      model,
      prompt: body.prompt,
      n: body.n || 1,
      size: body.size || '1024x1024',
      response_format: body.response_format || 'b64_json',
    };
    return [
      { url: nativeUrl, headers: nativeHeaders, body: nativeBody, normalize: normalizeGeminiImageResponse },
      { url: openaiUrl, headers: { Authorization: `Bearer ${token}` }, body: openaiBody, normalize: (p) => p },
    ];
  },
};

function formatImageErr(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  const msg = err.message != null ? String(err.message).trim() : '';
  if (msg) return msg;
  if (err.code) return String(err.code);
  try { return JSON.stringify(err); } catch { return String(err); }
}

function logImageError(label, detail, extra = {}) {
  const line = `[image] ${label}: ${detail || '(empty)'}`;
  if (Object.keys(extra).length) console.error(line, extra);
  else console.error(line);
}

function postJson(url, headers, body, { provider, networkProxy, timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const mod  = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const agent = resolveOutboundProxyAgent({ provider, urlStr: url, networkProxy });
    const req  = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: timeoutMs,
      ...(agent ? { agent } : {}),
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Image request timed out (${Math.round(timeoutMs / 1000)}s)`)); });
    req.write(data);
    req.end();
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
    buildBody: (model, body) => {
      const out = { model, prompt: body.prompt, n: body.n || 1 };
      // 客户端显式传 ratio/resolution 时优先使用，不发 size
      if (body.ratio || body.resolution) {
        if (body.ratio) out.ratio = body.ratio;
        if (body.resolution) out.resolution = body.resolution;
      } else {
        out.size = body.size || '1024x1024';
      }
      if (body.quality) out.quality = body.quality;
      if (body.style) out.style = body.style;
      if (body.response_format) out.response_format = body.response_format;
      return out;
    },
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
      const out = { model, prompt: body.prompt };
      // Agnes 不支持 size，必须用 ratio + resolution
      applyRatioResolution(out, body, { defaultFromSize: true });
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
  // Gemini 图像模型走 generateContent，不能用 /images/generations
  if (isGeminiImageProvider(provider)) return GEMINI_IMAGE_ADAPTER;
  // OpenAI-compatible base, with per-provider overrides from BODY_CONFIGS
  // (mirrors 9router PROVIDER_MEDIA.imageConfig — detail diffs like Doubao sizing,
  //  Agnes /v1 path + extra_body.response_format).
  const cfg = BODY_CONFIGS.find(c => c.match(provider));
  const base = {
    ...ADAPTERS.openai,
    buildUrl: (_model, p) => `${(p.image_config?.baseUrl || p.base_url || '').replace(/\/+$/, '')}/images/generations`,
    buildBody: (model, body, p) => {
      if (needsRatioResolution(p, model)) {
        const out = { model, prompt: body.prompt };
        applyRatioResolution(out, body, { defaultFromSize: true });
        if (body.n) out.n = body.n;
        if (body.response_format) out.response_format = body.response_format;
        return out;
      }
      return ADAPTERS.openai.buildBody(model, body);
    },
  };
  if (!cfg) return base;
  return {
    ...base,
    ...(cfg.buildUrl  ? { buildUrl: cfg.buildUrl }   : {}),
    ...(cfg.buildBody ? { buildBody: cfg.buildBody } : {}),
  };
}

// ── Public handler ────────────────────────────────────────────────────────────
async function handleImageGeneration(body, res, getProviders, { skipP2P = false, networkProxy = null, requestTimeoutMs = DEFAULT_IMAGE_TIMEOUT_MS } = {}) {
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
  if (skipP2P) providers = providers.filter(p => p.type !== 'p2p');
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
    const attempts = typeof adapter.getAttempts === 'function'
      ? adapter.getAttempts(model, provider, body)
      : [{
          url: adapter.buildUrl(model, provider),
          headers: adapter.buildHeaders(provider),
          body: adapter.buildBody(model, body, provider),
          normalize: adapter.normalize.bind(adapter),
        }];

    console.log(`[image] → ${provider.id}/${model} prompt="${body.prompt.slice(0, 50)}..."`);

    let normalized = null;
    let lastFail = null;

    for (let i = 0; i < attempts.length; i++) {
      const { url, headers, body: reqBody, normalize } = attempts[i];
      const upstream = await postJson(url, headers, reqBody, { provider, networkProxy, timeoutMs: requestTimeoutMs });

      if (upstream.statusCode >= 400) {
        const raw = await readResponseText(upstream);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        const msg = extractErrorDetail(parsed, raw, upstream.statusCode);
        lastFail = { status: upstream.statusCode, url, msg, raw };
        // 404 且还有备用端点时继续尝试
        if (upstream.statusCode === 404 && i < attempts.length - 1) {
          console.log(`[image] ${provider.id}/${model} 404 on ${url}, trying fallback...`);
          continue;
        }
        logImageError('upstream HTTP error', msg, {
          status: upstream.statusCode,
          url,
          provider: provider.id,
          model,
          body: typeof raw === 'string' ? raw.slice(0, 2000) : undefined,
        });
        res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
        return;
      }

      let parsed = await readJsonFull(upstream);
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch {
          throw new Error('Invalid image upstream response (string body)');
        }
      }
      normalized = normalize(parsed, body.prompt);
      if (normalized?.data?.length) break;
      lastFail = { status: 200, url, msg: 'empty image list in upstream response' };
      if (i < attempts.length - 1) continue;
    }

    if (!normalized?.data?.length) {
      const msg = lastFail?.msg || 'No image data in upstream response';
      logImageError('empty result', msg, { provider: provider.id, model, url: lastFail?.url });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
      return;
    }
    if (typeof normalized === 'string') {
      // 防御：normalize 不应返回字符串；若已是 JSON 字符串则直接写出
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(normalized);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(normalized));
  } catch (err) {
    logImageError('error', formatImageErr(err), {
      provider: provider?.id,
      model,
    });
    if (err?.stack) console.error('[image] stack:', err.stack);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: formatImageErr(err) || 'Image generation failed' }));
    }
  }
}

module.exports = {
  handleImageGeneration,
  ADAPTERS,
  getAdapter,
  resolveProvider,
  geminiBase,
  isGeminiImageProvider,
  normalizeGeminiImageResponse,
  needsRatioResolution,
  sizeToResolution,
  resolveImageRequestTimeoutMs,
  DEFAULT_IMAGE_TIMEOUT_MS,
};
