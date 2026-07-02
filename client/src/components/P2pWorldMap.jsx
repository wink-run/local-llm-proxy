// P2P 全球节点地图（react-simple-maps + 服务端 IP 地理解析）
import React, { useMemo, useState } from 'react';
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
  ZoomableGroup,
} from 'react-simple-maps';

/** 110m 精度世界地图（CDN，无需打包 topojson） */
const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

/** 同坐标多节点时微偏移，避免完全重叠 */
function jitterKey(id, lat, lng) {
  let h = 0;
  const s = String(id || `${lat},${lng}`);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const a = ((h & 0xffff) / 0xffff) * Math.PI * 2;
  const r = 0.15 + ((h >> 16) & 0xff) / 255 * 0.25;
  return [lng + Math.cos(a) * r, lat + Math.sin(a) * r * 0.55];
}

function MapMarker({ worker, coords, labels }) {
  const busy = worker.status === 'busy';
  const title = [
    worker.name,
    worker.geo?.city || (worker.geo?.country ? labels.country(worker.geo.country) : ''),
    (worker.models || []).slice(0, 3).join(', '),
    busy ? labels.busy : labels.idle,
    worker.active_requests ? `${worker.active_requests} req` : '',
  ].filter(Boolean).join(' · ');

  return (
    <Marker coordinates={coords}>
      <g transform="translate(-6,-6)" title={title} className="cursor-default">
        {busy ? (
          <>
            <circle r={7} fill="#f59e0b" opacity={0.35} className="animate-ping" />
            <circle r={4.5} fill="#f59e0b" stroke="#fff" strokeWidth={1.2} />
          </>
        ) : (
          <>
            <circle r={7} fill="#22c55e" opacity={0.35} className="animate-ping" />
            <circle r={4.5} fill="#22c55e" stroke="#fff" strokeWidth={1.2} />
          </>
        )}
      </g>
    </Marker>
  );
}

export default function P2pWorldMap({ workers = [], labels = {} }) {
  const [tip, setTip] = useState(null);

  const points = useMemo(() => {
    const seen = new Map();
    return (workers || [])
      .filter(w => w?.geo?.lat != null && w?.geo?.lng != null)
      .map(w => {
        const lat = w.geo.lat;
        const lng = w.geo.lng;
        const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
        const idx = seen.get(key) || 0;
        seen.set(key, idx + 1);
        const coords = jitterKey(`${w.worker_id}-${idx}`, lat, lng);
        return { worker: w, coords };
      });
  }, [workers]);

  const mapped = points.length;
  const total = workers?.length || 0;
  const unmapped = Math.max(0, total - mapped);

  return (
    <div
      className="p2p-world-map relative rounded-xl overflow-hidden"
      style={{
        // 浅色：天蓝海洋 + 白色陆地；暗色：深海 + 青绿陆地（避免灰阶地图）
        background: 'var(--p2p-map-ocean)',
        ['--p2p-map-ocean']: '#bae6fd',
        ['--p2p-map-fill']: '#f0fdf4',
        ['--p2p-map-stroke']: '#0284c7',
        ['--p2p-map-hover']: '#bbf7d0',
      }}
    >
      <ComposableMap
        projection="geoEqualEarth"
        projectionConfig={{ scale: 145, center: [10, 8] }}
        width={800}
        height={360}
        style={{ width: '100%', height: 'auto' }}
      >
        <ZoomableGroup center={[10, 8]} zoom={1} minZoom={1} maxZoom={4}>
          <Geographies geography={GEO_URL}>
            {({ geographies }) =>
              geographies.map(geo => (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill="var(--p2p-map-fill)"
                  stroke="var(--p2p-map-stroke)"
                  strokeWidth={0.5}
                  style={{
                    default: { outline: 'none' },
                    hover: { fill: 'var(--p2p-map-hover)', outline: 'none' },
                    pressed: { outline: 'none' },
                  }}
                />
              ))
            }
          </Geographies>
          {points.map(({ worker, coords }) => (
            <g
              key={worker.worker_id || worker.name}
              onMouseEnter={() => setTip(worker)}
              onMouseLeave={() => setTip(null)}
            >
              <MapMarker worker={worker} coords={coords} labels={labels} />
            </g>
          ))}
        </ZoomableGroup>
      </ComposableMap>

      {/* 悬停提示 */}
      {tip && (
        <div className="absolute left-3 bottom-3 max-w-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 px-3 py-2 text-xs shadow-lg pointer-events-none">
          <div className="font-medium text-zinc-800 dark:text-zinc-100">{tip.name}</div>
          {(tip.geo?.city || tip.geo?.country) && (
            <div className="text-zinc-500 mt-0.5">
              {tip.geo.city || labels.country?.(tip.geo.country) || tip.geo.country}
            </div>
          )}
          <div className="text-zinc-500 mt-0.5 truncate">{(tip.models || []).join(', ')}</div>
          <div className={`mt-1 ${tip.status === 'busy' ? 'text-amber-600' : 'text-green-600'}`}>
            {tip.status === 'busy' ? labels.busy : labels.idle}
            {tip.active_requests > 0 ? ` · ${tip.active_requests} req` : ''}
          </div>
        </div>
      )}

      {/* 图例 */}
      <div className="flex flex-wrap items-center gap-4 mt-2 px-1 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500" /> {labels.idle}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-amber-500" /> {labels.busy}
        </span>
        <span className="text-zinc-400">
          {labels.mapped?.({ mapped, total }) ?? `${mapped}/${total}`}
          {unmapped > 0 && (labels.unmapped?.(unmapped) ?? ` · ${unmapped} 无定位`)}
        </span>
      </div>

      {/* 暗色：深海蓝底 + 青绿陆地 */}
      <style>{`
        .dark .p2p-world-map {
          --p2p-map-ocean: #082f49;
          --p2p-map-fill: #0e7490;
          --p2p-map-stroke: #22d3ee;
          --p2p-map-hover: #0891b2;
        }
      `}</style>
    </div>
  );
}
