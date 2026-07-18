import { resolveBrandIcon } from '../lib/brandIcons';
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

/** 产品 logo：与网关/供给源页一致，优先 lobehub 品牌 SVG，否则回退 emoji */
export default function ServiceIcon({
  id,
  name,
  icon,
  boxClass = 'w-8 h-8',
  imgClass = 'w-5 h-5',
  className = '',
  title,
}) {
  const hay = `${id || ''} ${name || ''}`;
  const brand = resolveBrandIcon(hay);
  const isKimi = /kimi|moonshot/i.test(hay);
  return (
    <div
      title={title || name || id}
      className={`${boxClass} rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shrink-0 ${className}`}
    >
      {isKimi
        ? <KimiAvatar size={sizeFromClass(imgClass, 20)} />
        : brand
          ? <img src={brand} alt="" className={`${imgClass} object-contain`} draggable={false} />
          : <span className="text-base leading-none">{icon || '🔧'}</span>}
    </div>
  );
}
