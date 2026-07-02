import React from 'react';
import { resolveMediaUrl } from '../lib/mediaUrl';

const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/** 行内 Markdown */
function renderInline(text) {
  if (!text) return null;
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      parts.push({ type: 'bold', value: token.slice(2, -2) });
    } else if (token.startsWith('*') || token.startsWith('_')) {
      parts.push({ type: 'italic', value: token.slice(1, -1) });
    } else if (token.startsWith('`')) {
      parts.push({ type: 'code', value: token.slice(1, -1) });
    } else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (lm) parts.push({ type: 'link', label: lm[1], href: lm[2] });
      else parts.push({ type: 'text', value: token });
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });

  return parts.map((p, i) => {
    if (p.type === 'bold') return <strong key={i} className="font-semibold">{p.value}</strong>;
    if (p.type === 'italic') return <em key={i}>{p.value}</em>;
    if (p.type === 'code') {
      return (
        <code key={i} className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[0.9em] font-mono">
          {p.value}
        </code>
      );
    }
    if (p.type === 'link') {
      return (
        <a key={i} href={resolveMediaUrl(p.href)} target="_blank" rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline break-all">
          {p.label}
        </a>
      );
    }
    return <React.Fragment key={i}>{p.value}</React.Fragment>;
  });
}

function isBlockStart(line) {
  const t = line.trim();
  return !t
    || /^#{1,4}\s/.test(t)
    || /^[-*+]\s+/.test(t)
    || /^\d+\.\s+/.test(t)
    || t.startsWith('>')
    || /^-{3,}$/.test(t)
    || /^\*{3,}$/.test(t);
}

/** 将文本块解析为 Markdown 块级元素 */
function parseMarkdownBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    const hm = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hm) {
      blocks.push({ type: 'heading', level: hm[1].length, text: hm[2] });
      i++;
      continue;
    }

    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) blocks.push({ type: 'p', text: paraLines.join('\n') });
  }

  return blocks;
}

function renderTextBlock(text, keyPrefix) {
  const blocks = parseMarkdownBlocks(text);
  const headingCls = {
    1: 'text-lg font-bold mt-1',
    2: 'text-base font-bold mt-1',
    3: 'text-sm font-semibold mt-1',
    4: 'text-sm font-medium mt-0.5 text-gray-700 dark:text-gray-300',
  };

  return blocks.map((b, i) => {
    const key = `${keyPrefix}-${i}`;
    if (b.type === 'heading') {
      const cls = headingCls[b.level] || headingCls[3];
      return <div key={key} className={cls}>{renderInline(b.text)}</div>;
    }
    if (b.type === 'hr') {
      return <hr key={key} className="border-gray-200 dark:border-gray-600 my-2" />;
    }
    if (b.type === 'quote') {
      return (
        <blockquote key={key}
          className="border-l-2 border-gray-300 dark:border-gray-600 pl-3 text-sm text-gray-600 dark:text-gray-400 italic">
          {renderInline(b.text)}
        </blockquote>
      );
    }
    if (b.type === 'ul') {
      return (
        <ul key={key} className="list-disc list-inside text-sm space-y-0.5 text-gray-800 dark:text-gray-200">
          {b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ul>
      );
    }
    if (b.type === 'ol') {
      return (
        <ol key={key} className="list-decimal list-inside text-sm space-y-0.5 text-gray-800 dark:text-gray-200">
          {b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ol>
      );
    }
    return (
      <p key={key} className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">
        {renderInline(b.text)}
      </p>
    );
  });
}

/** 圈子消息富媒体展示：Markdown + 图片 */
export default function RichMediaContent({
  content,
  className = '',
  removable = false,
  onRemoveImage,
}) {
  if (!content) return null;

  const segments = [];
  let last = 0;
  let m;
  const re = new RegExp(IMG_RE.source, 'g');
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) segments.push({ type: 'text', value: content.slice(last, m.index) });
    segments.push({ type: 'image', alt: m[1], url: m[2] });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ type: 'text', value: content.slice(last) });
  if (segments.length === 0) segments.push({ type: 'text', value: content });

  return (
    <div className={`space-y-2 leading-relaxed break-words ${className}`}>
      {segments.map((seg, i) => {
        if (seg.type === 'image') {
          return (
            <div key={i} className="relative inline-block max-w-full">
              <a href={resolveMediaUrl(seg.url)} target="_blank" rel="noopener noreferrer" className="block">
                <img
                  src={resolveMediaUrl(seg.url)}
                  alt={seg.alt || 'image'}
                  className="max-w-full max-h-80 rounded-lg border border-gray-100 dark:border-gray-700 object-contain bg-gray-50 dark:bg-gray-900/40"
                  loading="lazy"
                />
              </a>
              {removable && onRemoveImage && (
                <button
                  type="button"
                  onClick={() => onRemoveImage(seg.url)}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white text-sm leading-none hover:bg-black/80"
                >
                  ×
                </button>
              )}
            </div>
          );
        }
        return <React.Fragment key={i}>{renderTextBlock(seg.value, `t${i}`)}</React.Fragment>;
      })}
    </div>
  );
}
