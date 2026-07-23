import React, { useEffect, useRef, useState } from 'react';
import { resolveMediaUrl } from '../lib/mediaUrl';

const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * 流式正文尚未闭合的 Markdown 标记会把后续字吃进 code/加粗。
 * 软化:补齐未闭合围栏;奇数反引号时暂不按行内 code 解析(改纯文本段)。
 */
export function softenStreamingMarkdown(text) {
  let s = String(text || '');
  if (!s) return s;

  // 未闭合 ``` 围栏:补一个收尾,避免整段被当成代码吞掉后续
  const fenceLines = s.split('\n').filter((ln) => ln.trim().startsWith('```'));
  if (fenceLines.length % 2 === 1) s = `${s}\n\`\`\``;

  // 行内反引号不成对:去掉末尾孤立 `,避免 `foo 吃到句末
  const ticks = (s.match(/`/g) || []).length;
  if (ticks % 2 === 1) {
    const idx = s.lastIndexOf('`');
    if (idx >= 0) s = `${s.slice(0, idx)}${s.slice(idx + 1)}`;
  }

  // 未闭合 ** / __ :去掉最后一个开标签星号对的一半,避免吞字
  const boldStars = (s.match(/\*\*/g) || []).length;
  if (boldStars % 2 === 1) {
    const idx = s.lastIndexOf('**');
    if (idx >= 0) s = `${s.slice(0, idx)}${s.slice(idx + 2)}`;
  }

  return s;
}

/** 是否适合立刻走 Markdown(闭合标记齐全);否则流式期用纯文本更稳 */
export function isMarkdownStable(text) {
  const s = String(text || '');
  if (!s) return true;
  const fences = s.split('\n').filter((ln) => ln.trim().startsWith('```')).length;
  if (fences % 2 === 1) return false;
  if (((s.match(/`/g) || []).length) % 2 === 1) return false;
  if (((s.match(/\*\*/g) || []).length) % 2 === 1) return false;
  return true;
}

/**
 * 流式文本展示:延迟渲染 + 定期用最新内容重绘,修正先前不完整片段造成的错版。
 * live=false 时立即用完整 Markdown。
 */
export function useStableStreamText(raw, {
  live = false,
  debounceMs = 220,
  refreshMs = 700,
} = {}) {
  const [shown, setShown] = useState(() => String(raw || ''));
  const rawRef = useRef(raw);
  rawRef.current = raw;

  useEffect(() => {
    if (!live) {
      setShown(String(raw || ''));
      return undefined;
    }
    const t = setTimeout(() => {
      setShown(String(rawRef.current || ''));
    }, debounceMs);
    return () => clearTimeout(t);
  }, [raw, live, debounceMs]);

  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      const next = String(rawRef.current || '');
      setShown((prev) => (prev === next ? prev : next));
    }, refreshMs);
    return () => clearInterval(id);
  }, [live, refreshMs]);

  return shown;
}

/**
 * 流式安全 Markdown:延迟 + 定期重绘;未闭合标记时先纯文本,稳定后再 MD。
 */
export function StreamMarkdownContent({
  content,
  live = false,
  className = '',
  theme = 'default',
  preferPlainWhileLive = false,
}) {
  const stable = useStableStreamText(content, { live });
  const display = live ? softenStreamingMarkdown(stable) : String(stable || '');
  const usePlain = live && (preferPlainWhileLive || !isMarkdownStable(stable));

  if (!display) return null;

  if (usePlain) {
    return (
      <pre className={`whitespace-pre-wrap break-words text-xs leading-relaxed font-sans m-0 ${className}`}>
        {display}
      </pre>
    );
  }

  return <MarkdownContent content={display} className={className} theme={theme} />;
}

/** 本地绝对路径（含扩展名），用于聊天内点击预览 */
function looksLikeLocalPath(s) {
  const t = String(s || '').trim();
  if (t.length < 4 || t.length > 600) return false;
  if (/[\n\r\s]/.test(t)) return false;
  if (/^(https?:|mailto:|file:)/i.test(t)) return false;
  if (!/^(\/|~\/|[A-Za-z]:[\\/])/.test(t)) return false;
  // 文件产物优先；目录路径也允许（无扩展名但含分隔符）
  return /\.[A-Za-z0-9]{1,12}$/.test(t) || /[/\\]/.test(t.slice(1));
}

/** 优先应用内预览文件夹 / 文本 / 图片；其它类型回退系统默认应用 */
export async function openLocalPath(filePath) {
  const target = String(filePath || '').trim().replace(/^file:\/\//i, '');
  if (!target) return;
  // 动态导入，避免与 LocalFilePreview ↔ MarkdownContent 循环依赖
  try {
    const { looksLikeAbsoluteLocalPath, openLocalFilePreview } = await import('./LocalFilePreview');
    if (looksLikeAbsoluteLocalPath(target)) {
      const handled = await openLocalFilePreview(target);
      if (handled) return;
    }
  } catch (err) {
    console.warn('[RichMedia] preview failed:', err);
  }
  const api = typeof window !== 'undefined' ? window.electronAPI?.resource?.openPath : null;
  if (!api) return;
  try {
    await api({ targetPath: target, action: 'open' });
  } catch (err) {
    console.warn('[RichMedia] openPath failed:', err);
  }
}

/** 可点击本地路径（用 code/span，避免嵌套 button） */
export function PathLink({ path, className, title }) {
  return (
    <code
      role="link"
      tabIndex={0}
      title={title || '点击预览'}
      className={`px-1 py-0.5 rounded text-[0.9em] font-mono cursor-pointer hover:underline break-all ${className}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openLocalPath(path);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          openLocalPath(path);
        }
      }}
    >
      {path}
    </code>
  );
}

/** 纯文本中的本地路径拆成可点击片段 */
function renderTextWithPaths(text, keyPrefix, pathClassName) {
  const s = String(text || '');
  if (!s) return null;
  // 匹配绝对路径：带扩展名文件，或目录（可无扩展名 / 以 / 结尾）
  const re = /(?:^|[\s「『"'(=:：])((?:\/(?:Users|home|tmp|var|opt|private|Volumes)|~\/|[A-Za-z]:[\\/])[^\s`'"<>|]+?)(?=[\s」』"'.,;:：!)\]}]|$)/g;
  const nodes = [];
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(s)) !== null) {
    const full = m[1];
    const start = m.index + (m[0].length - full.length);
    if (start > last) {
      nodes.push(<React.Fragment key={`${keyPrefix}-t${i++}`}>{s.slice(last, start)}</React.Fragment>);
    }
    if (looksLikeLocalPath(full)) {
      nodes.push(<PathLink key={`${keyPrefix}-p${i++}`} path={full} className={pathClassName} />);
    } else {
      nodes.push(<React.Fragment key={`${keyPrefix}-t${i++}`}>{full}</React.Fragment>);
    }
    last = start + full.length;
  }
  if (last < s.length) {
    nodes.push(<React.Fragment key={`${keyPrefix}-t${i++}`}>{s.slice(last)}</React.Fragment>);
  }
  return nodes.length ? nodes : s;
}

/** 行内 Markdown */
function renderInline(text, codeClassName = 'bg-gray-100 dark:bg-gray-800') {
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

  const pathCodeCls = codeClassName.includes('white')
    ? `${codeClassName} text-blue-100`
    : `${codeClassName} text-blue-600 dark:text-blue-400`;

  return parts.map((p, i) => {
    const linkCls = codeClassName.includes('white')
      ? 'text-blue-100 hover:underline break-all'
      : 'text-blue-600 dark:text-blue-400 hover:underline break-all';
    if (p.type === 'bold') return <strong key={i} className="font-semibold">{p.value}</strong>;
    if (p.type === 'italic') return <em key={i}>{p.value}</em>;
    if (p.type === 'code') {
      if (looksLikeLocalPath(p.value)) {
        return <PathLink key={i} path={p.value.trim()} className={pathCodeCls} />;
      }
      return (
        <code key={i} className={`px-1 py-0.5 rounded text-[0.9em] font-mono ${codeClassName}`}>
          {p.value}
        </code>
      );
    }
    if (p.type === 'link') {
      const href = String(p.href || '').trim();
      // file:/// 或裸本地路径的 markdown 链接 → 本地预览
      if (looksLikeLocalPath(href) || /^file:\/\//i.test(href)) {
        const local = href.replace(/^file:\/\//i, '');
        return (
          <span
            key={i}
            role="link"
            tabIndex={0}
            title="点击预览"
            className={`${linkCls} cursor-pointer`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLocalPath(local); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openLocalPath(local);
              }
            }}
          >
            {p.label}
          </span>
        );
      }
      return (
        <a key={i} href={resolveMediaUrl(p.href)} target="_blank" rel="noopener noreferrer"
          className={linkCls}>
          {p.label}
        </a>
      );
    }
    return <React.Fragment key={i}>{renderTextWithPaths(p.value, `tx${i}`, pathCodeCls)}</React.Fragment>;
  });
}

function isBlockStart(line) {
  const t = line.trim();
  return !t
    || /^#{1,4}\s/.test(t)
    || /^[-*+•·▪▫]\s+/.test(t)
    || /^\d+\.\s+/.test(t)
    || /^\|.+\|/.test(t)
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

    // 围栏代码块 ```lang
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

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

    // GFM 表格：| a | b | / |---|---|
    if (/^\|.+\|/.test(trimmed)) {
      const rows = [];
      while (i < lines.length && /^\|.+\|/.test(lines[i].trim())) {
        const row = lines[i].trim();
        i++;
        // 跳过对齐分隔行
        if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(row)) continue;
        const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        if (cells.length) rows.push(cells);
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }

    // 无序列表（含模型常输出的 • · 等）
    if (/^[-*+•·▪▫]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+•·▪▫]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+•·▪▫]\s+/, ''));
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

function renderTextBlock(text, keyPrefix, theme = 'default') {
  const blocks = parseMarkdownBlocks(text);
  const isInv = theme === 'inverted';
  const headingCls = {
    1: `text-lg font-bold mt-1 ${isInv ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`,
    2: `text-base font-bold mt-1 ${isInv ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`,
    3: `text-sm font-semibold mt-1 ${isInv ? 'text-white' : 'text-gray-800 dark:text-gray-200'}`,
    4: `text-sm font-medium mt-0.5 ${isInv ? 'text-white/90' : 'text-gray-700 dark:text-gray-300'}`,
  };
  const bodyCls = isInv ? 'text-white/95' : 'text-gray-800 dark:text-gray-200';
  const quoteCls = isInv
    ? 'border-white/40 text-white/80'
    : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400';
  const hrCls = isInv ? 'border-white/30' : 'border-gray-200 dark:border-gray-600';
  const codeInlineCls = isInv
    ? 'bg-white/15 text-white'
    : 'bg-gray-100 dark:bg-gray-800';

  return blocks.map((b, i) => {
    const key = `${keyPrefix}-${i}`;
    if (b.type === 'heading') {
      const cls = headingCls[b.level] || headingCls[3];
      return <div key={key} className={cls}>{renderInline(b.text, codeInlineCls)}</div>;
    }
    if (b.type === 'code') {
      const trimmedCode = String(b.text || '').trim();
      // 单行本地路径代码块：点击用默认应用预览
      if (looksLikeLocalPath(trimmedCode)) {
        return (
          <pre
            key={key}
            role="link"
            tabIndex={0}
            title="点击预览"
            className="text-xs font-mono overflow-x-auto rounded-lg bg-zinc-900 dark:bg-zinc-950 text-blue-200 px-3 py-2 my-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-words cursor-pointer hover:underline"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLocalPath(trimmedCode); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openLocalPath(trimmedCode);
              }
            }}
          >
            {b.text}
          </pre>
        );
      }
      return (
        <pre key={key}
          className="text-xs font-mono overflow-x-auto rounded-lg bg-zinc-900 dark:bg-zinc-950 text-zinc-100 px-3 py-2 my-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-words">
          {b.text}
        </pre>
      );
    }
    if (b.type === 'hr') {
      return <hr key={key} className={`${hrCls} my-2`} />;
    }
    if (b.type === 'quote') {
      return (
        <blockquote key={key}
          className={`border-l-2 pl-3 text-sm italic ${quoteCls}`}>
          {renderInline(b.text, codeInlineCls)}
        </blockquote>
      );
    }
    if (b.type === 'ul') {
      return (
        <ul key={key} className={`list-disc list-outside pl-5 text-sm space-y-0.5 ${bodyCls}`}>
          {b.items.map((item, j) => <li key={j} className="pl-0.5">{renderInline(item, codeInlineCls)}</li>)}
        </ul>
      );
    }
    if (b.type === 'ol') {
      return (
        <ol key={key} className={`list-decimal list-outside pl-5 text-sm space-y-0.5 ${bodyCls}`}>
          {b.items.map((item, j) => <li key={j} className="pl-0.5">{renderInline(item, codeInlineCls)}</li>)}
        </ol>
      );
    }
    if (b.type === 'table') {
      const [header, ...body] = b.rows;
      const cellCls = isInv
        ? 'border-white/20 px-2 py-1'
        : 'border-zinc-200 dark:border-zinc-600 px-2 py-1';
      const thCls = isInv
        ? `${cellCls} text-left font-semibold bg-white/10`
        : `${cellCls} text-left font-semibold bg-zinc-50 dark:bg-zinc-800/60`;
      return (
        <div key={key} className="overflow-x-auto my-1">
          <table className={`text-xs border-collapse w-full min-w-[12rem] ${bodyCls}`}>
            {header && (
              <thead>
                <tr>
                  {header.map((c, j) => (
                    <th key={j} className={`border ${thCls}`}>
                      {renderInline(c, codeInlineCls)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            {body.length > 0 && (
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((c, j) => (
                      <td key={j} className={`border ${cellCls} align-top`}>
                        {renderInline(c, codeInlineCls)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    }
    return (
      <p key={key} className={`whitespace-pre-wrap text-sm ${bodyCls}`}>
        {renderInline(b.text, codeInlineCls)}
      </p>
    );
  });
}

/** 轻量 Markdown 渲染（标题/列表/表格/引用/代码块/行内样式） */
export function MarkdownContent({ content, className = '', theme = 'default' }) {
  if (!content) return null;
  return (
    <div className={`space-y-1.5 leading-relaxed break-words ${className}`}>
      {renderTextBlock(content, 'md', theme)}
    </div>
  );
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
        return <React.Fragment key={i}>{renderTextBlock(seg.value, `t${i}`, 'default')}</React.Fragment>;
      })}
    </div>
  );
}
