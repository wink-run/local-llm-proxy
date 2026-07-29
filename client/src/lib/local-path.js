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

/**
 * 路径边界识别用扩展名（含不可预览的媒体/文档）。
 * 用于把 `.mp4Duration` 这类粘连后缀从路径上剥开。
 */
const KNOWN_PATH_EXTS = new Set([
  ...PREVIEW_FILE_EXTS,
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.wmv',
  '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.rtf', '.pages', '.numbers', '.key',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.rar', '.7z',
  '.dmg', '.pkg', '.iso', '.wasm', '.bin', '.exe', '.dll', '.so', '.dylib',
  '.ttf', '.otf', '.woff', '.woff2', '.icns',
  '.sqlite', '.db', '.psd', '.ai', '.sketch', '.fig',
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

/** 取父目录（文件 → 所在文件夹；已是根则原样） */
export function dirnameLocalPath(filePath) {
  const s = String(filePath || '').trim().replace(/^file:\/\//i, '').replace(/[/\\]+$/, '');
  if (!s) return '';
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i <= 0) return s.startsWith('/') ? '/' : s;
  // Windows 盘符根：C:\foo → C:\
  const parent = s.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || '/';
}

/** 已知可预览的文件扩展名（目录不在此列，由 open 时 IPC 判断） */
export function isInAppPreviewablePath(filePath) {
  const s = String(filePath || '').trim().replace(/^file:\/\//i, '');
  if (!looksLikeAbsoluteLocalPath(s)) return false;
  if (/[/\\]$/.test(s)) return true;
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(s);
  if (m) return PREVIEW_FILE_EXTS.has(`.${m[1].toLowerCase()}`);
  // 无扩展名：按目录/未知入口交给预览 Host
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

/** 聊天内可点击的本地绝对路径（扩展名须已知，或像目录） */
export function looksLikeLocalPath(s) {
  const t = String(s || '').trim();
  if (t.length < 4 || t.length > 600) return false;
  if (/[\n\r\s]/.test(t)) return false;
  if (/^(https?:|mailto:|file:)/i.test(t)) return false;
  if (!/^(\/|~\/|[A-Za-z]:[\\/])/.test(t)) return false;
  if (/[/\\]$/.test(t)) return true;
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(t);
  if (m) return KNOWN_PATH_EXTS.has(`.${m[1].toLowerCase()}`);
  // 无扩展名但有路径分隔 → 视为目录路径
  return /[/\\]/.test(t.slice(1));
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

/**
 * 剥开粘在扩展名后的单词（如 `.mp4Duration` → path + `Duration`）。
 * 在文件名段内先取该位点最长已知扩展名，再判断其后是否粘连。
 * 避免 `.ppt` 误切 `.pptx`、`.doc` 误切 `.docx` 等前缀扩展名问题。
 */
export function splitGluedLocalPath(raw) {
  const cleaned = trimPathEdgePunct(raw);
  if (!cleaned) return { path: '', rest: '' };

  const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  const dir = slash >= 0 ? cleaned.slice(0, slash + 1) : '';
  const name = slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
  // 长扩展名优先（.pptx 先于 .ppt，.markdown 先于 .md）
  const exts = [...KNOWN_PATH_EXTS].sort((a, b) => b.length - a.length);

  for (let i = 0; i < name.length; i += 1) {
    if (name[i] !== '.') continue;
    // 当前 `.` 处只认最长匹配，防止短扩展名吃掉长扩展名的前缀
    let matchedExt = '';
    for (const ext of exts) {
      if (name.slice(i, i + ext.length).toLowerCase() === ext) {
        matchedExt = ext;
        break;
      }
    }
    if (!matchedExt) continue;
    const after = name[i + matchedExt.length];
    // 扩展名已完整结束 → 不是粘连，继续找更靠前的 `.`
    if (!after || !/[A-Za-z\u4e00-\u9fff]/.test(after)) continue;
    const path = dir + name.slice(0, i + matchedExt.length);
    if (looksLikeLocalPath(path)) {
      return { path, rest: cleaned.slice(path.length) };
    }
  }

  return { path: cleaned, rest: '' };
}

/**
 * 优先应用内预览：
 * - 目录 / 可预览文件 → 应用内打开
 * - 其它文件（pptx / mp4 等）→ 系统默认应用打开
 */
export async function openLocalPath(filePath) {
  const target = String(filePath || '').trim().replace(/^file:\/\//i, '');
  if (!target) return;

  // 仅对可预览类型走应用内预览；Office/媒体等交给系统打开
  const preferInAppPreview = (() => {
    if (!looksLikeAbsoluteLocalPath(target)) return false;
    if (/[/\\]$/.test(target)) return true;
    const m = /\.([A-Za-z0-9]{1,12})$/.exec(target);
    if (!m) return true;
    return PREVIEW_FILE_EXTS.has(`.${m[1].toLowerCase()}`);
  })();

  if (preferInAppPreview) {
    try {
      const handled = await openLocalFilePreview(target);
      if (handled) return;
    } catch (err) {
      console.warn('[local-path] preview failed:', err);
    }
  }

  const api = typeof window !== 'undefined' ? window.electronAPI?.resource?.openPath : null;
  if (!api) return;
  try {
    // action=open：用默认应用打开文件（聊天里点 .pptx 等）
    await api({ targetPath: target, action: 'open' });
  } catch (err) {
    console.warn('[local-path] openPath failed:', err);
  }
}
