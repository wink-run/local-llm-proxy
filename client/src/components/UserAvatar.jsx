import { resolveMediaUrl } from '../lib/mediaUrl';

const AVATAR_COLORS = [
  'bg-blue-600', 'bg-violet-600', 'bg-emerald-600',
  'bg-orange-500', 'bg-pink-600', 'bg-teal-600',
  'bg-indigo-600', 'bg-rose-600',
];

/** 根据昵称生成稳定的背景色 */
export function avatarColor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** 用户显示名 */
export function userDisplayName(user) {
  return user?.nickname || user?.email?.split('@')[0] || '?';
}

/**
 * 用户头像：优先展示服务端分配的 avatar_url，无则回退首字母。
 * @param {object} user - 含 avatar_url / nickname / email
 * @param {string} className - 尺寸与圆角等 Tailwind 类（默认 w-8 h-8 rounded-full）
 */
export default function UserAvatar({ user, className = 'w-8 h-8 rounded-full' }) {
  const name = userDisplayName(user);
  const initial = name[0]?.toUpperCase() || '?';
  const src = resolveMediaUrl(user?.avatar_url);

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${className} object-cover shrink-0 bg-gray-100 dark:bg-gray-700`}
      />
    );
  }

  return (
    <div className={`${className} ${avatarColor(name)} flex items-center justify-center text-xs font-bold text-white shrink-0`}>
      {initial}
    </div>
  );
}
