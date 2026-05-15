import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, getProfile } from '../api/client';
import { useAuth } from '../store/index';
import { useTheme } from '../store/theme';
import logo from '../assets/logo.svg';
import { useLang } from '../store/lang';
import { DEFAULT_SERVER_URL } from '../config';

function Field({ label, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}

function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const { t } = useLang();
  const THEMES = [
    { value: 'light',  label: t('theme.light') },
    { value: 'system', label: t('theme.system') },
    { value: 'dark',   label: t('theme.dark') },
  ];
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      {THEMES.map((th) => (
        <button
          key={th.value}
          onClick={() => setTheme(th.value)}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            theme === th.value
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          {th.label}
        </button>
      ))}
    </div>
  );
}

const LANGS = [
  { value: 'zh', labelKey: 'lang.zh' },
  { value: 'en', labelKey: 'lang.en' },
];

function LangSelector() {
  const { lang, setLang, t } = useLang();
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      {LANGS.map((l) => (
        <button
          key={l.value}
          onClick={() => setLang(l.value)}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            lang === l.value
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          {t(l.labelKey)}
        </button>
      ))}
    </div>
  );
}

export default function Config() {
  const { user, loginSuccess, logout } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();

  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem('serverUrl') || DEFAULT_SERVER_URL
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [firstRun, setFirstRun] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then((cfg) => { if (!cfg) setFirstRun(true); });
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      localStorage.setItem('serverUrl', serverUrl);
      const res = await login(email, password);
      const { token } = res.data;
      // Set token before calling getProfile so the interceptor picks it up
      localStorage.setItem('token', token);
      const profileRes = await getProfile();
      loginSuccess(token, profileRes.data);

      // Write server credentials to ~/.llm-agent/config.json
      if (window.electronAPI) {
        const current = (await window.electronAPI.config.read()) || {};
        const wsUrl = serverUrl.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws')) + '/ws/worker';
        await window.electronAPI.config.write({
          ...current,
          server_url: wsUrl,
          worker_key: profileRes.data.worker_key || '',
        });
      }

      navigate('/');
    } catch (err) {
      localStorage.removeItem('token');
      setError(err.response?.data?.detail || t('config.loginFailed'));
    } finally {
      setSaving(false);
    }
  }

  function handleLogout() {
    logout();
    navigate('/config');
  }

  // Not logged in: show only login form
  if (!user) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="w-full max-w-sm px-8 py-10 space-y-6">
          {/* Brand */}
          <div className="flex flex-col items-center gap-2 mb-2">
            <img src={logo} alt="Token Bank" className="w-16 h-16" />
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Token Bank</h1>
          </div>

          {firstRun && (
            <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-xl px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
              {t('config.firstRun')}
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-sm text-gray-500 dark:text-gray-400">{t('config.serverUrl')}</label>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              onBlur={(e) => {
                const v = e.target.value.trim() || DEFAULT_SERVER_URL;
                setServerUrl(v);
                localStorage.setItem('serverUrl', v);
              }}
              placeholder={DEFAULT_SERVER_URL}
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <form onSubmit={handleLogin} className="space-y-3">
            <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
            <Field label={t('config.password')} type="password" value={password} onChange={setPassword} placeholder="••••••" />
            {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {saving ? t('config.loggingIn') : t('config.login')}
            </button>
          </form>

          {/* Disclaimer */}
          <p className="text-xs text-gray-400 dark:text-gray-600 text-center leading-relaxed pt-2">
            {t('config.footer.beforeLink')}
            <a href="https://github.com/wink-run/local-llm-proxy" target="_blank" rel="noreferrer"
              className="underline hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
              local-llm-proxy
            </a>
            {t('config.footer.afterLink')}
          </p>
        </div>
      </div>
    );
  }

  // Logged in: show full settings
  return (
    <div className="max-w-lg mx-auto p-8 space-y-8">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('config.title')}</h1>

      {/* Server URL */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t('config.server')}</h2>
        <div>
          <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1">{t('config.serverUrl')}</label>
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={(e) => {
              const v = e.target.value.trim() || DEFAULT_SERVER_URL;
              setServerUrl(v);
              localStorage.setItem('serverUrl', v);
            }}
            placeholder={DEFAULT_SERVER_URL}
            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      </section>

      {/* Account */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t('config.account')}</h2>
        <div className="flex items-center justify-between bg-gray-100 dark:bg-gray-800 rounded-xl p-4">
          <div>
            <p className="text-gray-900 dark:text-gray-100 font-medium">{user.nickname}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">{user.email}</p>
          </div>
          <button
            onClick={handleLogout}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded-lg text-sm text-white transition-colors"
          >
            {t('config.logout')}
          </button>
        </div>
      </section>

      {/* Theme */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t('config.theme')}</h2>
        <ThemeSelector />
      </section>

      {/* Language */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t('config.lang')}</h2>
        <LangSelector />
      </section>

      {/* 页脚 */}
      <p className="text-xs text-gray-400 dark:text-gray-600 text-center pt-2">
        {t('config.footer.beforeLink')}
        <a href="https://github.com/wink-run/local-llm-proxy" target="_blank" rel="noreferrer"
          className="underline hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
          local-llm-proxy
        </a>
        {t('config.footer.afterLink')}
      </p>
    </div>
  );
}
