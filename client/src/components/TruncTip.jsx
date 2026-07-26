import React from 'react';

/**
 * 省略文本 + 原生 title 悬浮完整内容
 * @param {boolean} [ellipsis=true] 为 false 时不强制单行 truncate（可配合 line-clamp）
 */
export default function TruncTip({ children, title, className = '', as: Tag = 'div', ellipsis = true }) {
  const tip = title != null && title !== '' ? String(title) : undefined;
  const display = Tag === 'span' ? 'inline-block max-w-full align-bottom' : '';
  return (
    <Tag
      className={`${ellipsis ? 'truncate' : ''} min-w-0 ${display} ${className}`.trim()}
      title={tip}
    >
      {children}
    </Tag>
  );
}
