// 测速展示共用：圆点颜色、tooltip 文案、拉取网关 speedMap 的 hook。
// 数据来自网关被动测速（gateway:speedMap），按模型名 → { ttft_ms, tps, samples, bucket }。
import { useCallback, useEffect, useState } from 'react';

// 归一化模型 key（必须与后端 electron/provider-speed.js 的 normKey 一致）：
// 去厂商前缀 + 小写 + trim，让同一模型的不同写法命中同一条测速。
export function normModelKey(id) {
  if (!id) return '';
  let s = String(id).trim().toLowerCase();
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  return s;
}

/** 按归一化 key 取某模型的测速（两处 UI 统一走它，避免名字写法不同导致颜色不一致） */
export function speedFor(map, id) {
  if (!map || !id) return null;
  return map[normModelKey(id)] || null;
}

// TTFT/首字延迟(ms) → 档位。阈值与后端 provider-speed 的 TTFT 档一致（首字语义）。
// 用于社区 worker / 个人源多实例这类"每实例只有 TTFT、没有我们完整测速"的场景。
const TTFT_FAST_MS = 800, TTFT_SLOW_MS = 2500;
export function bucketFromMs(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return 'unknown';
  if (v > TTFT_SLOW_MS) return 'slow';
  if (v < TTFT_FAST_MS) return 'fast';
  return 'medium';
}

// 服务端质量星级(1–5) → 档：≥4=好(绿) / 3=中(黄) / ≤2=差(红) / 无=灰。复用 speedDotClass 颜色。
// 社区源用它上色/排序（star 含延迟+成功率+在线，且是降级依据，显示与路由口径一致）。
export function starsBucket(stars) {
  const s = Number(stars);
  if (!Number.isFinite(s) || s <= 0) return 'unknown';
  if (s >= 4) return 'fast';
  if (s >= 2.5) return 'medium';   // 含 2.5 初始值 + 3★ → 中性(黄)
  return 'slow';
}

// 复刻服务端质量系数 multiplier（server.py:_worker_row）：0.4×在线 + 0.4×延迟 + 0.2×成功率。
// 个人源没有"在线时长"概念 → onlineF 取中性 1.0；avgTtftMs=平均首字，successRate=成功率(0..1)。
export function qualityMultiplier({ avgTtftMs, successRate = 1, onlineF = 1.0 }) {
  const latencyF = avgTtftMs > 0 ? Math.max(0.6, Math.min(1.5, 500 / avgTtftMs)) : 1.0;
  const stabilityF = 0.5 + 0.7 * (successRate ?? 1);
  return Math.max(0.5, Math.min(1.5, 0.4 * onlineF + 0.4 * latencyF + 0.2 * stabilityF));
}

/** multiplier → 星级 1–5（与服务端 _stars 阈值一致）；入参无效返回 null */
export function starsFromMultiplier(m) {
  if (m == null || !Number.isFinite(m)) return null;
  if (m >= 1.3) return 5;
  if (m >= 1.1) return 4;
  if (m >= 0.9) return 3;
  if (m >= 0.7) return 2;
  return 1;
}

/** fast=绿 / medium=黄 / slow=红 / 无数据=灰 */
export function speedDotClass(bucket) {
  if (bucket === 'fast')   return 'bg-green-400 shadow-[0_0_4px] shadow-green-400/50';
  if (bucket === 'medium') return 'bg-amber-400';
  if (bucket === 'slow')   return 'bg-red-400';
  return 'bg-zinc-300 dark:bg-zinc-600';   // unknown / 暂无测速
}

export function speedTitle(s) {
  if (!s || s.bucket === 'unknown') return '暂无测速数据';
  const label = s.bucket === 'fast' ? '快速' : s.bucket === 'medium' ? '中速' : '慢速';
  if (s.ttft_ms != null || s.tps != null)
    return `${label} · 首字 ${s.ttft_ms ?? '—'}ms · ${s.tps ?? '—'} tok/s · ${s.samples} 次采样`;
  return `${label} · 往返 ${s.lat_ms ?? '—'}ms · ${s.samples} 次采样`;   // 供给源无 usage → 用总延迟
}

/** 拉取网关测速表：Electron 走 IPC；CLI/Docker Web 无 electronAPI 时走 admin-api 代理。 */
function fetchSpeedMap() {
  const ipc = window.electronAPI?.gateway?.speedMap;
  if (ipc) return ipc().catch(() => ({}));
  const base = import.meta.env?.VITE_ADMIN_BASE ?? '';
  return fetch(`${base}/api/gateway/speed`)
    .then(r => (r.ok ? r.json() : {}))
    .catch(() => ({}));
}

/** 每 intervalMs 拉一次网关测速表；返回 [map, refresh]。refresh 可在测速后立即刷新。 */
export function useSpeedMap(intervalMs = 15000) {
  const [map, setMap] = useState({});
  const refresh = useCallback(() => fetchSpeedMap().then(m => setMap(m || {})), []);
  useEffect(() => {
    let alive = true;
    const load = () => fetchSpeedMap().then(m => { if (alive) setMap(m || {}); });
    load();
    const id = setInterval(load, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);
  return [map, refresh];
}
