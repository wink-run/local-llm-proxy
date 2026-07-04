'use strict';
// 每个模型的测速：TTFT（首字延迟，ms）+ 输出 TPS（tokens/秒），EWMA 平滑，分 fast/medium/slow。
// 数据来自网关真实转发/主动探针；持久化到 ~/.tokenbank/gateway-speed.json，重启不丢。
// 说明：不用"总延迟"直接判快慢——它被输出长度带偏；改用与长度无关的 TTFT + TPS，两者都测不出时才用总延迟兜底。

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ALPHA = 0.3;          // EWMA 平滑系数（与延迟统计一致）
const MIN_SAMPLES = 1;      // 1 次即出结论（主动测速一次探针即可上色；被动流量后续 EWMA 细化）

// 经验阈值（可调）：TTFT 毫秒、TPS tokens/秒
const TTFT_FAST = 800,  TTFT_SLOW = 2500;
const TPS_FAST  = 30,   TPS_SLOW  = 12;
// 总延迟兜底阈值（当供给源不返回 usage/不流式、TTFT/TPS 都测不出时用；针对小探针的往返 ms）
const LAT_FAST  = 1500, LAT_SLOW  = 5000;

const _map = new Map();     // 归一化 modelId → { ttft, tps, lat, samples, ts }

// ── 持久化（重启不丢；节流写盘，与 route log 同套路）──
const SPEED_FILE = path.join(os.homedir(), '.tokenbank', 'gateway-speed.json');
let _saveTimer = null;
function _load() {
  try {
    const obj = JSON.parse(fs.readFileSync(SPEED_FILE, 'utf8'));
    if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') _map.set(k, v);
  } catch { /* 无文件/损坏则忽略 */ }
}
function _save() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(SPEED_FILE), { recursive: true });
      const o = {}; for (const [k, v] of _map) o[k] = v;
      fs.writeFileSync(SPEED_FILE, JSON.stringify(o));
    } catch { /* best-effort */ }
  }, 2000);   // 合并 2s 内的多次写入
}

// 归一化模型 key：去厂商前缀（deepseek-ai/xxx → xxx）+ 小写 + trim，
// 让 "deepseek-ai/deepseek-v4-pro" / "deepseek-v4-pro" / "Deepseek-V4-Pro" 命中同一条。
// 前端 src/lib/speed.js 的 normModelKey 必须与此保持一致。
function normKey(id) {
  if (!id) return '';
  let s = String(id).trim().toLowerCase();
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  return s;
}

function _ewma(prev, val) { return prev == null ? val : (prev * (1 - ALPHA) + val * ALPHA); }

/**
 * 记录一次真实调用的测速。
 * @param model 解析后的真实模型名
 * @param firstTokenMs 首字延迟（ms）
 * @param outputTokens 本次输出 token 数
 * @param totalMs 总耗时（ms）
 */
function record(rawModel, { firstTokenMs, outputTokens, totalMs, streaming } = {}) {
  const model = normKey(rawModel);
  if (!model) return;
  const total = Number(totalMs);
  const ftt   = Number(firstTokenMs);
  const out   = Number(outputTokens);
  // 只有流式、且首字明显早于总耗时，才算拿到"真实首字延迟"；
  // 非流式整包返回时 first_token==总耗时，不是真实 TTFT，不记（否则会把总延迟当首字）。
  const hasRealTtft = !!streaming && Number.isFinite(ftt) && ftt >= 0 && (total - ftt) > 50;
  const cur = _map.get(model) || { ttft: null, tps: null, lat: null, samples: 0, ts: 0 };
  if (hasRealTtft) cur.ttft = _ewma(cur.ttft, ftt);
  // TPS：有真实首字用"生成窗口"（total-ttft）；否则用总耗时（非流式整体吞吐，偏保守）。
  if (out > 0 && total > 0) {
    const secs = hasRealTtft ? (total - ftt) / 1000 : total / 1000;
    const tps = secs > 0 ? out / secs : null;
    if (tps != null && Number.isFinite(tps) && tps > 0 && tps < 10000) cur.tps = _ewma(cur.tps, tps);
  }
  // 总往返延迟：一定拿得到（成功即有），作为 TTFT/TPS 都测不出时的兜底判档信号。
  if (Number.isFinite(total) && total > 0) cur.lat = _ewma(cur.lat, total);
  cur.samples += 1;
  cur.ts = Date.now();
  _map.set(model, cur);
  _save();
}

/** 由 TTFT/TPS 判快慢（细粒度优先）；两者都测不出时用总延迟兜底（对标 OmniRoute/9router 的 latency）。 */
function bucketOf(ttft, tps, lat) {
  if (ttft == null && tps == null) {
    // 细粒度都没有 → 用总往返延迟兜底
    if (lat == null) return 'unknown';
    if (lat > LAT_SLOW) return 'slow';
    if (lat < LAT_FAST) return 'fast';
    return 'medium';
  }
  const ttftSlow = ttft != null && ttft > TTFT_SLOW;
  const tpsSlow  = tps  != null && tps  < TPS_SLOW;
  if (ttftSlow || tpsSlow) return 'slow';
  const ttftFast = ttft == null || ttft < TTFT_FAST;
  const tpsFast  = tps  == null || tps  > TPS_FAST;
  if (ttftFast && tpsFast) return 'fast';
  return 'medium';
}

/** 返回 { [modelId]: { ttft_ms, tps, samples, bucket, ts } } */
function getSpeedMap() {
  const out = {};
  for (const [model, v] of _map) {
    out[model] = {
      ttft_ms: v.ttft == null ? null : Math.round(v.ttft),
      tps: v.tps == null ? null : Math.round(v.tps),
      lat_ms: v.lat == null ? null : Math.round(v.lat),
      samples: v.samples,
      bucket: v.samples >= MIN_SAMPLES ? bucketOf(v.ttft, v.tps, v.lat) : 'unknown',
      ts: v.ts,
    };
  }
  return out;
}

/**
 * 用历史请求延迟补全"没被动测速也没探针"的模型（如测速功能上线前就用过的个人源）。
 * @param latencyByModel queryModelProviderLatency 结果：{ model: { provider_id: {avg_ttft_ms,last_latency_ms,calls,last_ts} } }
 * 已有真实测速(provider-speed)的模型不覆盖；取各 provider 最快的一档，用总延迟兜底阈值判档。
 */
function getSpeedMapWithLatency(latencyByModel) {
  const out = getSpeedMap();
  if (!latencyByModel || typeof latencyByModel !== 'object') return out;
  for (const [rawModel, byProv] of Object.entries(latencyByModel)) {
    const key = normKey(rawModel);
    if (!key || out[key]) continue;   // 已有真实测速 → 不覆盖
    let best = null, ts = 0, samples = 0;
    for (const v of Object.values(byProv || {})) {
      const ms = Number(v?.avg_ttft_ms ?? v?.last_ttft_ms ?? v?.last_latency_ms);
      if (Number.isFinite(ms) && ms > 0 && (best == null || ms < best)) best = ms;
      if (Number(v?.last_ts) > ts) ts = Number(v.last_ts);
      samples += Number(v?.calls) || 0;
    }
    if (best == null) continue;
    out[key] = {
      ttft_ms: null, tps: null, lat_ms: Math.round(best),
      samples: samples || 1,
      bucket: bucketOf(null, null, best),   // 无 TTFT/TPS → 走总延迟兜底档
      ts: (ts || 0) * 1000,
    };
  }
  return out;
}

_load();   // 启动时从磁盘恢复上次的测速结果（重启不再回到"暂无"）

module.exports = { record, getSpeedMap, getSpeedMapWithLatency, bucketOf, THRESHOLDS: { TTFT_FAST, TTFT_SLOW, TPS_FAST, TPS_SLOW } };
