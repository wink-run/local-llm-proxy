import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, register, getProfile } from '../api/client';
import { useAuth } from '../store/index';
import { useTheme } from '../store/theme';
import { getConfig, getGateway } from '../api/adapter';
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
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-200 dark:hover:bg-gray-700'
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
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-200 dark:hover:bg-gray-700'
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
  }, []);

  async function afterAuth(token) {
    localStorage.setItem('token', token);
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
    setSaving(true);
    try {
      localStorage.setItem('serverUrl', serverUrl);
      const res = await login(email, password);
      await afterAuth(res.data.token);
    } catch (err) {
      localStorage.removeItem('token');
      setError(err.response?.data?.detail || t('config.loginFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      localStorage.setItem('serverUrl', serverUrl);
      const res = await register(email, password, nickname, referralCode);
      await afterAuth(res.data.token);
    } catch (err) {
      localStorage.removeItem('token');
      setError(err.response?.data?.detail || '注册失败，请重试');
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

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-3">
              <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
              <Field label={t('config.password')} type="password" value={password} onChange={setPassword} placeholder="••••••" />
              {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
              <button type="submit" disabled={saving}
                className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors">
                {saving ? t('config.loggingIn') : t('config.login')}
              </button>
              <p className="text-center text-sm text-gray-600 dark:text-gray-500">
                没有账户？
                <button type="button" onClick={() => switchMode('register')}
                  className="text-blue-500 hover:underline ml-1">去注册</button>
              </p>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-3">
              <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
              <Field label="昵称（可选）" type="text" value={nickname} onChange={setNickname} placeholder="你的昵称" />
              <Field label={t('config.password')} type="password" value={password} onChange={setPassword} placeholder="至少 6 位" />
              <Field label="邀请码（可选）" type="text" value={referralCode} onChange={setReferralCode} placeholder="推荐人邀请码" />
              {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
              <button type="submit" disabled={saving}
                className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors">
                {saving ? '注册中…' : '注册'}
              </button>
              <p className="text-center text-sm text-gray-600 dark:text-gray-500">
                已有账户？
                <button type="button" onClick={() => switchMode('login')}
                  className="text-blue-500 hover:underline ml-1">去登录</button>
              </p>
            </form>
          )}

          {/* Disclaimer */}
          <p className="text-xs text-gray-600 dark:text-gray-600 text-center leading-relaxed pt-2">
            {t('config.footer.beforeLink')}
            <a href="https://github.com/wink-run/local-llm-proxy" target="_blank" rel="noreferrer"
              className="underline hover:text-gray-600 dark:hover:text-gray-600 dark:text-gray-400 transition-colors">
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
        <div className="text-sm text-gray-800 dark:text-gray-200">{label}</div>
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
        className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:border-blue-500">
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
    }).catch(() => {});
    // Read live gateway port from status
    getGateway().status().then(s => {
      if (s?.port) setGatewayPort(s.port);
    }).catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      localStorage.setItem('serverUrl', serverUrl);
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
      });
      setSavedMsg('已保存');
      setTimeout(() => setSavedMsg(''), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setGatewayPort(11430); setAutoLaunch(false); setReqTimeout('60');
    setMaxConcurrent('8'); setLogLevel('warn'); setRetryCount('1');
    setHealthInterval('60'); setKeepRouteLogs(true);
  }

  const THEME_OPTIONS = [
    { value: 'light',  label: '浅色' },
    { value: 'system', label: '跟随系统' },
    { value: 'dark',   label: '深色' },
  ];

  return (
    <div className="p-6 space-y-5 max-w-2xl">

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">设置</h1>
        <p className="text-sm text-gray-500 mt-0.5">网关运行参数与偏好配置</p>
      </div>

      {/* Gateway section */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">网关</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <Row label="监听端口" hint="网关 HTTP 服务端口">
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={gatewayPort}
                onChange={e => setGatewayPort(e.target.value)}
                className="w-24 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-800 dark:text-gray-200 text-right font-mono focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-gray-600">需重启生效</span>
            </div>
          </Row>
          <Row label="开机自启" hint="系统启动时自动运行网关">
            <Toggle enabled={autoLaunch} onChange={() => setAutoLaunch(v => !v)} />
          </Row>
          <SelectRow label="请求超时" hint="单次请求最长等待时间"
            value={reqTimeout} onChange={setReqTimeout}
            options={[{value:'30',label:'30 秒'},{value:'60',label:'60 秒'},{value:'120',label:'120 秒'},{value:'0',label:'无限制'}]}
          />
          <SelectRow label="最大并发请求" hint="同时处理的最大请求数"
            value={maxConcurrent} onChange={setMaxConcurrent}
            options={[{value:'4',label:'4'},{value:'8',label:'8'},{value:'16',label:'16'},{value:'32',label:'32'}]}
          />
          <SelectRow label="日志级别" hint="控制台日志详细程度"
            value={logLevel} onChange={setLogLevel}
            options={[{value:'error',label:'Error'},{value:'warn',label:'Warn'},{value:'info',label:'Info'},{value:'debug',label:'Debug'}]}
          />
        </div>
      </div>

      {/* Routing section */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">路由策略</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <SelectRow label="降级重试次数" hint="同一步骤内失败重试次数"
            value={retryCount} onChange={setRetryCount}
            options={[{value:'0',label:'不重试'},{value:'1',label:'重试 1 次'},{value:'2',label:'重试 2 次'},{value:'3',label:'重试 3 次'}]}
          />
          <SelectRow label="健康检测间隔" hint="定期探测供给源可用性"
            value={healthInterval} onChange={setHealthInterval}
            options={[{value:'30',label:'30 秒'},{value:'60',label:'1 分钟'},{value:'300',label:'5 分钟'},{value:'0',label:'关闭'}]}
          />
          <Row label="保留路由日志" hint="每条请求的路由路径记录">
            <Toggle enabled={keepRouteLogs} onChange={() => setKeepRouteLogs(v => !v)} />
          </Row>
        </div>
      </div>

      {/* Appearance section */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">外观</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <Row label="主题" hint="界面颜色主题">
            <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-700 text-xs">
              {THEME_OPTIONS.map(o => (
                <button key={o.value} onClick={() => setTheme(o.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${theme === o.value ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="语言" hint="界面显示语言">
            <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-700 text-xs">
              {[{value:'zh',label:'中文'},{value:'en',label:'English'}].map(o => (
                <button key={o.value} onClick={() => setLang(o.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${lang === o.value ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </div>

      {/* Server URL */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">服务器</h2>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-gray-500 mb-2">Token Bank 服务地址</div>
          <input
            type="text"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            onBlur={e => {
              const v = e.target.value.trim() || DEFAULT_SERVER_URL;
              setServerUrl(v);
              localStorage.setItem('serverUrl', v);
            }}
            placeholder={DEFAULT_SERVER_URL}
            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
          />
        </div>
      </div>

      {/* Account section */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">账号</h2>
        </div>
        <div className="divide-y divide-gray-200/60 dark:divide-gray-800/60">
          <Row label="邮箱" hint={user.email}>
            <span className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-1.5 rounded-lg">
              {user.nickname || '—'}
            </span>
          </Row>
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <div className="text-sm text-red-600 dark:text-red-400">退出登录</div>
              <div className="text-xs text-gray-500 mt-0.5">清除本地凭证</div>
            </div>
            <button onClick={onLogout}
              className="text-xs text-red-600 dark:text-red-400 hover:text-red-300 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-800/50 px-3 py-1.5 rounded-lg transition-colors">
              退出
            </button>
          </div>
        </div>
      </div>

      {/* Save row */}
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors">
          {saving ? '保存中…' : '保存设置'}
        </button>
        <button onClick={handleReset}
          className="px-4 py-2.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm rounded-xl border border-gray-300 dark:border-gray-700 transition-colors">
          重置为默认
        </button>
        {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">✓ {savedMsg}</span>}
      </div>

      {/* Version footer */}
      <div className="text-[10px] text-gray-700 pb-2">
        Token Bank · 本地网关 ·{' '}
        <a href="https://github.com/wink-run/local-llm-proxy" target="_blank" rel="noreferrer"
          className="hover:text-gray-500 transition-colors underline">
          GitHub
        </a>
      </div>
    </div>
  );
}
