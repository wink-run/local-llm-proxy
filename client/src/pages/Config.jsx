import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, register, getProfile, formatApiError } from '../api/client';
import { useAuth } from '../store/index';
import { useTheme } from '../store/theme';
import { getConfig, getGateway } from '../api/adapter';
import logo from '../assets/logo.svg';
import { useLang } from '../store/lang';
import { SERVER_URL_PLACEHOLDER, normalizeServerBase, syncCloudConfigUrl, bootstrapServerUrl } from '../config';

/** 切换服务器时清除旧 token，避免跨服鉴权失败 */
function persistServerUrl(url) {
  const next = normalizeServerBase(url);
  if (!next) return '';
  const prev = normalizeServerBase(localStorage.getItem('serverUrl') || '');
  if (prev && prev !== next) localStorage.removeItem('token');
  localStorage.setItem('serverUrl', next);
  return next;
}

function Field({ label, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5 uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2.5 text-[13px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:border-blue-400 focus:bg-white dark:focus:bg-zinc-700/50 transition-colors"
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
    <div className="flex rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700">
      {THEMES.map((th) => (
        <button
          key={th.value}
          onClick={() => setTheme(th.value)}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            theme === th.value
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-gray-200 dark:hover:bg-gray-700'
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
    <div className="flex rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700">
      {LANGS.map((l) => (
        <button
          key={l.value}
          onClick={() => setLang(l.value)}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            lang === l.value
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {t(l.labelKey)}
        </button>
      ))}
    </div>
  );
}

export default function Config() {
  const { user, loginSuccess, logout, enterGuest } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();

  const [serverUrl, setServerUrl] = useState(
    () => normalizeServerBase(localStorage.getItem('serverUrl') || '')
  );
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [firstRun, setFirstRun] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then((cfg) => { if (!cfg) setFirstRun(true); });
    bootstrapServerUrl().then((url) => { if (url) setServerUrl(url); });
  }, []);

  async function afterAuth(token) {
    localStorage.setItem('token', token);
    const base = normalizeServerBase(localStorage.getItem('serverUrl') || '');
    await syncCloudConfigUrl(base);
    const profileRes = await getProfile();
    loginSuccess(token, profileRes.data);
    if (window.electronAPI) {
      const current = (await window.electronAPI.config.read()) || {};
      const wsUrl = serverUrl.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws')) + '/ws/worker';
      await window.electronAPI.config.write({ ...current, server_url: wsUrl, worker_key: profileRes.data.worker_key || '' });
    }
    navigate('/');
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    const base = persistServerUrl(serverUrl);
    if (!base) {
      setError(t('config.serverRequired'));
      return;
    }
    setSaving(true);
    try {
      setServerUrl(base);
      const res = await login(email, password);
      await afterAuth(res.data.token);
    } catch (err) {
      localStorage.removeItem('token');
      setError(formatApiError(err, t('config.loginFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    const base = persistServerUrl(serverUrl);
    if (!base) {
      setError(t('config.serverRequired'));
      return;
    }
    setSaving(true);
    try {
      setServerUrl(base);
      const res = await register(email, password, nickname, referralCode);
      await afterAuth(res.data.token);
    } catch (err) {
      localStorage.removeItem('token');
      setError(formatApiError(err, t('config.registerFailed')));
    } finally {
      setSaving(false);
    }
  }

  function switchMode(m) {
    setMode(m);
    setError('');
  }

  function handleLogout() {
    logout();
    navigate('/config');
  }

  function handleGuest() {
    enterGuest();          // 记忆游客模式，进入「中心」（个人源 + 本地用量；社区源/积分需登录）
    navigate('/gateway');
  }

  // Not logged in: show only login form
  if (!user) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <div className="w-full max-w-[320px] px-8 py-10 space-y-5">
          {/* Brand */}
          <div className="flex flex-col items-center gap-3 mb-4">
            <img src={logo} alt="Token Bank" className="w-14 h-14" />
            <div className="text-center">
              <h1 className="text-[17px] font-bold text-zinc-900 dark:text-zinc-100 tracking-tight">Token Bank</h1>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">个人 AI 中枢</p>
            </div>
          </div>

          {firstRun && (
            <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-xl px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
              {t('config.firstRun')}
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5 uppercase tracking-wider">{t('config.serverUrl')}</label>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              onBlur={(e) => {
                const v = persistServerUrl(e.target.value);
                setServerUrl(v);
              }}
              placeholder={SERVER_URL_PLACEHOLDER}
              className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2.5 text-[13px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:border-blue-400 focus:bg-white dark:focus:bg-zinc-700/50 transition-colors"
            />
          </div>

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-3">
              <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
              <Field label={t('config.password')} type="password" value={password} onChange={setPassword} placeholder="••••••" />
              {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
              <button type="submit" disabled={saving}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 disabled:opacity-50 rounded-lg text-[13px] font-semibold text-white transition-colors">
                {saving ? t('config.loggingIn') : t('config.login')}
              </button>
              <p className="text-center text-sm text-zinc-600 dark:text-zinc-500">
                {t('config.noAccount')}
                <button type="button" onClick={() => switchMode('register')}
                  className="text-blue-500 hover:underline ml-1">{t('config.register')}</button>
              </p>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-3">
              <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
              <Field label={t('config.nickname')} type="text" value={nickname} onChange={setNickname} placeholder={t('config.nicknamePh')} />
              <Field label={t('config.password')} type="password" value={password} onChange={setPassword} placeholder={t('config.passwordMin')} />
              <Field label={t('config.referral')} type="text" value={referralCode} onChange={setReferralCode} placeholder={t('config.referralPh')} />
              {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
              <button type="submit" disabled={saving}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 disabled:opacity-50 rounded-lg text-[13px] font-semibold text-white transition-colors">
                {saving ? t('config.registering') : t('config.registerBtn')}
              </button>
              <p className="text-center text-sm text-zinc-600 dark:text-zinc-500">
                {t('config.hasAccount')}
                <button type="button" onClick={() => switchMode('login')}
                  className="text-blue-500 hover:underline ml-1">{t('config.goLogin')}</button>
              </p>
            </form>
          )}

          {/* 不登录，先逛逛（游客模式） */}
          <button type="button" onClick={handleGuest}
            className="w-full text-center text-xs text-zinc-500 dark:text-zinc-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors">
            {t('config.guestEnter')}
          </button>

          {/* Disclaimer */}
          <p className="text-xs text-gray-600 dark:text-gray-600 text-center leading-relaxed pt-2">
            {t('config.footer.beforeLink')}
            <a href="https://github.com/wink-run/local-llm-proxy" target="_blank" rel="noreferrer"
              className="underline hover:text-gray-600 dark:hover:text-zinc-600 dark:text-zinc-400 transition-colors">
              local-llm-proxy
            </a>
            {t('config.footer.afterLink')}
          </p>
        </div>
      </div>
    );
  }

  // Logged in: show full settings
  return <Settings user={user} onLogout={handleLogout} serverUrl={serverUrl} setServerUrl={setServerUrl} />;
}

// ── Toggle helper ─────────────────────────────────────────────────────────────
function Toggle({ enabled, onChange }) {
  return (
    <div onClick={onChange}
      className={`relative w-9 h-5 rounded-full cursor-pointer transition-colors shrink-0 ${enabled ? 'bg-blue-600' : 'bg-gray-600'}`}>
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </div>
  );
}

// ── Row helper ────────────────────────────────────────────────────────────────
function Row({ label, hint, children }) {
  return (
    <div className="flex items-center justify-between px-5 py-4">
      <div>
        <div className="text-sm text-zinc-800 dark:text-zinc-200">{label}</div>
        {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0 ml-4">{children}</div>
    </div>
  );
}

function SelectRow({ label, hint, value, onChange, options }) {
  return (
    <Row label={label} hint={hint}>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 focus:outline-none focus:border-blue-500">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Row>
  );
}

// ── Settings (logged-in view) ─────────────────────────────────────────────────
function Settings({ user, onLogout, serverUrl, setServerUrl }) {
  const { theme, setTheme } = useTheme();
  const { lang, setLang, t } = useLang();

  // Gateway settings
  const [gatewayPort,    setGatewayPort]    = useState(11430);
  const [autoLaunch,     setAutoLaunch]     = useState(false);
  const [reqTimeout,     setReqTimeout]     = useState('60');
  const [maxConcurrent,  setMaxConcurrent]  = useState('8');
  const [logLevel,       setLogLevel]       = useState('warn');

  // Routing settings
  const [retryCount,     setRetryCount]     = useState('1');
  const [healthInterval, setHealthInterval] = useState('60');
  const [keepRouteLogs,  setKeepRouteLogs]  = useState(true);

  // Compression settings（仅内置无损 JSON 压缩）
  const [compressEnabled, setCompressEnabled] = useState(false);

  const [savedMsg, setSavedMsg] = useState('');
  const [saving,   setSaving]   = useState(false);

  // Load saved config on mount
  useEffect(() => {
    getConfig().read().then(cfg => {
      if (!cfg) return;
      if (cfg.gateway_port)      setGatewayPort(cfg.gateway_port);
      if (cfg.auto_launch != null) setAutoLaunch(!!cfg.auto_launch);
      if (cfg.req_timeout)       setReqTimeout(String(cfg.req_timeout));
      if (cfg.max_concurrent)    setMaxConcurrent(String(cfg.max_concurrent));
      if (cfg.log_level)         setLogLevel(cfg.log_level);
      if (cfg.retry_count != null) setRetryCount(String(cfg.retry_count));
      if (cfg.health_interval)   setHealthInterval(String(cfg.health_interval));
      if (cfg.keep_route_logs != null) setKeepRouteLogs(!!cfg.keep_route_logs);
      if (cfg.compress) setCompressEnabled(!!cfg.compress.enabled);
    }).catch(() => {});
    // Read live gateway port from status
    getGateway().status().then(s => {
      if (s?.port) setGatewayPort(s.port);
    }).catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const base = persistServerUrl(serverUrl);
      setServerUrl(base);
      await syncCloudConfigUrl(base);
      const current = (await getConfig().read().catch(() => null)) || {};
      await getConfig().write({
        ...current,
        gateway_port:    Number(gatewayPort),
        auto_launch:     autoLaunch,
        req_timeout:     Number(reqTimeout),
        max_concurrent:  Number(maxConcurrent),
        log_level:       logLevel,
        retry_count:     Number(retryCount),
        health_interval: Number(healthInterval),
        keep_route_logs: keepRouteLogs,
        compress: { enabled: compressEnabled },
      });
      setSavedMsg(t('settings.saved'));
      setTimeout(() => setSavedMsg(''), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setGatewayPort(11430); setAutoLaunch(false); setReqTimeout('60');
    setMaxConcurrent('8'); setLogLevel('warn'); setRetryCount('1');
    setHealthInterval('60'); setKeepRouteLogs(true);
    setCompressEnabled(false);
  }

  const THEME_OPTIONS = [
    { value: 'light',  label: t('theme.light') },
    { value: 'system', label: t('theme.system') },
    { value: 'dark',   label: t('theme.dark') },
  ];

  const LANG_OPTIONS = [
    { value: 'zh', label: t('lang.zh') },
    { value: 'en', label: t('lang.en') },
  ];

  return (
    <div className="px-5 py-5 space-y-5 w-full max-w-4xl mx-auto">

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('settings.title')}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{t('settings.subtitle')}</p>
      </div>

      {/* Gateway section */}
      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.gateway')}</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <Row label={t('settings.port')} hint={t('settings.portHint')}>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={gatewayPort}
                onChange={e => setGatewayPort(e.target.value)}
                className="w-24 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-800 dark:text-zinc-200 text-right font-mono focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-gray-600">{t('settings.restartNote')}</span>
            </div>
          </Row>
          <Row label={t('settings.autoLaunch')} hint={t('settings.autoLaunchHint')}>
            <Toggle enabled={autoLaunch} onChange={() => setAutoLaunch(v => !v)} />
          </Row>
          <SelectRow label={t('settings.reqTimeout')} hint={t('settings.reqTimeoutHint')}
            value={reqTimeout} onChange={setReqTimeout}
            options={[
              { value: '30', label: t('settings.timeout30') },
              { value: '60', label: t('settings.timeout60') },
              { value: '120', label: t('settings.timeout120') },
              { value: '0', label: t('settings.timeoutUnlimited') },
            ]}
          />
          <SelectRow label={t('settings.maxConcurrent')} hint={t('settings.maxConcurrentHint')}
            value={maxConcurrent} onChange={setMaxConcurrent}
            options={[{ value: '4', label: '4' }, { value: '8', label: '8' }, { value: '16', label: '16' }, { value: '32', label: '32' }]}
          />
          <SelectRow label={t('settings.logLevel')} hint={t('settings.logLevelHint')}
            value={logLevel} onChange={setLogLevel}
            options={[
              { value: 'error', label: 'Error' },
              { value: 'warn', label: 'Warn' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' },
            ]}
          />
        </div>
      </div>

      {/* Routing section */}
      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.routing')}</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <SelectRow label={t('settings.retryCount')} hint={t('settings.retryCountHint')}
            value={retryCount} onChange={setRetryCount}
            options={[
              { value: '0', label: t('settings.retry0') },
              { value: '1', label: t('settings.retry1') },
              { value: '2', label: t('settings.retry2') },
              { value: '3', label: t('settings.retry3') },
            ]}
          />
          <SelectRow label={t('settings.healthInterval')} hint={t('settings.healthIntervalHint')}
            value={healthInterval} onChange={setHealthInterval}
            options={[
              { value: '30', label: t('settings.health30') },
              { value: '60', label: t('settings.health60') },
              { value: '300', label: t('settings.health300') },
              { value: '0', label: t('settings.healthOff') },
            ]}
          />
          <Row label={t('settings.keepRouteLogs')} hint={t('settings.keepRouteLogsHint')}>
            <Toggle enabled={keepRouteLogs} onChange={() => setKeepRouteLogs(v => !v)} />
          </Row>
        </div>
      </div>

      {/* Compression section */}
      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.compression')}</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <Row label={t('settings.compressEnabled')} hint={t('settings.compressEnabledHint')}>
            <Toggle enabled={compressEnabled} onChange={() => setCompressEnabled(v => !v)} />
          </Row>
        </div>
      </div>

      {/* Appearance section */}
      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.appearance')}</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <Row label={t('config.theme')} hint={t('settings.themeHint')}>
            <div className="flex rounded-lg overflow-hidden border border-zinc-300 dark:border-zinc-700 text-xs">
              {THEME_OPTIONS.map(o => (
                <button key={o.value} onClick={() => setTheme(o.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${theme === o.value ? 'bg-blue-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label={t('config.lang')} hint={t('config.langHint')}>
            <div className="flex rounded-lg overflow-hidden border border-zinc-300 dark:border-zinc-700 text-xs">
              {LANG_OPTIONS.map(o => (
                <button key={o.value} onClick={() => setLang(o.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${lang === o.value ? 'bg-blue-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </div>

      {/* Server URL */}
      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.server')}</h2>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-gray-500 mb-2">{t('settings.serverUrlHint')}</div>
          <input
            type="text"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            onBlur={async e => {
              const v = persistServerUrl(e.target.value);
              setServerUrl(v);
              await syncCloudConfigUrl(v);
            }}
            placeholder={SERVER_URL_PLACEHOLDER}
            className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
          />
        </div>
      </div>

      {/* Account section */}
      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.account')}</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <Row label={t('config.email')} hint={user.email}>
            <span className="text-xs text-gray-500 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 rounded-lg">
              {user.nickname || '—'}
            </span>
          </Row>
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <div className="text-sm text-red-600 dark:text-red-400">{t('settings.logout')}</div>
              <div className="text-xs text-gray-500 mt-0.5">{t('settings.logoutHint')}</div>
            </div>
            <button onClick={onLogout}
              className="text-xs text-red-600 dark:text-red-400 hover:text-red-300 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-800/50 px-3 py-1.5 rounded-lg transition-colors">
              {t('settings.signOut')}
            </button>
          </div>
        </div>
      </div>

      {/* Save row */}
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors">
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
        <button onClick={handleReset}
          className="px-4 py-2.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-zinc-700 dark:text-zinc-300 text-sm rounded-xl border border-zinc-300 dark:border-zinc-700 transition-colors">
          {t('settings.reset')}
        </button>
        {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">✓ {savedMsg}</span>}
      </div>

      {/* Version footer */}
      <div className="text-xs text-gray-400 dark:text-gray-600 pb-2 flex items-center gap-2">
        <span>Token Bank</span>
        {window.electronAPI?.version && (
          <span className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-500 dark:text-zinc-400">
            v{window.electronAPI.version}
          </span>
        )}
        <span>·</span>
        <a href="https://github.com/wink-run/local-llm-proxy" target="_blank" rel="noreferrer"
          className="hover:text-gray-500 dark:hover:text-gray-400 transition-colors underline">
          GitHub
        </a>
      </div>
    </div>
  );
}
