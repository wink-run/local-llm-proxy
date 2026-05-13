import React from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store/index';
import { useLang } from '../store/lang';
import logoSvg from '../assets/logo.svg';

export default function Sidebar() {
  const { user } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();
  const location = useLocation();

  const NAV = [
    { to: '/agent',   icon: '⚙️', label: t('nav.agent') },
    { to: '/network', icon: '🌐', label: t('nav.network') },
    { to: '/debug',   icon: '🐛', label: t('nav.debug') },
  ];
  const profileActive = location.pathname === '/';
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

      {/* User footer — profile + settings */}
      {user && (
        <div className={
          'mx-2 flex items-center gap-1 rounded-lg border ' +
          (profileActive
            ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700'
            : 'border-gray-100 dark:border-gray-800')
        }>
          <button
            onClick={() => navigate('/')}
            className="flex-1 min-w-0 px-3 py-2.5 text-left"
          >
            <p className={`text-xs font-medium truncate ${profileActive ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'}`}>{user.nickname}</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{user.email}</p>
          </button>
          <button
            onClick={() => navigate('/config')}
            title={t('nav.settings')}
            className={`shrink-0 px-2.5 py-2.5 rounded-r-lg transition-colors ${
              location.pathname === '/config'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}
    </aside>
  );
}
