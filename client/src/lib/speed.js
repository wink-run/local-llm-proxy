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
