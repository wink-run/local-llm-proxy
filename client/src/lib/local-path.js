/**
 * 本地路径识别 / 应用内预览注册（与 React 组件分离，避免 Fast Refresh 失效）
 */

/** 可直接按扩展名判定的文件类型（目录一律走 IPC） */
const PREVIEW_FILE_EXTS = new Set([
  '.md', '.markdown', '.mdx',
  '.txt', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.css', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh',
  '.env', '.toml', '.ini', '.conf', '.cfg', '.rst', '.sql', '.go', '.rs', '.java',
  '.kt', '.swift', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.vue', '.svelte',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
]);

let _openPreview = null;

/** Host 挂载后注册打开函数 */
export function registerLocalFilePreview(fn) {
  _openPreview = typeof fn === 'function' ? fn : null;
}

/** 绝对本地路径（含目录） */
export function looksLikeAbsoluteLocalPath(filePath) {
  const s = String(filePath || '').trim().replace(/^file:\/\//i, '');
  if (s.length < 2 || s.length > 800) return false;
  if (/[\n\r]/.test(s)) return false;
  return /^(\/|~\/|[A-Za-z]:[\\/])/.test(s);
}

/** 已知可预览的文件扩展名（目录不在此列，由 open 时 IPC 判断） */
export function isInAppPreviewablePath(filePath) {
  const s = String(filePath || '').trim().replace(/^file:\/\//i, '');
  if (!looksLikeAbsoluteLocalPath(s)) return false;
  if (/[/\\]$/.test(s)) return true;
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(s);
  if (m) return PREVIEW_FILE_EXTS.has(`.${m[1].toLowerCase()}`);
  return true;
}

/**
 * 打开应用内预览；成功由 Host 处理则返回 true。
 * Host 未挂载时返回 false（调用方可回退系统打开）。
 */
export async function openLocalFilePreview(filePath) {
  if (!_openPreview) return false;
  const p = String(filePath || '').trim().replace(/^file:\/\//i, '');
  if (!p || !looksLikeAbsoluteLocalPath(p)) return false;
  return _openPreview(p);
}

/** 聊天内可点击的本地绝对路径（含扩展名或目录分隔符） */
export function looksLikeLocalPath(s) {
  const t = String(s || '').trim();
  if (t.length < 4 || t.length > 600) return false;
  if (/[\n\r\s]/.test(t)) return false;
  if (/^(https?:|mailto:|file:)/i.test(t)) return false;
  if (!/^(\/|~\/|[A-Za-z]:[\\/])/.test(t)) return false;
  return /\.[A-Za-z0-9]{1,12}$/.test(t) || /[/\\]/.test(t.slice(1));
}

/**
 * 去掉路径捕获末尾的句读标点，但保留合法扩展名（.pptx / .tar.gz 等）。
 * 旧正则把 `.` 当终止符会把扩展名截断到链接外。
 */
export function trimPathEdgePunct(raw) {
  let p = String(raw || '');
  while (p.length > 1 && /[」』"'”)\]}]+$/.test(p)) {
    p = p.slice(0, -1);
  }
  while (p.length > 1) {
    const ch = p[p.length - 1];
    if (!/[.,;:：!?。，；！？]/.test(ch)) break;
    if (/\.[A-Za-z0-9]{1,12}(?:\.[A-Za-z0-9]{1,12})?$/i.test(p)) break;
    p = p.slice(0, -1);
  }
  return p;
}

/** 优先应用内预览；其它类型回退系统默认应用 */
export async function openLocalPath(filePath) {
  const target = String(filePath || '').trim().replace(/^file:\/\//i, '');
  if (!target) return;
  try {
    if (looksLikeAbsoluteLocalPath(target)) {
      const handled = await openLocalFilePreview(target);
      if (handled) return;
    }
  } catch (err) {
    console.warn('[local-path] preview failed:', err);
  }
  const api = typeof window !== 'undefined' ? window.electronAPI?.resource?.openPath : null;
  if (!api) return;
  try {
    await api({ targetPath: target, action: 'open' });
  } catch (err) {
    console.warn('[local-path] openPath failed:', err);
  }
}
