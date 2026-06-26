import { resolveBrandIcon } from '../lib/brandIcons';

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
  const brand = resolveBrandIcon(`${id || ''} ${name || ''}`);
  return (
    <div
      title={title || name || id}
      className={`${boxClass} rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shrink-0 ${className}`}
    >
      {brand
        ? <img src={brand} alt="" className={`${imgClass} object-contain`} draggable={false} />
        : <span className="text-base leading-none">{icon || '🔧'}</span>}
    </div>
  );
}
