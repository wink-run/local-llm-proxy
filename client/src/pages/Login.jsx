import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { login, register, getProfile, joinCircle, formatApiError } from '../api/client';
import { useAuth } from '../store/index';
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

/** 仅允许站内相对路径，避免 open redirect */
function safeReturnPath(from) {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return '/';
  return from;
}

/** 登录 / 注册页（与设置页分离，未登录也可从侧栏进入） */
export default function Login() {
  const { user, loginSuccess, enterGuest } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath(location.state?.from);

  // 从邀请链接读取圈子码和推荐码
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const inviteCircleCode = urlParams.get('c') || '';
  const inviteRefCode    = urlParams.get('ref') || '';

  const [serverUrl, setServerUrl] = useState(
    () => normalizeServerBase(localStorage.getItem('serverUrl') || '')
  );
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [referralCode, setReferralCode] = useState(inviteRefCode);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [firstRun, setFirstRun] = useState(false);

  // 已登录则无需停留登录页
  useEffect(() => {
    if (user) navigate(returnTo, { replace: true });
  }, [user, navigate, returnTo]);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then((cfg) => { if (!cfg) setFirstRun(true); });
    bootstrapServerUrl().then((url) => { if (url) setServerUrl(url); });
  }, []);

  async function afterAuth(token, circleResult = null) {
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
    // 有邀请圈子结果时跳转到圈子页并传递提示
    if (circleResult) {
      navigate('/circles', { replace: true, state: { circleResult } });
    } else {
      navigate(returnTo, { replace: true });
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    const base = persistServerUrl(serverUrl);
    if (!base) { setError(t('config.serverRequired')); return; }
    setSaving(true);
    try {
      setServerUrl(base);
      const res = await login(email, password);
      // 已注册用户通过邀请链接登录时，登录后手动调入圈接口
      let circleResult = null;
      if (inviteCircleCode) {
        try {
          const jr = await joinCircle(inviteCircleCode);
          circleResult = jr.data;
        } catch (_) {}
      }
      await afterAuth(res.data.token, circleResult);
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
    if (!base) { setError(t('config.serverRequired')); return; }
    setSaving(true);
    try {
      setServerUrl(base);
      // 注册时服务端自动入圈，circle_code 传给后端
      const res = await register(email, password, nickname, referralCode, inviteCircleCode);
      const circleResult = inviteCircleCode ? {
        ok: res.data.circle_joined || false,
        already_member: false,
        full: res.data.circle_full || false,
      } : null;
      await afterAuth(res.data.token, circleResult);
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

  /** 跳过登录，以游客身份进入主界面 */
  function handleGuest() {
    enterGuest();
    navigate('/gateway', { replace: true });
  }

  if (user) return null;

  return (
    <div className="flex h-full items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <div className="w-full max-w-[360px] px-8 py-10 space-y-5">
        <div className="flex flex-col items-center gap-3 mb-2">
          <img src={logo} alt="Token Bank" className="w-14 h-14" />
          <div className="text-center">
            <h1 className="text-[17px] font-bold text-zinc-900 dark:text-zinc-100 tracking-tight">Token Bank</h1>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">{t('sidebar.tagline')}</p>
          </div>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center leading-relaxed px-1">
          {t('config.loginBenefits')}
        </p>

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
            {inviteCircleCode && (
              <p className="text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2">
                注册后将自动加入邀请圈子 🎉
              </p>
            )}
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

      </div>
    </div>
  );
}
