'use strict';
// OpenRouter 模型目录定期刷新：公开端点 GET https://openrouter.ai/api/v1/models（无需 API key）拉全量，
// 缓存到磁盘(~/.tokenbank/openrouter-models.json) + 内存；启动时(无缓存/过期才拉) + 每 12h 定时刷新。
// registry 里 openrouter 只硬编码了 2 个模型，路由/UI 想认全部 300+ 个就靠这个目录。
// 网关侧合并见 billing-config.enrichProvidersFromAccounts（用本模块预构建的数组，热路径 O(1) 引用，不重算）。
//
// 端点特性（实测响应头）：CF 缓存 max-age=300、无 ETag/Last-Modified → 只能整拉、别比 5min 更勤。
// 出错保留上次缓存（端点自身也 stale-if-error）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const URL_MODELS = 'https://openrouter.ai/api/v1/models';
const FILE = path.join(os.homedir(), '.tokenbank', 'openrouter-models.json');
const REFRESH_MS = 12 * 60 * 60 * 1000;   // 12h：模型列表变化慢

let _models = [];      // [{ name, type:'chat' }]（预构建，供网关 O(1) 引用合并）
let _pricing = {};     // { name: { in, out } } 每 MTok（美元），供成本估算
let _fetchedAt = 0;
let _timer = null;

// 把 /models 响应解析成 { models, pricing }。pricing.prompt/completion 是「每 token 美元」字符串 → 转每 MTok。
function _parse(json) {
  const data = (json && json.data) || [];
  const models = [];
  const pricing = {};
  for (const m of data) {
    const name = String((m && m.id) || '').trim();
    if (!name) continue;
    models.push({ name, type: 'chat' });
    const pr = (m && m.pricing) || {};
    const inTok = parseFloat(pr.prompt), outTok = parseFloat(pr.completion);
    if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
      pricing[name] = { in: +(((inTok || 0) * 1e6).toFixed(4)), out: +(((outTok || 0) * 1e6).toFixed(4)) };
    }
  }
  return { models, pricing };
}

function _apply(models, pricing, fetchedAt) { _models = models; _pricing = pricing || {}; _fetchedAt = fetchedAt || 0; }

function _load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(j.models)) _apply(j.models, j.pricing, j.fetched_at);
  } catch { /* 无缓存/损坏 → 空，等 refresh */ }
}

function _save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ fetched_at: _fetchedAt, models: _models, pricing: _pricing }));
  } catch { /* ignore */ }
}

// 拉一次并更新缓存。返回 { ok, count, fetched_at }。失败保留旧数据。
function refresh() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const req = https.get(URL_MODELS, { timeout: 15000, headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish({ ok: false, count: _models.length, fetched_at: _fetchedAt }); }
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try {
          const { models, pricing } = _parse(JSON.parse(buf));
          if (models.length) { _apply(models, pricing, Date.now()); _save(); }
          finish({ ok: models.length > 0, count: _models.length, fetched_at: _fetchedAt });
        } catch { finish({ ok: false, count: _models.length, fetched_at: _fetchedAt }); }
      });
    });
    req.on('error', () => finish({ ok: false, count: _models.length, fetched_at: _fetchedAt }));
    req.on('timeout', () => { req.destroy(); finish({ ok: false, count: _models.length, fetched_at: _fetchedAt }); });
  });
}

// 启动：读缓存；无缓存或过期(>12h)则立刻拉一次；挂 12h 定时器。
function start() {
  _load();
  if (!_models.length || (Date.now() - _fetchedAt) > REFRESH_MS) refresh().catch(() => {});
  if (!_timer) { _timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS); if (_timer.unref) _timer.unref(); }
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

function getModels() { return _models; }
function getPricing() { return _pricing; }
function getFetchedAt() { return _fetchedAt; }

module.exports = { start, stop, refresh, getModels, getPricing, getFetchedAt, _parse };
