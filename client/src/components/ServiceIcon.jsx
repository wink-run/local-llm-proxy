import { useState } from 'react';
import { resolveBrandIcon, resolveProviderBrandIcon } from '../lib/brandIcons';
import KimiAvatar from './KimiAvatar';

/** 从 Tailwind 尺寸类粗估像素（用于 KimiAvatar） */
function sizeFromClass(cls = '', fallback = 20) {
  const m = String(cls).match(/\bw-\[?(\d+(?:\.\d+)?)(px)?\]?/);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (m[2] === 'px') return n;
  // Tailwind spacing：w-5 → 20px
  return n * 4;
}

/** 远程 logo 加载失败时回退 emoji */
function BrandImg({ src, className, fallback }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return fallback || null;
  return (
    <img
      src={src}
      alt=""
      className={className}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * 产品 / 供给源 logo：
 * - 应用类优先 lobehub 静态 SVG（本地打包）
 * - 供给源走本地 provider-icons（无远程拉取）
 */
export default function ServiceIcon({
  id,
  name,
  icon,
  baseUrl,
  signupUrl,
  boxClass = 'w-8 h-8',
  imgClass = 'w-5 h-5',
  className = '',
  title,
}) {
  const hay = `${id || ''} ${name || ''}`;
  const brand = resolveProviderBrandIcon({
    id,
    name,
    base_url: baseUrl,
    signup_url: signupUrl,
  }) || resolveBrandIcon(hay);
  const isKimi = /kimi|moonshot/i.test(hay);
  const emoji = <span className="text-base leading-none">{icon || '🔧'}</span>;
  return (
    <div
      title={title || name || id}
      className={`${boxClass} rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shrink-0 ${className}`}
    >
      {isKimi
        ? <KimiAvatar size={sizeFromClass(imgClass, 20)} />
        : (
          <BrandImg
            src={brand}
            className={`${imgClass} object-contain`}
            fallback={emoji}
          />
        )}
    </div>
  );
}
