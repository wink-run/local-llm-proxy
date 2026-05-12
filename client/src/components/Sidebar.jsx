import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../store/index';
import logoSvg from '../assets/logo.svg';

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
    <aside className="w-44 flex flex-col pb-5 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 shrink-0">
      {/* Logo — pt-9 clears macOS hiddenInset traffic lights (~28px) */}
      <div className="flex items-center gap-2.5 px-4 pt-9 mb-6 select-none">
        <img src={logoSvg} alt="Token Bank" className="w-8 h-8 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-tight">Token Bank</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 leading-tight">token 共享网络</p>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 flex flex-col gap-0.5 px-2">
        {NAV.map(({ to, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ' +
              (isActive
                ? 'bg-blue-600 text-white font-medium'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white')
            }
          >
            <span className="text-base w-5 text-center shrink-0">{icon}</span>
            <span className="truncate">{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* User footer */}
      {user && (
        <div className="px-4 pt-3 border-t border-gray-100 dark:border-gray-800 mt-2">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{user.nickname}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{user.email}</p>
        </div>
      )}
    </aside>
  );
}
