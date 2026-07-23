import React from 'react';

/** 类型色板:推荐 / 已纳管 / 目录卡片共用(与 Resources 原视觉一致) */
export function typeVisual(type) {
  const map = {
    prompt: {
      icon: '✎',
      tile: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      chip: 'bg-amber-50/80 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    },
    skill: {
      icon: '⚡',
      tile: 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
      chip: 'bg-sky-50/80 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
    },
    assistant: {
      icon: '◇',
      tile: 'bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
      chip: 'bg-violet-50/80 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
    },
  };
  return map[type] || {
    icon: '·',
    tile: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
    chip: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  };
}

/** 优先 metadata.icon(URL/emoji),否则类型默认图标 */
export function AssetLogo({ type, icon }) {
  const visual = typeVisual(type);
  const raw = String(icon || '').trim();
  const isUrl = /^https?:\/\//i.test(raw) || raw.startsWith('data:');
  return (
    <span
      className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl overflow-hidden ${
        isUrl ? 'bg-zinc-50 dark:bg-zinc-800/80 ring-1 ring-zinc-200/70 dark:ring-zinc-700/70' : visual.tile
      }`}
      aria-hidden
    >
      {isUrl ? (
        <img src={raw} alt="" className="h-7 w-7 object-contain" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span className="text-sm leading-none">{raw || visual.icon}</span>
      )}
    </span>
  );
}

export const ASSET_CARD_CLASS =
  'group rounded-xl border border-zinc-200/80 dark:border-zinc-700/70 bg-white dark:bg-zinc-900/85 p-4 '
  + 'shadow-[0_1px_2px_rgba(15,23,42,0.04)] '
  + 'hover:border-zinc-300/90 dark:hover:border-zinc-600 '
  + 'hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.14)] '
  + 'transition-[box-shadow,border-color,transform] duration-150 ease-out '
  + 'active:scale-[0.995]';

export const ASSET_BTN_PRIMARY =
  'tb-press text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/20 '
  + 'hover:bg-blue-500 disabled:opacity-45 disabled:shadow-none transition-colors';

export const ASSET_BTN_MANAGED =
  'text-xs px-3 py-1.5 rounded-lg border border-blue-200/90 dark:border-blue-800/80 '
  + 'bg-blue-50/90 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 '
  + 'disabled:opacity-70 cursor-default';

export const ASSET_BTN_GHOST =
  'tb-press text-xs px-3 py-1.5 rounded-lg border border-zinc-200/90 dark:border-zinc-700 '
  + 'text-zinc-600 dark:text-zinc-300 bg-white/80 dark:bg-zinc-900/60 '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600 '
  + 'disabled:opacity-45 transition-colors';

/**
 * 统一展示名:技能固定用 name/slug(与落库一致);其它优先 display_name。
 */
export function resourceDisplayName(type, item) {
  if (!item) return '';
  if (type === 'skill') return String(item.name || item.slug || '').trim();
  return String(item.display_name || item.name || item.slug || '').trim();
}

/** 统一说明 */
export function resourceDescription(item) {
  return String(item?.description || '').trim();
}

/**
 * 预览正文:优先 content/soul,智能体 JSON 美化;否则回退说明。
 */
export function buildPreviewText(type, item) {
  const soul = String(item?.soul || '').trim();
  let raw = String(item?.content || '').trim() || soul;
  if (!raw) return resourceDescription(item);
  if (type === 'assistant') {
    try {
      const obj = JSON.parse(raw);
      return JSON.stringify(obj, null, 2).slice(0, 8000);
    } catch {
      // soul 纯文本或非 JSON
      return raw.slice(0, 8000);
    }
  }
  return raw.slice(0, 8000);
}

/**
 * 统一资源卡片壳体:图标 + 标题 + 类型徽标 + 说明 + 可选预览区。
 * actions / meta 由调用方注入(投射、匹配理由、安装按钮等)。
 */
export default function ResourceAssetCard({
  type,
  item,
  typeLabel,
  categoryLabel,
  badges,
  description,
  meta,
  actions,
  className = '',
  expanded = false,
  onTogglePreview,
  previewText,
  emptyPreviewLabel = '',
  previewLabel = 'Preview',
  collapseLabel = 'Collapse',
  showPreviewBtn = true,
  layout = 'row', // row=横排按钮; col=竖排; stack=目录/推荐竖排贴底
}) {
  const visual = typeVisual(type);
  const title = resourceDisplayName(type, item);
  const desc = description != null ? String(description).trim() : resourceDescription(item);
  const detail = previewText != null ? String(previewText) : buildPreviewText(type, item);
  const icon = item?.icon || item?.metadata?.icon;
  const stacked = layout === 'stack';
  const actionsCls = stacked
    ? 'flex shrink-0 flex-wrap gap-1.5 justify-end pt-1 mt-auto'
    : layout === 'col'
      ? 'flex shrink-0 flex-col items-end gap-1.5'
      : 'flex shrink-0 flex-wrap gap-1.5 justify-end self-center';

  return (
    <div className={`${ASSET_CARD_CLASS}${stacked ? ' h-full flex flex-col' : ''}${className ? ` ${className}` : ''}`}>
      <div className={`flex gap-4 ${stacked ? 'flex-col flex-1 min-h-0' : 'items-start justify-between'}`}>
        <div className="flex min-w-0 flex-1 gap-3">
          <AssetLogo type={type} icon={icon} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {onTogglePreview ? (
                <button
                  type="button"
                  className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 truncate text-left hover:text-violet-700 dark:hover:text-violet-300 transition-colors"
                  title={previewLabel}
                  onClick={onTogglePreview}
                >
                  {title}
                </button>
              ) : (
                <span className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 truncate" title={title}>
                  {title}
                </span>
              )}
              {typeLabel && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${visual.chip}`}>
                  {typeLabel}
                </span>
              )}
              {categoryLabel && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 whitespace-nowrap">
                  {categoryLabel}
                </span>
              )}
              {badges}
            </div>
            {desc ? (
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 mt-1.5 line-clamp-2">{desc}</p>
            ) : null}
            {meta}
          </div>
        </div>
        {(actions || (showPreviewBtn && onTogglePreview)) ? (
          <div className={actionsCls}>
            {showPreviewBtn && onTogglePreview && (
              <button type="button" className={ASSET_BTN_GHOST} onClick={onTogglePreview}>
                {expanded ? collapseLabel : previewLabel}
              </button>
            )}
            {actions}
          </div>
        ) : null}
      </div>
      {expanded && (
        <pre className="mt-3.5 text-[11px] leading-relaxed p-3.5 rounded-xl border border-zinc-100 dark:border-zinc-800 bg-zinc-50/90 dark:bg-zinc-950 text-zinc-600 dark:text-zinc-300 overflow-x-auto max-h-64 whitespace-pre-wrap">
          {detail || emptyPreviewLabel}
        </pre>
      )}
    </div>
  );
}
