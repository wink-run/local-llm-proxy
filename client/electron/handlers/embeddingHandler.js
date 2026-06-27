'use strict';

const https = require('https');
const http  = require('http');

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

function resolveProvider(modelStr, providers) {
  if (!modelStr) return null;
  const slash = modelStr.indexOf('/');
  if (slash > 0) {
    const pid = modelStr.slice(0, slash);
    const p   = providers.find(p => p.id === pid || p.id?.startsWith(pid));
    return p ? { provider: p, model: modelStr.slice(slash + 1) } : null;
  }
  // No prefix: find first provider with embedding enabled
  const p = providers.find(p => p.embedding || (p.modalities || []).includes('embedding'));
  return p ? { provider: p, model: modelStr } : null;
}

async function handleEmbedding(body, res, getProviders) {
  const providers = getProviders();
  const resolved  = resolveProvider(body.model || '', providers);

  if (!resolved) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No embedding provider found. Use "providerId/model" format or enable embedding on a provider.' }));
    return;
  }

  const { provider, model } = resolved;
  const base = (provider.base_url || '').replace(/\/+$/, '');
  const url  = `${base}/v1/embeddings`;

  try {
    const upstream = await postJson(url, buildHeaders(provider), { ...body, model });
    const text     = await readBody(upstream);

    res.writeHead(upstream.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(text);
  } catch (err) {
    console.error('[embedding] error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Embedding request failed' }));
    }
  }
}

module.exports = { handleEmbedding };
