// client/electron/compression-report.js
// 汇总 ~/.tokenbank/compression-log.jsonl：总请求数 / 累计 token / 平均压缩比 / 按模型拆分。
// 节省费用按 stats 中网关实际路由模型的 input 刊例价加权估算（不用客户端请求的 claude 名）。
'use strict';

/** 聚合压缩记录（纯函数，可单测）。records: [{model, before, after, saved}] */
function summarizeCompressionLog(records = []) {
  let count = 0, before = 0, after = 0;
  const byModel = {};
  for (const r of records) {
    if (!r || typeof r.before !== 'number' || typeof r.after !== 'number') continue;
    count += 1; before += r.before; after += r.after;
    const m = r.model || 'unknown';
    const g = byModel[m] || (byModel[m] = { count: 0, before: 0, after: 0 });
    g.count += 1; g.before += r.before; g.after += r.after;
  }
  const ratio = before > 0 ? (before - after) / before : 0;
  const models = Object.entries(byModel)
    .map(([model, g]) => ({
      model, ...g,
      saved: g.before - g.after,
      ratio: g.before > 0 ? (g.before - g.after) / g.before : 0,
    }))
    .sort((a, b) => b.saved - a.saved);
  return { count, before, after, saved: before - after, ratio, saved_usd: 0, models };
}

/**
 * 用网关实际模型的 input 加权单价估算压缩节省费用。
 * gatewayRates: { totalInputTokens, totalInputCostUsd }（来自 local-stats queryGatewayInputCostRate）
 */
function applyGatewaySavedCost(summary, gatewayRates) {
  if (!summary) return summary;
  const saved = summary.saved || 0;
  const inTok = gatewayRates?.totalInputTokens || 0;
  const inCost = gatewayRates?.totalInputCostUsd || 0;
  const rate = inTok > 0 ? inCost / inTok : 0;
  summary.saved_usd = saved * rate;
  for (const m of summary.models || []) {
    m.saved_usd = (m.saved || 0) * rate;
  }
  return summary;
}

/** 解析 JSONL 文本为记录数组（容错跳过坏行）。 */
function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 读取压缩日志文件并按最近 days 天汇总（days<=0 或缺省=全部）。 */
function readCompressionSummary(days, gatewayRates) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(os.homedir(), '.tokenbank', 'compression-log.jsonl');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return applyGatewaySavedCost(summarizeCompressionLog([]), gatewayRates); }
  let recs = parseJsonl(text);
  if (days && days > 0) {
    const since = Date.now() - days * 86400000;
    recs = recs.filter(r => { const t = Date.parse(r && r.ts); return Number.isNaN(t) ? true : t >= since; });
  }
  return applyGatewaySavedCost(summarizeCompressionLog(recs), gatewayRates);
}

module.exports = { summarizeCompressionLog, parseJsonl, readCompressionSummary, applyGatewaySavedCost };
