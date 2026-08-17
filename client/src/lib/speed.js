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

// TTFT/延迟(ms) → 档：失败另走 fail；>4s 慢(黄)；<4s 快(绿)；无请求灰。
export const SLOW_MS = 4000;
export function bucketFromMs(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return 'unknown';
  if (v > SLOW_MS) return 'slow';
  return 'fast';
}

/** 状态点：失败红 / 慢黄 / 快绿 / 无请求灰。ok 且无耗时仍算绿（请求成功）。 */
export function statusDotBucket({ ms, failed, ok } = {}) {
  if (failed) return 'fail';
  const b = bucketFromMs(ms);
  if (b !== 'unknown') return b;
  if (ok) return 'fast';
  return 'unknown';
}

// 服务端质量星级(1–5) → 档：≥4=快(绿) / 3=慢(黄) / ≤2=差(红) / 无=灰。复用 speedDotClass。
export function starsBucket(stars) {
  const s = Number(stars);
  if (!Number.isFinite(s) || s <= 0) return 'unknown';
  if (s >= 4) return 'fast';
  if (s >= 2.5) return 'slow';
  return 'fail';
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

/** fail=红 / fast=绿 / slow=黄 / 无数据=灰 */
export function speedDotClass(bucket) {
  if (bucket === 'fail') return 'bg-red-500';
  if (bucket === 'fast') return 'bg-green-400 shadow-[0_0_4px] shadow-green-400/50';
  if (bucket === 'slow' || bucket === 'medium') return 'bg-amber-400';
  return 'bg-zinc-300 dark:bg-zinc-600';
}

export function speedTitle(s) {
  if (!s || s.bucket === 'unknown') return '暂无测速数据';
  if (s.bucket === 'fail') return '最近请求失败';
  const label = s.bucket === 'fast' ? '快速' : '慢速';
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
