const test = require('node:test');
const assert = require('node:assert/strict');

// 前端 ESM 逻辑用同构副本测稳定映射（避免拉 vite）
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

function systemSharerHandle(seed) {
  return SYSTEM_HANDLES[hashSeed(seed) % SYSTEM_HANDLES.length];
}

function handleFromEmail(email) {
  const local = String(email || '').trim().split('@')[0] || '';
  return local.replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '').slice(0, 24);
}

function catalogSharerHandle(item) {
  const meta = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  if (meta.recommender_handle) return String(meta.recommender_handle).replace(/^@+/, '');
  if (meta.user_recommended || meta.recommender_user_id) {
    const fromEmail = handleFromEmail(meta.recommender_email || '');
    if (fromEmail) return fromEmail;
    if (meta.recommender_user_id != null) return `u${meta.recommender_user_id}`;
  }
  return systemSharerHandle(item?.catalogId || item?.name || 'system');
}

test('user recommended → email local handle', () => {
  assert.equal(catalogSharerHandle({
    catalogId: 'user-skill-1-x',
    metadata: { user_recommended: true, recommender_email: 'adam@example.com' },
  }), 'adam');
});

test('system seed → stable random handle', () => {
  const a = catalogSharerHandle({ catalogId: 'code-review-prompt' });
  const b = catalogSharerHandle({ catalogId: 'code-review-prompt' });
  assert.equal(a, b);
  assert.ok(SYSTEM_HANDLES.includes(a));
  assert.notEqual(
    catalogSharerHandle({ catalogId: 'code-review-prompt' }),
    catalogSharerHandle({ catalogId: 'api-design-prompt' }),
  );
});
