import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../store/index';

const NAV = [
  { to: '/', icon: '👤', label: '我的账户' },
  { to: '/agent', icon: '⚙️', label: 'Agent' },
  { to: '/network', icon: '🌐', label: '网络' },
  { to: '/debug', icon: '🐛', label: '调试' },
  { to: '/config', icon: '🔧', label: '设置' },
];

export default function Sidebar() {
  const { user } = useAuth();
  return (
    <aside className="w-16 flex flex-col items-center py-6 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 gap-2 shrink-0">
      <div className="mb-4 text-xl select-none">🤖</div>
      {NAV.map(({ to, icon, label }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          className={({ isActive }) =>
            'w-12 h-12 flex items-center justify-center rounded-xl text-xl transition-colors ' +
            (isActive
              ? 'bg-blue-600 text-white'
              : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white')
          }
        >
          {icon}
        </NavLink>
      ))}
      <div className="mt-auto text-xs text-gray-400 dark:text-gray-600 text-center leading-tight px-1 truncate w-full">
        {user?.nickname}
      </div>
    </aside>
  );
}
