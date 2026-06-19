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
    { to: '/gateway', labelKey: 'nav.gateway', icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]">
        <path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v3A1.5 1.5 0 0 0 3.5 8h3A1.5 1.5 0 0 0 8 6.5v-3A1.5 1.5 0 0 0 6.5 2h-3ZM3.5 12A1.5 1.5 0 0 0 2 13.5v3A1.5 1.5 0 0 0 3.5 18h3A1.5 1.5 0 0 0 8 16.5v-3A1.5 1.5 0 0 0 6.5 12h-3ZM12 3.5A1.5 1.5 0 0 1 13.5 2h3A1.5 1.5 0 0 1 18 3.5v3A1.5 1.5 0 0 1 16.5 8h-3A1.5 1.5 0 0 1 12 6.5v-3ZM13.5 12A1.5 1.5 0 0 0 12 13.5v3A1.5 1.5 0 0 0 13.5 18h3a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 16.5 12h-3Z" />
      </svg>
    )},
    { to: '/providers', labelKey: 'nav.providers', icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]">
        <path d="M7 2a1 1 0 0 0-1 1v1H5a2 2 0 0 0-2 2v2a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4V6a2 2 0 0 0-2-2h-1V3a1 1 0 1 0-2 0v1H8V3a1 1 0 0 0-1-1Z" />
        <path d="M7 14.5v.5a3 3 0 1 0 6 0v-.5H7Z" />
      </svg>
    )},
    { to: '/contribute', labelKey: 'nav.contribute', icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]">
        <path d="M10 2a.75.75 0 0 1 .75.75v5.59l1.95-2.1a.75.75 0 1 1 1.1 1.02l-3.25 3.5a.75.75 0 0 1-1.1 0L6.2 7.26a.75.75 0 1 1 1.1-1.02l1.95 2.1V2.75A.75.75 0 0 1 10 2Z" />
        <path d="M5.273 4.5a1.25 1.25 0 0 0-1.205.918l-1.523 5.52a2.75 2.75 0 0 0-.045.422V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2.64a2.75 2.75 0 0 0-.046-.422l-1.523-5.52A1.25 1.25 0 0 0 14.727 4.5H13.5v1.1l1.32 4.8H14a1 1 0 0 0-.86.49l-.606 1.02a1 1 0 0 1-.86.49h-3.35a1 1 0 0 1-.86-.49l-.605-1.02A1 1 0 0 0 6 10.4h-.82l1.32-4.8V4.5H5.273Z" />
      </svg>
    )},
    { to: '/dashboard', labelKey: 'nav.dashboard', icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]">
        <path d="M15.5 2A1.5 1.5 0 0 0 14 3.5v13a1.5 1.5 0 0 0 1.5 1.5h1a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 16.5 2h-1ZM9.5 6A1.5 1.5 0 0 0 8 7.5v9A1.5 1.5 0 0 0 9.5 18h1a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 10.5 6h-1ZM3.5 10A1.5 1.5 0 0 0 2 11.5v5A1.5 1.5 0 0 0 3.5 18h1A1.5 1.5 0 0 0 6 16.5v-5A1.5 1.5 0 0 0 4.5 10h-1Z" />
      </svg>
    )},
    { to: '/debug', labelKey: 'nav.debug', icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]">
        <path fillRule="evenodd" d="M6.28 5.22a.75.75 0 0 1 0 1.06L2.56 10l3.72 3.72a.75.75 0 0 1-1.06 1.06L.97 10.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Zm7.44 0a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 0 1 0-1.06ZM11.377 2.011a.75.75 0 0 1 .612.867l-2.5 14.5a.75.75 0 0 1-1.478-.255l2.5-14.5a.75.75 0 0 1 .866-.612Z" clipRule="evenodd" />
      </svg>
    )},
  ];
  const profileActive = location.pathname === '/account';
  return (
    <aside className="w-40 flex flex-col pb-5 bg-zinc-50 dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 shrink-0">
      {/* Logo — pt-9 避开 macOS 交通灯；electron-drag 允许拖动窗口 */}
      <div className="electron-drag flex flex-col items-center pt-14 pb-5 px-4 select-none mb-3">
        <img src={logoSvg} alt="Token Bank" className="w-10 h-10 shrink-0 mb-2.5" />
        <p className="text-[13px] font-bold text-gray-900 dark:text-gray-100 leading-tight tracking-tight">Token Bank</p>
        <p className="text-[10.5px] text-gray-400 dark:text-gray-500 leading-tight mt-0.5">{t('sidebar.tagline')}</p>
      </div>

      {/* Nav items */}
      <nav className="electron-no-drag flex-1 flex flex-col gap-0.5 px-2">
        {NAV.map(({ to, icon, labelKey }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              'flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13.5px] transition-colors ' +
              (isActive
                ? 'bg-zinc-200/80 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-zinc-100')
            }
          >
            <span className="w-5 h-5 shrink-0 flex items-center justify-center">{icon}</span>
            <span className="truncate font-medium">{t(labelKey)}</span>
          </NavLink>
        ))}
      </nav>

      {/* User footer */}
      {user && (
        <div className="electron-no-drag px-3 space-y-0.5">
          <button
            onClick={() => navigate('/account')}
            className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors ${
              profileActive
                ? 'bg-zinc-200/80 dark:bg-white/10'
                : 'hover:bg-zinc-200/60 dark:hover:bg-white/5'
            }`}
          >
            <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold uppercase ${profileActive ? 'bg-zinc-700 dark:bg-zinc-500 text-white' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'}`}>
              {(user.nickname || user.email)?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-[11.5px] font-semibold leading-tight truncate ${profileActive ? 'text-zinc-900 dark:text-white' : 'text-zinc-700 dark:text-zinc-200'}`}>{user.nickname}</p>
              {user.credits_balance != null && (
                <p className={`text-[10px] leading-tight truncate mt-0.5 ${profileActive ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
                  💎 {Math.floor(user.credits_balance ?? 0).toLocaleString()} {t('credits.unit')}
                </p>
              )}
            </div>
          </button>
          <button
            onClick={() => navigate('/config')}
            title={t('nav.settings')}
            className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-colors ${
              location.pathname === '/config'
                ? 'bg-zinc-200/80 dark:bg-white/10 text-zinc-900 dark:text-white'
                : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-white/5'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0">
              <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
            </svg>
            <span className="text-[11.5px] font-medium">{t('nav.settings')}</span>
          </button>
        </div>
      )}
    </aside>
  );
}
