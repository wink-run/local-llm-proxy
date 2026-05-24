import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getNetwork, getProfile, listKeys } from '../api/client';
import { getServerUrl } from '../config';

const PROVIDER_META = {
  ollama:          { icon: '🦙', label: 'Ollama',        hint: '自动检测本地实例，无需配置',              keyless: true },
  groq:            { icon: '⚡', label: 'Groq',           hint: '免费申请：console.groq.com',              keyless: false },
  'github-models': { icon: '🐙', label: 'GitHub Models',  hint: '免费调用 GPT-4o、Llama，需 GitHub PAT',   keyless: false },
  'tokenbank-p2p': { icon: '🌐', label: 'P2P 分享网络',  hint: '消耗积分使用社区共享算力',                 keyless: true  },
  openai:          { icon: '🤖', label: 'OpenAI',         hint: '付费 API，支持 GPT-4o / o3 等全系模型',   keyless: false },
  'anthropic-paid':{ icon: '🧬', label: 'Anthropic',      hint: '付费 API，Claude 3.5 / 3.7 等系列',       keyless: false },
};

const DEFAULT_PROVIDERS = [
  { id: 'ollama',          type: 'free', enabled: true,  token: '', base_url: 'http://127.0.0.1:11434/v1', models: [] },
  { id: 'groq',            type: 'free', enabled: false, token: '', base_url: 'https://api.groq.com/openai/v1', models: [] },
  { id: 'github-models',   type: 'free', enabled: false, token: '', base_url: 'https://models.github.azure.com', models: [] },
  { id: 'tokenbank-p2p',   type: 'p2p',  enabled: true,  token: '', base_url: '', models: [] },
  { id: 'openai',          type: 'paid', enabled: false, token: '', base_url: 'https://api.openai.com/v1', models: [] },
  { id: 'anthropic-paid',  type: 'paid', enabled: false, token: '', base_url: 'https://api.anthropic.com/v1', models: [] },
];

const TIER_CONFIG = {
  free: { dot: 'bg-green-500', label: '免费层',  hint: '不消耗额度，优先路由',      cols: 'grid-cols-2' },
  p2p:  { dot: 'bg-blue-500',  label: 'P2P 层',  hint: '消耗少量积分，社区算力',    cols: 'grid-cols-1' },
  paid: { dot: 'bg-amber-400', label: '付费层',  hint: '直接计费，作为最终兜底',    cols: 'grid-cols-2' },
};

function Toggle({ enabled, onChange }) {
  return (
    <div onClick={onChange}
      className={`relative w-9 h-5 rounded-full cursor-pointer transition-colors shrink-0 ${enabled ? 'bg-blue-600' : 'bg-gray-600'}`}>
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </div>
  );
}

// ── P2P Network Card ──────────────────────────────────────────────────────────

function P2PNetworkCard({ provider, onUpdate }) {
  const navigate   = useNavigate();
  const [network,  setNetwork]  = useState(null);
  const [balance,  setBalance]  = useState(null);
  const [loading,  setLoading]  = useState(true);

  // P2P gateway API key config
  const [showKeyConfig, setShowKeyConfig] = useState(false);
  const [apiKeys,       setApiKeys]       = useState([]);   // [{id, key, note, is_active}]
  const [selectedKey,   setSelectedKey]   = useState('');   // key string currently selected
  const [savedKey,      setSavedKey]      = useState('');   // key string saved in local-config
  const [keySaving,     setKeySaving]     = useState(false);
  const [keySaved,      setKeySaved]      = useState(false);
  const [keysLoading,   setKeysLoading]   = useState(false);

  // Load saved key from local-config, and backend keys when section opens
  useEffect(() => {
    if (!window.electronAPI?.localConfig) return;
    window.electronAPI.localConfig.get().then(cfg => {
      const t = cfg.cloud_config?.token || '';
      setSavedKey(t);
      if (t) setSelectedKey(t);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!showKeyConfig) return;
    setKeysLoading(true);
    listKeys()
      .then(r => {
        const keys = (r.data?.keys || r.data || []).filter(k => k.is_active);
        setApiKeys(keys);
        // Pre-select the already-saved key, or first in list
        if (keys.length > 0 && !keys.some(k => k.key === selectedKey)) {
          setSelectedKey(keys[0].key);
        }
      })
      .catch(() => {})
      .finally(() => setKeysLoading(false));
  }, [showKeyConfig]);

  async function handleSaveKey() {
    if (!window.electronAPI?.localConfig || !selectedKey) return;
    setKeySaving(true);
    try {
      await window.electronAPI.localConfig.setCloudConfig({
        url:   getServerUrl(),
        token: selectedKey,
      });
      setSavedKey(selectedKey);
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 2000);
    } catch (e) {
      alert('保存失败: ' + e.message);
    } finally {
      setKeySaving(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [netRes, profRes] = await Promise.allSettled([getNetwork(), getProfile()]);
        if (cancelled) return;
        if (netRes.status === 'fulfilled') setNetwork(netRes.value.data);
        if (profRes.status === 'fulfilled') setBalance(profRes.value.data?.credits_balance ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Aggregate per-model stats from worker list
  const modelStats = React.useMemo(() => {
    if (!network?.workers) return [];
    const map = {};
    for (const w of network.workers) {
      for (const m of (w.models || [])) {
        if (!map[m]) map[m] = { name: m, nodes: 0, totalLatency: 0, latencyCount: 0, activeReqs: 0 };
        map[m].nodes++;
        if (w.avg_latency_ms > 0) {
          map[m].totalLatency += w.avg_latency_ms;
          map[m].latencyCount++;
        }
        map[m].activeReqs += w.active_requests || 0;
      }
    }
    return Object.values(map).sort((a, b) => b.nodes - a.nodes);
  }, [network]);

  const totalNodes = network?.summary?.online_workers ?? 0;

  function ModelDot({ m }) {
    if (m.nodes === 0) return <span className="w-2 h-2 rounded-full bg-gray-600 shrink-0" />;
    if (m.activeReqs > m.nodes * 0.8) return <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />;
    return <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />;
  }

  function ModelSub({ m }) {
    if (m.nodes === 0) return <span className="text-gray-600">暂不可用</span>;
    const avgS = m.latencyCount > 0 ? (m.totalLatency / m.latencyCount / 1000).toFixed(1) : null;
    const busy = m.activeReqs > m.nodes * 0.8;
    return (
      <>
        <span>{m.nodes} 节点</span>
        {busy
          ? <span className="text-amber-600 dark:text-amber-400"> · 繁忙</span>
          : avgS ? <span> · avg {avgS}s</span> : null}
      </>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base shrink-0">🌐</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">P2P 分享网络</span>
              {provider.enabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400 border border-green-300 dark:border-green-800/50">
                  ● 运行中
                </span>
              )}
            </div>
            <Toggle enabled={provider.enabled} onChange={() => onUpdate('tokenbank-p2p', { enabled: !provider.enabled })} />
          </div>
          {!loading && (
            <p className="text-xs text-gray-500 mt-1">
              {balance !== null ? `余额 ${Math.round(balance)} 积分` : ''}
              {balance !== null && totalNodes > 0 ? ' · ' : ''}
              {totalNodes > 0 ? `网络节点 ${totalNodes}` : '获取节点中…'}
            </p>
          )}
          {loading && <p className="text-xs text-gray-600 mt-1">加载中…</p>}
        </div>
      </div>

      {/* Model grid */}
      {provider.enabled && (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              当前可用模型 <span className="text-gray-700">· 社区节点提供</span>
            </span>
            <button onClick={() => navigate('/network')}
              className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 flex items-center gap-1">
              🌐 全球网络 →
            </button>
          </div>
          {modelStats.length === 0 && !loading ? (
            <p className="text-xs text-gray-600 py-2">暂无在线节点</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {(modelStats.length > 0 ? modelStats : Array(4).fill(null)).map((m, i) => (
                m ? (
                  <div key={m.name} className="bg-gray-100 dark:bg-gray-800 border border-gray-300/50 dark:border-gray-700/50 rounded-xl px-3 py-2.5 flex items-center gap-2.5">
                    <ModelDot m={m} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{m.name}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        <ModelSub m={m} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="bg-gray-100/50 dark:bg-gray-800/50 border border-gray-300/30 dark:border-gray-700/30 rounded-xl px-3 py-2.5 h-14 animate-pulse" />
                )
              ))}
            </div>
          )}
        </div>
      )}

      {/* Gateway API Key config */}
      {window.electronAPI?.localConfig && (
        <div className="border-t border-gray-100 dark:border-gray-800">
          <button
            onClick={() => setShowKeyConfig(v => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
          >
            <span className="flex items-center gap-2">
              <span>🔑 网关转发 API Key</span>
              {savedKey
                ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-800/40">已配置</span>
                : <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800/40">未配置</span>
              }
            </span>
            <span className="text-gray-400">{showKeyConfig ? '▲' : '▼'}</span>
          </button>

          {showKeyConfig && (
            <div className="px-4 pb-4 space-y-2">
              <p className="text-[11px] text-gray-500">
                选择一个 API Key 用于本地网关转发 P2P 请求时鉴权，与调试页「全球网络」使用同一批 Key。
              </p>
              {keysLoading ? (
                <p className="text-xs text-gray-400">加载中…</p>
              ) : apiKeys.length === 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-lg px-3 py-2">
                  账户下暂无可用 API Key，请先登录并在「密钥」页创建
                </p>
              ) : (
                <div className="flex gap-2">
                  <select
                    value={selectedKey}
                    onChange={e => { setSelectedKey(e.target.value); setKeySaved(false); }}
                    className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                  >
                    {apiKeys.map(k => (
                      <option key={k.id} value={k.key}>
                        {k.note ? `${k.note}  ·  ` : ''}{k.key.slice(0, 12)}…
                        {k.key === savedKey ? '  ✓ 当前使用' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleSaveKey}
                    disabled={keySaving || !selectedKey || selectedKey === savedKey}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap"
                  >
                    {keySaving ? '保存…' : keySaved ? '✓ 已保存' : '保存'}
                  </button>
                </div>
              )}
              {savedKey && (
                <p className="text-[10px] text-gray-400 font-mono">
                  当前：{savedKey.slice(0, 12)}{'•'.repeat(10)}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ enabled, hasKey, keyless }) {
  if (!enabled) return null;
  const connected = keyless || hasKey;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
      connected
        ? 'bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400 border-green-300 dark:border-green-800/50'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 border-gray-300 dark:border-gray-700'
    }`}>
      {connected ? '● 已启用' : '● 需配置'}
    </span>
  );
}

// Normalize a model entry to {name, type} — handles both string and object formats
function normModel(m) {
  return typeof m === 'string' ? { name: m, type: 'chat' } : { name: m.name, type: m.type || 'chat' };
}

function ModelListEditor({ models = [], onChange, scrollable = false }) {
  const [input,     setInput]     = useState('');
  const [inputType, setInputType] = useState('chat');

  const normalized = models.map(normModel);

  function add() {
    const n = input.trim();
    if (!n || normalized.some(m => m.name === n)) { setInput(''); return; }
    onChange([...normalized, { name: n, type: inputType }]);
    setInput('');
  }

  function remove(name)     { onChange(normalized.filter(m => m.name !== name)); }
  function toggleType(name) {
    onChange(normalized.map(m => m.name === name ? { ...m, type: m.type === 'chat' ? 'image' : 'chat' } : m));
  }

  return (
    <div className="space-y-2">
      {/* existing model tags */}
      {normalized.length > 0 && (
        <div className={scrollable ? 'max-h-36 overflow-y-auto pr-1' : ''}>
          <div className="flex flex-wrap gap-1.5">
            {normalized.map(m => (
              <span key={m.name} className="inline-flex items-center gap-0 text-xs bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg overflow-hidden font-mono">
                <span className="px-2 py-0.5">{m.name}</span>
                <button
                  onClick={() => toggleType(m.name)}
                  title="切换文本/图像"
                  className={`px-1.5 py-0.5 text-[10px] font-sans border-l border-gray-300 dark:border-gray-700 transition-colors ${
                    m.type === 'image'
                      ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-800/60'
                      : 'bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40'
                  }`}>
                  {m.type === 'image' ? '图' : '文'}
                </button>
                <button onClick={() => remove(m.name)} className="px-1.5 py-0.5 border-l border-gray-300 dark:border-gray-700 text-gray-400 hover:text-red-500 dark:hover:text-red-400 leading-none">×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      {/* add input with type picker */}
      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          placeholder="输入模型名，回车添加"
          className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
        <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600 shrink-0 text-[10px] font-medium">
          {[['chat', '文本'], ['image', '图像']].map(([t, label]) => (
            <button key={t} type="button" onClick={() => setInputType(t)}
              className={`px-2 py-1.5 transition-colors ${
                inputType === t
                  ? t === 'chat' ? 'bg-blue-600 text-white' : 'bg-purple-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
              }`}>
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={add}
          disabled={!input.trim()}
          className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 text-xs text-gray-700 dark:text-gray-300 rounded-lg transition-colors whitespace-nowrap"
        >
          添加
        </button>
      </div>
      {normalized.length === 0 && (
        <p className="text-[11px] text-gray-400">未添加模型时，此供给源接受所有模型请求</p>
      )}
    </div>
  );
}

function CustomProviderCard({ provider, onUpdate, onRemove, onTest }) {
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const modelCount = (provider.models || []).length;

  const displayLabel = (() => {
    try { const h = new URL(provider.base_url || '').hostname; return h || '自定义源'; } catch { return '自定义源'; }
  })();

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

  return (
    <div className={`bg-white dark:bg-gray-900 border rounded-2xl overflow-hidden transition-opacity ${
      provider.enabled ? 'border-gray-200 dark:border-gray-800' : 'border-gray-200 dark:border-gray-800 opacity-50'
    }`}>
      <div className="flex items-start gap-3 p-4">
        <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base shrink-0">🔗</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-sm font-medium truncate ${provider.enabled ? 'text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'}`}>
                {displayLabel}
              </span>
              {provider.enabled && provider.base_url && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400 border border-green-300 dark:border-green-800/50 shrink-0">
                  ● 已启用
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {provider.enabled && provider.base_url && (
                <button onClick={handleTest} disabled={testing}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
                  {testing ? '…' : '测试'}
                </button>
              )}
              <Toggle enabled={provider.enabled} onChange={() => onUpdate(provider.id, { enabled: !provider.enabled })} />
              <button onClick={() => onRemove(provider.id)}
                title="删除此供给源"
                className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 text-lg leading-none transition-colors">×</button>
            </div>
          </div>

          {testMsg && (
            <p className={`text-xs mt-1 ${testMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{testMsg}</p>
          )}

          {/* Base URL + Token inputs */}
          <div className="mt-3 space-y-2">
            <input
              value={provider.base_url || ''}
              onChange={e => onUpdate(provider.id, { base_url: e.target.value })}
              onBlur={e => {
                const v = e.target.value.replace(/\/v1\/?$/, '').replace(/\/$/, '');
                if (v !== e.target.value) onUpdate(provider.id, { base_url: v });
              }}
              placeholder="Base URL，如 http://host:3000（无需 /v1）"
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <div className="flex gap-2">
              <input
                value={provider.token || ''}
                onChange={e => onUpdate(provider.id, { token: e.target.value })}
                type={showKey ? 'text' : 'password'}
                placeholder="API Key（可选）"
                autoComplete="off"
                className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
              <button onClick={() => setShowKey(v => !v)}
                className="shrink-0 px-2.5 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Model list */}
      <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">模型列表</span>
          {modelCount > 0
            ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40">{modelCount} 个</span>
            : <span className="text-[10px] text-gray-400">未限制</span>
          }
        </div>
        <ModelListEditor
          models={provider.models || []}
          onChange={models => onUpdate(provider.id, { models })}
          scrollable
        />
      </div>
    </div>
  );
}

function ProviderCard({ provider, onUpdate, onTest }) {
  const [showKey,    setShowKey]    = useState(false);
  const [expanded,   setExpanded]   = useState(false);
  const [testing,    setTesting]    = useState(false);
  const [testMsg,    setTestMsg]    = useState('');


  const meta    = PROVIDER_META[provider.id] || {};
  const isP2P   = provider.type === 'p2p';
  const hasKey  = !!provider.token;
  const configured = meta.keyless || hasKey;
  const modelCount = (provider.models || []).length;

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

  return (
    <div className={`bg-white dark:bg-gray-900 border rounded-2xl overflow-hidden transition-opacity ${
      provider.enabled ? 'border-gray-200 dark:border-gray-800' : 'border-gray-200 dark:border-gray-800 opacity-50'
    }`}>
      <div className="flex items-start gap-3 p-4">
        {/* Icon */}
        <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base shrink-0">
          {meta.icon}
        </div>
        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-sm font-medium ${provider.enabled ? 'text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'}`}>
                {meta.label}
              </span>
              <StatusBadge enabled={provider.enabled} hasKey={hasKey} keyless={meta.keyless} />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!isP2P && provider.enabled && (
                <button onClick={handleTest} disabled={testing}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
                  {testing ? '…' : '测试'}
                </button>
              )}
              <Toggle enabled={provider.enabled} onChange={() => onUpdate(provider.id, { enabled: !provider.enabled })} />
            </div>
          </div>

          {/* Hint / status text */}
          {testMsg ? (
            <p className={`text-xs mt-1 ${testMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{testMsg}</p>
          ) : (
            <p className="text-xs text-gray-500 mt-1">{meta.hint}</p>
          )}

          {/* API key row (configured providers) */}
          {!meta.keyless && !isP2P && configured && !expanded && (
            <div className="flex items-center gap-2 mt-2">
              <code className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded font-mono">
                {hasKey ? provider.token.slice(0, 4) + '•'.repeat(12) : '（未配置）'}
              </code>
              <button onClick={() => setExpanded(true)} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-300">修改</button>
            </div>
          )}

          {/* Inline setup / edit panel */}
          {!meta.keyless && !isP2P && (!configured || expanded) && (
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <input
                  value={provider.token}
                  onChange={e => onUpdate(provider.id, { token: e.target.value })}
                  type={showKey ? 'text' : 'password'}
                  placeholder="粘贴 API Key"
                  autoComplete="off"
                  className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <button onClick={() => setShowKey(v => !v)}
                  className="shrink-0 px-2.5 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
              {expanded && (
                <button onClick={() => setExpanded(false)} className="text-xs text-gray-600 hover:text-gray-600 dark:text-gray-400">取消</button>
              )}
            </div>
          )}

          {/* P2P info */}
          {isP2P && (
            <p className="text-xs text-gray-500 mt-1">
              消耗积分调用社区共享算力，积分不足时自动跳过此层。
            </p>
          )}
        </div>

        {/* "立即启用" button for unconfigured key-requiring providers */}
        {!meta.keyless && !isP2P && !configured && !expanded && (
          <button onClick={() => { setExpanded(true); onUpdate(provider.id, { enabled: true }); }}
            className="shrink-0 text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-blue-600 dark:text-blue-400 border border-gray-300 dark:border-gray-700 rounded-lg transition-colors">
            立即启用 →
          </button>
        )}
      </div>

      {/* Model list section — always visible, scrollable when > 5 models */}
      {!isP2P && (
        <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">模型列表</span>
            {modelCount > 0
              ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40">{modelCount} 个</span>
              : <span className="text-[10px] text-gray-400">未限制</span>
            }
          </div>
          <ModelListEditor
            models={provider.models || []}
            onChange={models => onUpdate(provider.id, { models })}
            scrollable
          />
        </div>
      )}
    </div>
  );
}

export default function Providers() {
  const [providers, setProviders] = useState(DEFAULT_PROVIDERS);
  const [savedMsg,  setSavedMsg]  = useState('');
  // Track the last value written/loaded so we skip the initial load trigger
  const lastSaved = useRef(null);

  useEffect(() => {
    window.electronAPI?.config?.read().then(cfg => {
      let resolved;
      if (cfg?.providers?.length) {
        const defaultIds = new Set(DEFAULT_PROVIDERS.map(p => p.id));
        const mapped = DEFAULT_PROVIDERS.map(def => {
          const saved = cfg.providers.find(p => p.id === def.id);
          return saved ? { ...def, ...saved, models: saved.models || def.models || [] } : def;
        });
        // Preserve any custom (non-default) providers stored in config; normalize base_url
        const custom = cfg.providers.filter(p => !defaultIds.has(p.id)).map(p => ({
          ...p,
          base_url: (p.base_url || '').replace(/\/v1\/?$/, '').replace(/\/$/, ''),
        }));
        resolved = [...mapped, ...custom];
      } else {
        resolved = DEFAULT_PROVIDERS;
      }
      lastSaved.current = resolved;
      setProviders(resolved);
    });
  }, []);

  // Auto-save with 500 ms debounce; skip initial load
  useEffect(() => {
    if (lastSaved.current === null || providers === lastSaved.current) return;
    const timer = setTimeout(async () => {
      try {
        const cfg = (await window.electronAPI?.config?.read()) || {};
        const normalizedProviders = providers.map(p =>
          PROVIDER_META[p.id] ? p : { ...p, base_url: (p.base_url || '').replace(/\/v1\/?$/, '').replace(/\/$/, '') }
        );
        await window.electronAPI?.config?.write({ ...cfg, providers: normalizedProviders });
        lastSaved.current = providers;
        setSavedMsg('已保存');
        setTimeout(() => setSavedMsg(''), 1500);
      } catch {}
    }, 500);
    return () => clearTimeout(timer);
  }, [providers]);

  const updateProvider = useCallback((id, patch) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  const removeProvider = useCallback((id) => {
    setProviders(prev => prev.filter(p => p.id !== id));
  }, []);

  function addCustomProvider() {
    const id = `custom-${Date.now()}`;
    setProviders(prev => [...prev, { id, type: 'paid', enabled: true, token: '', base_url: '', models: [] }]);
  }

  async function testProvider(base_url, token) {
    if (!window.electronAPI?.gateway) return { ok: false, error: 'gateway not ready' };
    return window.electronAPI.gateway.testProvider({ base_url, token });
  }

  const tiers = ['free', 'p2p', 'paid'];

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">供给源</h1>
          <p className="text-sm text-gray-500 mt-0.5">启用供给源后，网关可按场景路由请求</p>
        </div>
        {savedMsg && <span className="text-sm text-green-600 dark:text-green-400">{savedMsg}</span>}
      </div>

      {/* Tier sections */}
      {tiers.map(tier => {
        const cfg   = TIER_CONFIG[tier];
        const items = providers.filter(p => p.type === tier);
        return (
          <section key={tier} className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{cfg.label}</h2>
              <span className="text-xs text-gray-600">{cfg.hint}</span>
            </div>
            <div className={`grid ${cfg.cols} gap-3`}>
              {items.map(p =>
                tier === 'p2p' ? (
                  <P2PNetworkCard key={p.id} provider={p} onUpdate={updateProvider} />
                ) : PROVIDER_META[p.id] ? (
                  <ProviderCard key={p.id} provider={p} onUpdate={updateProvider} onTest={testProvider} />
                ) : (
                  <CustomProviderCard key={p.id} provider={p} onUpdate={updateProvider} onRemove={removeProvider} onTest={testProvider} />
                )
              )}
            </div>
            {tier === 'paid' && (
              <button onClick={addCustomProvider}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 border border-dashed border-gray-300 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-600 rounded-xl px-4 py-2.5 transition-colors w-full">
                <span className="text-base leading-none">+</span> 添加 OpenAI 兼容源
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
