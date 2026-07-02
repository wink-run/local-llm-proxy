import React, { useRef, useState } from 'react';
import { useLang } from '../store/lang';
import { uploadCircleMedia } from '../api/client';
import RichMediaContent from './RichMediaContent';

/**
 * 富媒体输入：编辑 / 预览 Tab，Markdown 编辑 + 图片上传/粘贴
 */
export default function RichMediaInput({
  value,
  onChange,
  circleId,
  maxLength = 2000,
  rows = 3,
  placeholder,
  disabled = false,
  autoFocus = false,
  className = '',
}) {
  const { t } = useLang();
  const fileRef = useRef(null);
  const textareaRef = useRef(null);
  const [tab, setTab] = useState('edit'); // 'edit' | 'preview'
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  async function insertImageMarkdown(url, alt = 'image') {
    const snippet = `\n![${alt}](${url})\n`;
    onChange(`${value || ''}${snippet}`.slice(0, maxLength));
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function uploadFile(file) {
    if (!file || !circleId) return;
    if (!file.type.startsWith('image/')) {
      setUploadError(t('circles.detail.mediaTypeError'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError(t('circles.detail.mediaSizeError'));
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const r = await uploadCircleMedia(circleId, file);
      const url = r.data?.url;
      if (!url) throw new Error('no url');
      const alt = file.name.replace(/\.[^.]+$/, '') || 'image';
      await insertImageMarkdown(url, alt);
    } catch (err) {
      setUploadError(err?.response?.data?.detail || err.message || t('circles.detail.uploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  function onPaste(e) {
    if (tab !== 'edit') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) uploadFile(file);
        return;
      }
    }
  }

  const tabBtn = active => (
    `px-3 py-1 text-xs rounded-md transition-colors ${
      active
        ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
    }`
  );

  return (
    <div className="space-y-2">
      {/* Tab + Markdown 标识 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-gray-800/80">
          <button type="button" className={tabBtn(tab === 'edit')} onClick={() => setTab('edit')}>
            {t('circles.detail.tabEdit')}
          </button>
          <button type="button" className={tabBtn(tab === 'preview')} onClick={() => setTab('preview')}>
            {t('circles.detail.tabPreview')}
          </button>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800/50">
          {t('circles.detail.markdownBadge')}
        </span>
      </div>

      {/* 内容区 */}
      <div className={`rounded-lg border border-gray-200 dark:border-gray-600 min-h-[5.5rem] ${className}`}>
        {tab === 'edit' ? (
          <textarea
            ref={textareaRef}
            className="w-full h-full min-h-[5.5rem] rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none border-0"
            style={{ minHeight: `${rows * 1.5 + 1.5}rem` }}
            rows={rows}
            placeholder={placeholder}
            value={value || ''}
            onChange={e => onChange(e.target.value.slice(0, maxLength))}
            onPaste={onPaste}
            disabled={disabled || uploading}
            autoFocus={autoFocus}
          />
        ) : (
          <div className="px-3 py-2.5 min-h-[5.5rem] bg-gray-50 dark:bg-gray-800/60 rounded-lg">
            {value?.trim() ? (
              <RichMediaContent content={value} />
            ) : (
              <p className="text-sm text-gray-400">{t('circles.detail.previewEmpty')}</p>
            )}
          </div>
        )}
      </div>

      {/* 工具栏（编辑 Tab 时显示插入图片） */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {tab === 'edit' && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                disabled={disabled || uploading || !circleId}
                onClick={() => fileRef.current?.click()}
                className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors"
              >
                {uploading ? t('circles.detail.uploading') : t('circles.detail.addImage')}
              </button>
              <span className="text-[11px] text-gray-400 hidden sm:inline">{t('circles.detail.mediaHint')}</span>
            </>
          )}
        </div>
        <span className="text-[11px] text-gray-400 shrink-0">{(value || '').length}/{maxLength}</span>
      </div>
      {uploadError && <p className="text-xs text-red-500">{uploadError}</p>}
    </div>
  );
}
