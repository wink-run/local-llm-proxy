'use strict';

const https = require('https');
const http  = require('http');
const { parseRoute } = require('../../shared/route-binding');

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
    req.on('timeout', () => { req.destroy(); reject(new Error('Embedding request timed out')); });
    req.write(data);
    req.end();
  });
}

async function readBody(res) {
  return new Promise((resolve, reject) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => resolve(d));
    res.on('error', reject);
  });
}

function buildHeaders(provider) {
  const h = { 'Content-Type': 'application/json' };
  if (provider.token) h['Authorization'] = `Bearer ${provider.token}`;
  return h;
}

/** 已含 /v1 /v3 时只拼 embeddings，避免 ark .../api/v3/v1/embeddings */
function buildEmbeddingsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v\d+$/i.test(base)) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

function providerHasModel(p, name) {
  return (p.models || []).some((m) => {
    const id = typeof m === 'string' ? m : m.name;
    return id === name;
  });
}

function resolveProvider(modelStr, providers) {
  if (!modelStr) return null;
  const list = Array.isArray(providers) ? providers : [];
  const pr = parseRoute(modelStr);
  const bare = pr.model || modelStr;
  let pool = list;
  if (pr.tier) {
    const byTier = pool.filter((p) => p.type === pr.tier || p.tier === pr.tier);
    if (byTier.length) pool = byTier;
  }
  // paid:volcengine:doubao-embedding-vision → 钉选供给源
  if (pr.provider) {
    const p = pool.find((x) => x.id === pr.provider || x.id?.startsWith(pr.provider));
    if (p) return { provider: p, model: bare };
  }
  const slash = modelStr.indexOf('/');
  if (slash > 0) {
    const pid = modelStr.slice(0, slash);
    const p   = pool.find((x) => x.id === pid || x.id?.startsWith(pid));
    if (p) return { provider: p, model: modelStr.slice(slash + 1) };
  }
  const byModel = pool.find((p) => providerHasModel(p, bare));
  if (byModel) return { provider: byModel, model: bare };
  const p = pool.find((x) => x.embedding || (x.modalities || []).includes('embedding'));
  return p ? { provider: p, model: bare } : null;
}

function extractErrorMessage(text, status) {
  try {
    const j = JSON.parse(text);
    const e = j.error;
    if (e && typeof e === 'object') return e.message || JSON.stringify(e);
    if (typeof e === 'string' && e.trim()) return e.trim();
    if (j.message) return String(j.message);
  } catch { /* 非 JSON */ }
  const t = String(text || '').trim();
  return t ? t.slice(0, 400) : `HTTP_${status}`;
}

async function handleEmbedding(body, res, getProviders, hooks = {}) {
  const origModel = body.model || '';
  const t0 = Date.now();
  const providers = getProviders();
  const resolved  = resolveProvider(origModel, providers);

  const done = (ok, status, extra = {}) => {
    try {
      hooks.onComplete?.({
        ok,
        status,
        latencyMs: Date.now() - t0,
        origModel,
        model: resolved?.model || parseRoute(origModel).model || origModel,
        provider: resolved?.provider || null,
        error: extra.error,
      });
    } catch { /* 记速失败不影响响应 */ }
  };

  if (!resolved) {
    const msg = 'No embedding provider found. Use "providerId/model" format or enable embedding on a provider.';
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
    done(false, 400, { error: msg });
    return;
  }

  const { provider, model } = resolved;
  const url  = buildEmbeddingsUrl(provider.base_url);

  try {
    const upstream = await postJson(url, buildHeaders(provider), { ...body, model });
    const text     = await readBody(upstream);
    const status   = upstream.statusCode || 502;

    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(text);
    done(status < 400, status, status < 400 ? {} : { error: extractErrorMessage(text, status) });
  } catch (err) {
    console.error('[embedding] error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Embedding request failed' }));
    }
    done(false, 502, { error: err.message || 'Embedding request failed' });
  }
}

module.exports = { handleEmbedding, resolveProvider, buildEmbeddingsUrl };
