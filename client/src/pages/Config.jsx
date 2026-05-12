import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, getProfile } from '../api/client';
import { useAuth } from '../store/index';
import { useTheme } from '../store/theme';

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

const THEMES = [
  { value: 'light', label: '浅色' },
  { value: 'system', label: '跟随系统' },
  { value: 'dark', label: '深色' },
];

function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      {THEMES.map((t) => (
        <button
          key={t.value}
          onClick={() => setTheme(t.value)}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            theme === t.value
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function Config() {
  const { user, loginSuccess, logout } = useAuth();
  const navigate = useNavigate();

  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem('serverUrl') || 'http://localhost:8000'
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [llmUrl, setLlmUrl] = useState('');
  const [llmToken, setLlmToken] = useState('');
  const [models, setModels] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [firstRun, setFirstRun] = useState(false);

  // Load existing agent config into form fields
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then((cfg) => {
      if (!cfg) { setFirstRun(true); return; }
      setLlmUrl(cfg.llm_base_url || '');
      setLlmToken(cfg.llm_token || '');
      setModels((cfg.models || []).join(', '));
      setNodeName(cfg.name || '');
      setAutoStart(!!cfg.auto_start);
    });
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

      // Write worker_key + agent config to ~/.llm-agent/config.json
      if (window.electronAPI) {
        const current = (await window.electronAPI.config.read()) || {};
        const wsUrl = serverUrl.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws')) + '/ws/worker';
        await window.electronAPI.config.write({
          ...current,
          server_url: wsUrl,
          worker_key: profileRes.data.worker_key || '',
          llm_base_url: llmUrl || current.llm_base_url || '',
          llm_token: llmToken !== '' ? llmToken : (current.llm_token || ''),
          models: models
            ? models.split(',').map((m) => m.trim()).filter(Boolean)
            : (current.models || []),
          name: nodeName || current.name || '',
        });
      }

      navigate('/');
    } catch (err) {
      localStorage.removeItem('token');
      setError(err.response?.data?.detail || '登录失败，请检查邮箱和密码');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAgentConfig() {
    if (!window.electronAPI) { alert('仅在 Electron 环境下可保存 Agent 配置'); return; }
    const current = (await window.electronAPI.config.read()) || {};
    const wsUrl = serverUrl.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws')) + '/ws/worker';
    await window.electronAPI.config.write({
      ...current,
      server_url: wsUrl,
      llm_base_url: llmUrl,
      llm_token: llmToken,
      models: models.split(',').map((m) => m.trim()).filter(Boolean),
      name: nodeName,
      auto_start: autoStart,
    });
    localStorage.setItem('serverUrl', serverUrl);
    alert('Agent 配置已保存');
  }

  function handleLogout() {
    logout();
    navigate('/config');
  }

  return (
    <div className="max-w-lg mx-auto p-8 space-y-8">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">设置</h1>

      {firstRun && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-xl px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
          首次使用，请先配置服务器地址并登录账户。
        </div>
      )}

      {/* Server URL */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">服务器</h2>
        <Field
          label="服务端地址 (HTTP/HTTPS)"
          value={serverUrl}
          onChange={setServerUrl}
          placeholder="http://your-vps:8000"
        />
      </section>

      {/* Account */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">账户</h2>
        {user ? (
          <div className="flex items-center justify-between bg-gray-100 dark:bg-gray-800 rounded-xl p-4">
            <div>
              <p className="text-gray-900 dark:text-gray-100 font-medium">{user.nickname}</p>
              <p className="text-gray-500 dark:text-gray-400 text-sm">{user.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded-lg text-sm text-white transition-colors"
            >
              退出登录
            </button>
          </div>
        ) : (
          <form onSubmit={handleLogin} className="space-y-3">
            <Field label="邮箱" type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
            <Field label="密码" type="password" value={password} onChange={setPassword} placeholder="••••••" />
            {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {saving ? '登录中…' : '登录'}
            </button>
          </form>
        )}
      </section>

      {/* Agent config */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">Agent 配置（贡献者）</h2>
        <Field
          label="本地 LLM 地址"
          value={llmUrl}
          onChange={setLlmUrl}
          placeholder="http://localhost:11434"
        />
        <Field
          label="LLM Token（可选）"
          type="password"
          value={llmToken}
          onChange={setLlmToken}
          placeholder="无则留空"
        />
        <Field
          label="支持的模型（逗号分隔）"
          value={models}
          onChange={setModels}
          placeholder="qwen3-32b,qwen3-7b"
        />
        <Field
          label="节点名称"
          value={nodeName}
          onChange={setNodeName}
          placeholder="留空使用主机名"
        />
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <div
            onClick={() => setAutoStart((v) => !v)}
            className={`relative w-10 h-6 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
          >
            <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-5' : 'translate-x-1'}`} />
          </div>
          <span className="text-sm text-gray-700 dark:text-gray-300">启动应用时自动运行 Agent</span>
        </label>
        <button
          onClick={handleSaveAgentConfig}
          className="w-full py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-100 rounded-lg text-sm font-medium transition-colors"
        >
          保存 Agent 配置
        </button>
      </section>

      {/* Theme */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">主题</h2>
        <ThemeSelector />
      </section>

      {/* Credits */}
      <p className="text-xs text-gray-400 dark:text-gray-600 text-center pt-2">
        基于{' '}
        <a href="https://github.com/wink-run/local-llm-proxy" target="_blank" rel="noreferrer"
          className="underline hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
          local-llm-proxy
        </a>{' '}
        开源项目
      </p>
    </div>
  );
}
