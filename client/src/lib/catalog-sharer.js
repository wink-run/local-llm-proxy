/**
 * 社区目录「分享人」展示：
 * - 用户推荐：优先 metadata 里的 handle / nickname / email 本地部分
 * - 系统种子：按 catalogId 稳定映射到伪随机昵称（刷新不变）
 */

const SYSTEM_HANDLES = [
  '云舟', '拾光', '未央', '青禾', '星野', '听潮', '南风', '墨白',
  '远山', '疏影', '清欢', '知夏', '晚晴', '栖梧', '望舒', '既白',
  'nova', 'kai', 'mira', 'leo', 'aria', 'rex', 'luna', 'orin',
  'pixel', 'sage', 'quill', 'ember', 'haze', 'frost', 'echo', 'bloom',
];

function hashSeed(seed) {
  let h = 0;
  const s = String(seed || 'sys');
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 去掉前导 @ */
export function stripAt(handle) {
  return String(handle || '').trim().replace(/^@+/, '');
}

/**
 * 从邮箱取 @ 前本地名；非法则空串
 * @param {string} email
 */
export function handleFromEmail(email) {
  const local = String(email || '').trim().split('@')[0] || '';
  // 仅保留常见 handle 字符，避免整段邮箱污染 UI
  const cleaned = local.replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '');
  return cleaned.slice(0, 24);
}

/**
 * 系统条目：catalogId → 稳定昵称
 * @param {string} seed
 */
export function systemSharerHandle(seed) {
  const i = hashSeed(seed) % SYSTEM_HANDLES.length;
  return SYSTEM_HANDLES[i];
}

/**
 * 社区卡片分享人（不含 @ 前缀）
 * @param {object} item catalog / resource
 */
export function catalogSharerHandle(item) {
  const meta = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const explicit = stripAt(
    meta.recommender_handle
    || meta.recommender_nickname
    || meta.sharer_handle
    || '',
  );
  if (explicit) return explicit;

  // 用户推荐：邮箱本地名
  if (meta.user_recommended || meta.recommender_user_id) {
    const fromEmail = handleFromEmail(meta.recommender_email || '');
    if (fromEmail) return fromEmail;
    if (meta.recommender_user_id != null) return `u${meta.recommender_user_id}`;
  }

  // 系统 / 官方种子：稳定随机名
  const seed = item?.catalogId || item?.catalog_id || item?.name || item?.id || 'system';
  return systemSharerHandle(seed);
}
