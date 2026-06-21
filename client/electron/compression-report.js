// client/electron/compression-report.js
// 汇总 ~/.tokenbank/compression-log.jsonl：总请求数 / 累计 token / 平均压缩比 / 按模型拆分。
// 供盘点页展示压缩统计。
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
    .map(([model, g]) => ({ model, ...g, saved: g.before - g.after, ratio: g.before > 0 ? (g.before - g.after) / g.before : 0 }))
    .sort((a, b) => b.saved - a.saved);
  return { count, before, after, saved: before - after, ratio, models };
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
function readCompressionSummary(days) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(os.homedir(), '.tokenbank', 'compression-log.jsonl');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return summarizeCompressionLog([]); }
  let recs = parseJsonl(text);
  if (days && days > 0) {
    const since = Date.now() - days * 86400000;
    recs = recs.filter(r => { const t = Date.parse(r && r.ts); return Number.isNaN(t) ? true : t >= since; });
  }
  return summarizeCompressionLog(recs);
}

module.exports = { summarizeCompressionLog, parseJsonl, readCompressionSummary };
