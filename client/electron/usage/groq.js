'use strict';
/**
 * GroqCloud 吞吐指标抓取（指标型，移植自 CodexBar Groq Prometheus）。
 * 端点：GET https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=<expr>
 * 头：Authorization: Bearer <api_key>
 *
 * ⚠️ 形态特殊：Groq 暴露的是实时吞吐速率（rate5m），**没有额度/余额/百分比概念**，
 * 所以不进 windows/credits，单独放 metrics 字段（前端以指标行展示）。
 * 部分账号可能需要企业版才能访问 metrics 端点（401/403）。
 */
const { providerApiKey } = require('./shared');

const BASE = 'https://api.groq.com/v1/metrics/prometheus/api/v1/query';
const QUERIES = {
  requests: 'sum(model_project_id_status_code:requests:rate5m)',
  tokensIn: 'sum(model_project_id:tokens_in:rate5m)',
  tokensOut: 'sum(model_project_id:tokens_out:rate5m)',
  cacheHits: 'sum(model_project_id:prompt_cache_hits:rate5m)',
};

/** 从 Prometheus query 响应取末位数值。 */
function scalarOf(json) {
  try {
    const r = json && json.data && json.data.result;
    const v = r && r[0] && r[0].value;
    const x = v && v[v.length - 1];
    const n = typeof x === 'string' ? parseFloat(x) : x;
    return typeof n === 'number' && isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** rate(/秒) → 每分钟派生指标（纯函数，可单测）。 */
function mapGroqMetrics(vals, provider) {
  const v = vals || {};
  const tokensInOut = (v.tokensIn || 0) + (v.tokensOut || 0);
  return {
    provider: 'groq',
    id: (provider && provider.id) || 'groq',
    primary: null,
    windows: [],
    metrics: {
      requestsPerMin: v.requests != null ? v.requests * 60 : null,
      tokensPerMin: v.tokensIn != null || v.tokensOut != null ? tokensInOut * 60 : null,
      cacheHitsPerMin: v.cacheHits != null ? v.cacheHits * 60 : null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchGroqUsage(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少 Groq API key');
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const entries = Object.entries(QUERIES);
  const pairs = await Promise.all(
    entries.map(async ([k, expr]) => {
      const resp = await fetch(`${BASE}?query=${encodeURIComponent(expr)}`, { headers });
      if (resp.status === 401 || resp.status === 403) throw new Error('401/403：无权访问 metrics（可能需企业版）');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (json && json.status && json.status !== 'success') throw new Error(json.error || 'metrics 查询失败');
      return [k, scalarOf(json)];
    }),
  );
  return mapGroqMetrics(Object.fromEntries(pairs), provider);
}

module.exports = { fetchGroqUsage, mapGroqMetrics };
