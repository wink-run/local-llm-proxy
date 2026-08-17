import React, { useEffect, useState } from 'react';
import {
  B64_OMITTED,
  isImageRef,
  resolveImageSrc,
  toImmediateDisplaySrc,
} from '../lib/debug-image-store';

/** undefined=加载中 / ''=缺失 / string=可显示地址 */
export function useResolvedImageSrc(src) {
  const [url, setUrl] = useState(() => {
    if (!src || src === B64_OMITTED) return '';
    if (isImageRef(src)) return undefined;
    return toImmediateDisplaySrc(src);
  });

  useEffect(() => {
    let alive = true;
    if (!src || src === B64_OMITTED) {
      setUrl('');
      return undefined;
    }
    if (isImageRef(src)) {
      setUrl(undefined);
      resolveImageSrc(src).then((u) => {
        if (!alive) return;
        setUrl(!u || u === B64_OMITTED ? '' : u);
      });
      return () => { alive = false; };
    }
    setUrl(toImmediateDisplaySrc(src));
    return undefined;
  }, [src]);

  return url;
}

export function ResolvedDebugImage({ src, alt, className, onClick }) {
  const url = useResolvedImageSrc(src);
  if (url === undefined) {
    return <div className={`${className || ''} bg-zinc-100 dark:bg-zinc-800 animate-pulse`} />;
  }
  if (!url) return null;
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      onClick={onClick ? () => onClick(url) : undefined}
    />
  );
}
