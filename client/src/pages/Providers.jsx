// client/src/pages/Providers.jsx
import React, { useEffect, useState, useCallback } from 'react';

const DEFAULT_PROVIDERS = [
  { id: 'ollama',         label: 'Ollama（本地）',  base_url: 'http://127.0.0.1:11434/v1', token: '', enabled: true,  type: 'free', hint: '自动检测本地 Ollama，无需 API Key' },
  { id: 'groq',           label: 'Groq',            base_url: 'https://api.groq.com/openai/v1',         token: '', enabled: false, type: 'free', hint: '免费申请：console.groq.com' },
  { id: 'github-models',  label: 'GitHub Models',   base_url: 'https://models.github.azure.com',        token: '', enabled: false, type: 'free', hint: '使用 GitHub PAT（Fine-grained）' },
  { id: 'tokenbank-p2p',  label: 'P2P 分享网络',    base_url: '',                                        token: '', enabled: true,  type: 'p2p',  hint: '消耗积分使用社区共享算力' },
  { id: 'openai',         label: 'OpenAI',          base_url: 'https://api.openai.com/v1',              token: '', enabled: false, type: 'paid', hint: '付费 API Key，直接计费' },
  { id: 'anthropic-paid', label: 'Anthropic',       base_url: 'https://api.anthropic.com/v1',           token: '', enabled: false, type: 'paid', hint: '付费 API Key，直接计费' },
];

const TYPE_LABELS = { free: '免费层', p2p: 'P2P 分享网络', paid: '付费层（兜底）' };
const TYPE_ORDER  = ['free', 'p2p', 'paid'];

function ProviderCard({ provider, onUpdate, onTest }) {
  const [showToken, setShowToken] = useState(false);
  const [testing,   setTesting]   = useState(false);
  const [testMsg,   setTestMsg]   = useState('');

  async function handleTest() {
    if (!provider.base_url) { setTestMsg('请先填写 Base URL'); return; }
    setTesting(true); setTestMsg('');
    try {
      const result = await onTest(provider.base_url, provider.token);
      setTestMsg(result.ok ? '✓ 连接成功' : `✗ ${result.error || `HTTP ${result.status}`}`);
    } catch (e) {
      setTestMsg(`✗ ${e.message || '未知错误'}`);
    } finally {
      setTimeout(() => setTestMsg(''), 3000);
      setTesting(false);
    }
  }

  const isOllama = provider.id === 'ollama';
  const isP2P    = provider.type === 'p2p';

  return (
    <div className={`bg-white dark:bg-gray-800 border rounded-2xl p-4 space-y-3 transition-opacity ${provider.enabled ? 'border-gray-100 dark:border-transparent' : 'border-gray-100 dark:border-gray-700 opacity-60'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${provider.enabled ? 'bg-green-400' : 'bg-gray-300 dark:bg-gray-600'}`} />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{provider.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {testMsg && <span className={`text-xs ${testMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{testMsg}</span>}
          {!isP2P && (
            <button onClick={handleTest} disabled={testing}
              className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">
              {testing ? '测试中…' : '测试'}
            </button>
          )}
          <div onClick={() => onUpdate(provider.id, { enabled: !provider.enabled })}
            className={`relative w-9 h-5 rounded-full cursor-pointer transition-colors ${provider.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${provider.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </div>
      </div>

      {provider.hint && <p className="text-xs text-gray-400 dark:text-gray-500">{provider.hint}</p>}

      {!isOllama && !isP2P && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key</label>
            <div className="flex gap-2">
              <input
                value={provider.token}
                onChange={e => onUpdate(provider.id, { token: e.target.value })}
                type={showToken ? 'text' : 'password'}
                placeholder="填写后启用"
                autoComplete="off"
                className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
              />
              <button type="button" onClick={() => setShowToken(v => !v)}
                className="shrink-0 px-2.5 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                {showToken ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isP2P && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          P2P 网络使用你的平台 API Key（在供给源页面右下角创建），消耗积分调用社区算力。
          积分余额不足时自动跳过此层。
        </p>
      )}
    </div>
  );
}

export default function Providers() {
  const [providers, setProviders] = useState(DEFAULT_PROVIDERS);
  const [saving,    setSaving]    = useState(false);
  const [savedMsg,  setSavedMsg]  = useState('');

  useEffect(() => {
    window.electronAPI?.config?.read().then(cfg => {
      if (cfg?.providers?.length) {
        setProviders(prev => prev.map(def => {
          const saved = cfg.providers.find(p => p.id === def.id);
          return saved ? { ...def, ...saved } : def;
        }));
      }
    });
  }, []);

  const updateProvider = useCallback((id, patch) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const cfg = (await window.electronAPI?.config?.read()) || {};
      await window.electronAPI?.config?.write({ ...cfg, providers });
      setSavedMsg('已保存');
      setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  async function testProvider(base_url, token) {
    if (!window.electronAPI?.gateway) return { ok: false, error: 'gateway not ready' };
    return window.electronAPI.gateway.testProvider({ base_url, token });
  }

  const grouped = TYPE_ORDER.map(type => ({
    type,
    label: TYPE_LABELS[type],
    items: providers.filter(p => p.type === type),
  }));

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">供给源</h1>
        <div className="flex items-center gap-3">
          {savedMsg && <span className="text-sm text-green-600 dark:text-green-400">{savedMsg}</span>}
          <button onClick={save} disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors">
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400 -mt-4">
        网关按层级顺序路由请求：免费层 → P2P 层 → 付费层。每层内按配置顺序尝试，失败自动降级。
      </p>

      {/* Routing order visualization */}
      <div className="flex items-center gap-2 text-xs">
        {TYPE_ORDER.map((type, i) => (
          <React.Fragment key={type}>
            <span className={`px-3 py-1.5 rounded-lg font-medium ${
              type === 'free' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' :
              type === 'p2p'  ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' :
                                'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300'
            }`}>{TYPE_LABELS[type]}</span>
            {i < 2 && <span className="text-gray-400">→</span>}
          </React.Fragment>
        ))}
        <span className="text-gray-400 ml-1">（省钱优先顺序）</span>
      </div>

      {grouped.map(({ type, label, items }) => (
        <section key={type} className="space-y-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{label}</h2>
          <div className="space-y-3">
            {items.map(p => (
              <ProviderCard key={p.id} provider={p} onUpdate={updateProvider} onTest={testProvider} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
