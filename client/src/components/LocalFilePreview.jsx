// 游乐场本地路径应用内预览（右侧栏）：文件夹浏览 / Markdown / 文本 / 图片
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownContent } from './RichMediaContent';
import { registerLocalFilePreview } from '../lib/local-path';
import { useLang } from '../store/lang';

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function entryIcon(ent) {
  if (ent.kind === 'dir') return 'DIR';
  const ext = (ent.ext || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'].includes(ext)) return 'IMG';
  if (['.md', '.markdown', '.mdx'].includes(ext)) return 'MD';
  if (['.html', '.htm'].includes(ext)) return 'HTM';
  return 'FILE';
}

/** 挂到游乐场页右侧：文件预览侧栏（可左右拖拽调宽） */
const PREVIEW_WIDTH_KEY = 'debug.preview.sidebarWidth';
const PREVIEW_WIDTH_DEFAULT = 420;
const PREVIEW_WIDTH_MIN = 260;
const PREVIEW_WIDTH_MAX = 900;

function readStoredWidth() {
  try {
    const v = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
    if (Number.isFinite(v) && v >= PREVIEW_WIDTH_MIN && v <= PREVIEW_WIDTH_MAX) return Math.round(v);
  } catch { /* ignore */ }
  return PREVIEW_WIDTH_DEFAULT;
}

function clampPreviewWidth(w) {
  const max = Math.min(PREVIEW_WIDTH_MAX, Math.floor(window.innerWidth * 0.72));
  return Math.max(PREVIEW_WIDTH_MIN, Math.min(max, Math.round(w)));
}

export default function LocalFilePreviewHost() {
  const { t } = useLang();
  // null | { loading, path, error, data, history[] }
  const [state, setState] = useState(null);
  // HTML：渲染 / 源码 切换（默认渲染）
  const [htmlView, setHtmlView] = useState('render');
  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  // 拖拽左边缘：向左拉变宽，向右拉变窄
  const onResizeStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthRef.current;
    setDragging(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      const next = clampPreviewWidth(startW + (startX - ev.clientX));
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setDragging(false);
      try { localStorage.setItem(PREVIEW_WIDTH_KEY, String(widthRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const close = useCallback(() => setState(null), []);

  const loadPath = useCallback(async (filePath, { pushHistory = true, resetHistory = false, historyOverride } = {}) => {
    const api = window.electronAPI?.resource?.previewFile;
    if (!api) return false;

    setState((prev) => {
      let nextHistory = [];
      if (Array.isArray(historyOverride)) nextHistory = historyOverride;
      else if (resetHistory) nextHistory = [];
      else if (pushHistory && prev?.path && prev.path !== filePath) nextHistory = [...(prev.history || []), prev.path];
      else nextHistory = prev?.history || [];
      // 加载中仍保留上一份内容，避免点开不支持文件时丢失目录列表
      return {
        loading: true,
        path: filePath,
        error: null,
        data: resetHistory ? null : (prev?.data || null),
        history: nextHistory,
      };
    });

    try {
      const res = await api({ targetPath: filePath });
      if (!res?.success) {
        // 不支持 / 过大 → 系统打开；若从目录内点开则保持侧栏
        if (res?.error === 'unsupported' || res?.error === 'too_large') {
          try {
            await window.electronAPI?.resource?.openPath?.({ targetPath: filePath, action: 'open' });
          } catch { /* ignore */ }
          setState((prev) => {
            if (prev?.data) {
              const hist = prev.history || [];
              return {
                loading: false,
                path: prev.data.path || prev.path,
                error: null,
                data: prev.data,
                history: hist.length ? hist.slice(0, -1) : hist,
              };
            }
            return null;
          });
          return true;
        }
        setState((prev) => ({
          loading: false,
          path: filePath,
          error: res?.error === 'not_found'
            ? t('debug.preview.notFound')
            : (res?.error || t('debug.preview.failed')),
          data: null,
          history: prev?.history || [],
        }));
        return true;
      }
      setState((prev) => ({
        loading: false,
        path: res.path || filePath,
        error: null,
        data: res,
        history: prev?.history || [],
      }));
      return true;
    } catch (err) {
      setState((prev) => ({
        loading: false,
        path: filePath,
        error: err?.message || t('debug.preview.failed'),
        data: null,
        history: prev?.history || [],
      }));
      return true;
    }
  }, [t]);

  const open = useCallback(async (filePath) => {
    setHtmlView('render');
    return loadPath(filePath, { resetHistory: true });
  }, [loadPath]);

  useEffect(() => {
    registerLocalFilePreview(open);
    return () => registerLocalFilePreview(null);
  }, [open]);

  // 切换到新 HTML 时默认回到渲染视图
  useEffect(() => {
    if (state?.data?.kind === 'html') setHtmlView('render');
  }, [state?.data?.path, state?.data?.kind]);

  useEffect(() => {
    if (!state) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  if (!state) return null;

  const data = state.data;
  const title = data?.name || state.path?.split(/[/\\]/).filter(Boolean).pop() || t('debug.preview.title');

  const openExternal = async () => {
    const p = data?.path || state.path;
    if (!p) return;
    try {
      await window.electronAPI?.resource?.openPath?.({ targetPath: p, action: 'open' });
    } catch { /* ignore */ }
  };

  const reveal = async () => {
    const p = data?.path || state.path;
    if (!p) return;
    try {
      await window.electronAPI?.resource?.openPath?.({ targetPath: p });
    } catch { /* ignore */ }
  };

  const goParent = () => {
    const parent = data?.parent;
    if (!parent || parent === data?.path) return;
    loadPath(parent);
  };

  const goBack = () => {
    const hist = state.history || [];
    if (!hist.length) return;
    const prevPath = hist[hist.length - 1];
    loadPath(prevPath, { historyOverride: hist.slice(0, -1) });
  };

  return (
    <div
      className={`relative shrink-0 flex min-h-0 ${dragging ? 'select-none' : ''}`}
      style={{ width }}
    >
      {/* 左边缘拖拽条：左右移动调整分栏宽度 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={PREVIEW_WIDTH_MIN}
        aria-valuemax={PREVIEW_WIDTH_MAX}
        title={t('debug.preview.resize')}
        onMouseDown={onResizeStart}
        className={`absolute left-0 top-0 bottom-0 z-10 w-1.5 -ml-0.5 cursor-col-resize group
          hover:bg-blue-400/40 ${dragging ? 'bg-blue-500/50' : ''}`}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-200 dark:bg-zinc-700 group-hover:bg-blue-400" />
      </div>

      <aside
        className="w-full flex flex-col min-h-0 min-w-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
        role="complementary"
        aria-label={t('debug.preview.title')}
      >
      {/* 顶栏 */}
      <div className="flex items-start gap-1.5 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-0.5 shrink-0 pt-0.5">
          {(state.history || []).length > 0 && (
            <button
              type="button"
              onClick={goBack}
              className="w-7 h-7 rounded-md text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              title={t('debug.preview.back')}
            >
              ←
            </button>
          )}
          {data?.parent && data.parent !== data.path && (
            <button
              type="button"
              onClick={goParent}
              className="w-7 h-7 rounded-md text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              title={t('debug.preview.parent')}
            >
              ↑
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate">
            {data?.kind === 'directory' ? `📁 ${title}` : title}
          </div>
          <div className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate font-mono" title={state.path}>
            {state.path}
            {data?.size != null ? ` · ${fmtSize(data.size)}` : ''}
            {data?.kind === 'directory' && data.entries
              ? ` · ${t('debug.preview.entryCount', { n: data.entries.length })}`
              : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          className="w-7 h-7 shrink-0 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg leading-none"
          aria-label={t('debug.preview.close')}
        >
          ✕
        </button>
      </div>

      {/* 次级操作 */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-100 dark:border-zinc-800/80 shrink-0 flex-wrap">
        {data?.kind === 'html' && (
          <>
            <button
              type="button"
              onClick={() => setHtmlView('render')}
              className={`text-[11px] px-2 py-0.5 rounded-md ${
                htmlView === 'render'
                  ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                  : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {t('debug.preview.htmlRender')}
            </button>
            <button
              type="button"
              onClick={() => setHtmlView('source')}
              className={`text-[11px] px-2 py-0.5 rounded-md ${
                htmlView === 'source'
                  ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                  : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {t('debug.preview.htmlSource')}
            </button>
            <span className="w-px h-3 bg-zinc-200 dark:bg-zinc-700 mx-0.5" />
          </>
        )}
        <button
          type="button"
          onClick={openExternal}
          className="text-[11px] px-2 py-0.5 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30"
        >
          {t('debug.preview.openExternal')}
        </button>
        <button
          type="button"
          onClick={reveal}
          className="text-[11px] px-2 py-0.5 rounded-md text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          {t('debug.preview.reveal')}
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-auto px-3 py-3">
        {state.loading && !data && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('debug.preview.loading')}</p>
        )}
        {!state.loading && state.error && (
          <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
        )}

        {/* 文件夹列表 */}
        {data?.kind === 'directory' && (
          <div className="space-y-0.5">
            {(data.entries || []).length === 0 && !state.loading && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('debug.preview.emptyDir')}</p>
            )}
            {(data.entries || []).map((ent) => (
              <button
                key={ent.path}
                type="button"
                onClick={() => loadPath(ent.path)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <span className="shrink-0 text-[9px] font-mono tracking-wide text-zinc-400 dark:text-zinc-500 w-7 text-center">{entryIcon(ent)}</span>
                <span className="flex-1 min-w-0 truncate font-mono text-xs text-zinc-800 dark:text-zinc-200">
                  {ent.name}{ent.kind === 'dir' ? '/' : ''}
                </span>
                {ent.kind === 'file' && ent.size != null && (
                  <span className="shrink-0 text-[11px] text-zinc-400">{fmtSize(ent.size)}</span>
                )}
              </button>
            ))}
            {data.truncated && (
              <p className="text-[11px] text-zinc-400 pt-2">{t('debug.preview.truncated')}</p>
            )}
          </div>
        )}

        {data?.kind === 'image' && data.dataUrl && (
          <div className="flex items-center justify-center">
            <img
              src={data.dataUrl}
              alt={title}
              className="max-w-full max-h-[calc(100vh-12rem)] object-contain rounded-lg"
            />
          </div>
        )}
        {data?.kind === 'markdown' && (
          <div className="prose-sm max-w-none">
            <MarkdownContent content={data.content || ''} />
          </div>
        )}
        {data?.kind === 'html' && htmlView === 'source' && (
          <pre className="text-xs font-mono whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-200 m-0">
            {data.content || ''}
          </pre>
        )}
        {data?.kind === 'html' && htmlView === 'render' && (
          <iframe
            title={title}
            srcDoc={data.srcdoc || data.content || ''}
            // 允许脚本（本地幻灯片/卡片常见）；禁止顶层导航跳出
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
            // 拖拽分栏时禁用 iframe 指针，避免抢走 mousemove
            className={`w-full min-h-[calc(100vh-12rem)] h-full border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white ${
              dragging ? 'pointer-events-none' : ''
            }`}
          />
        )}
        {data?.kind === 'text' && (
          <pre className="text-xs font-mono whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-200 m-0">
            {data.content || ''}
          </pre>
        )}
      </div>
      </aside>
    </div>
  );
}
