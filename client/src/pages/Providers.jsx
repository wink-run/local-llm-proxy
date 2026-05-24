import React, { useEffect, useState, useCallback } from 'react';
import { getNetwork, getProfile } from '../api/client';

const PROVIDER_META = {
  ollama:          { icon: '🦙', label: 'Ollama',        hint: '自动检测本地实例，无需配置',              keyless: true },
  groq:            { icon: '⚡', label: 'Groq',           hint: '免费申请：console.groq.com',              keyless: false },
  'github-models': { icon: '🐙', label: 'GitHub Models',  hint: '免费调用 GPT-4o、Llama，需 GitHub PAT',   keyless: false },
  'tokenbank-p2p': { icon: '🌐', label: 'P2P 分享网络',  hint: '消耗积分使用社区共享算力',                 keyless: true  },
  openai:          { icon: '🤖', label: 'OpenAI',         hint: '付费 API，支持 GPT-4o / o3 等全系模型',   keyless: false },
  'anthropic-paid':{ icon: '🧬', label: 'Anthropic',      hint: '付费 API，Claude 3.5 / 3.7 等系列',       keyless: false },
};

const DEFAULT_PROVIDERS = [
  { id: 'ollama',          type: 'free', enabled: true,  token: '', base_url: 'http://127.0.0.1:11434/v1' },
  { id: 'groq',            type: 'free', enabled: false, token: '', base_url: 'https://api.groq.com/openai/v1' },
  { id: 'github-models',   type: 'free', enabled: false, token: '', base_url: 'https://models.github.azure.com' },
  { id: 'tokenbank-p2p',   type: 'p2p',  enabled: true,  token: '', base_url: '' },
  { id: 'openai',          type: 'paid', enabled: false, token: '', base_url: 'https://api.openai.com/v1' },
  { id: 'anthropic-paid',  type: 'paid', enabled: false, token: '', base_url: 'https://api.anthropic.com/v1' },
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
  const [network,  setNetwork]  = useState(null);
  const [balance,  setBalance]  = useState(null);
  const [loading,  setLoading]  = useState(true);

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
          ? <span className="text-amber-400"> · 繁忙</span>
          : avgS ? <span> · avg {avgS}s</span> : null}
      </>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <div className="w-9 h-9 rounded-xl bg-gray-800 flex items-center justify-center text-base shrink-0">🌐</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-200">P2P 分享网络</span>
              {provider.enabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-900/50 text-green-400 border border-green-800/50">
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
            <button className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1">
              🌐 全球网络 →
            </button>
          </div>
          {modelStats.length === 0 && !loading ? (
            <p className="text-xs text-gray-600 py-2">暂无在线节点</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {(modelStats.length > 0 ? modelStats : Array(4).fill(null)).map((m, i) => (
                m ? (
                  <div key={m.name} className="bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 flex items-center gap-2.5">
                    <ModelDot m={m} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-200 truncate">{m.name}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        <ModelSub m={m} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="bg-gray-800/50 border border-gray-700/30 rounded-xl px-3 py-2.5 h-14 animate-pulse" />
                )
              ))}
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
        ? 'bg-green-900/50 text-green-400 border-green-800/50'
        : 'bg-gray-800 text-gray-500 border-gray-700'
    }`}>
      {connected ? '● 已启用' : '● 需配置'}
    </span>
  );
}

function ProviderCard({ provider, onUpdate, onTest }) {
  const [showKey,   setShowKey]   = useState(false);
  const [expanded,  setExpanded]  = useState(false);
  const [testing,   setTesting]   = useState(false);
  const [testMsg,   setTestMsg]   = useState('');

  const meta    = PROVIDER_META[provider.id] || {};
  const isP2P   = provider.type === 'p2p';
  const hasKey  = !!provider.token;
  const configured = meta.keyless || hasKey;

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
    <div className={`bg-gray-900 border rounded-2xl overflow-hidden transition-opacity ${
      provider.enabled ? 'border-gray-800' : 'border-gray-800 opacity-50'
    }`}>
      <div className="flex items-start gap-3 p-4">
        {/* Icon */}
        <div className="w-9 h-9 rounded-xl bg-gray-800 flex items-center justify-center text-base shrink-0">
          {meta.icon}
        </div>
        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-sm font-medium ${provider.enabled ? 'text-gray-200' : 'text-gray-400'}`}>
                {meta.label}
              </span>
              <StatusBadge enabled={provider.enabled} hasKey={hasKey} keyless={meta.keyless} />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!isP2P && provider.enabled && (
                <button onClick={handleTest} disabled={testing}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700 disabled:opacity-50 transition-colors">
                  {testing ? '…' : '测试'}
                </button>
              )}
              <Toggle enabled={provider.enabled} onChange={() => onUpdate(provider.id, { enabled: !provider.enabled })} />
            </div>
          </div>

          {/* Hint / status text */}
          {testMsg ? (
            <p className={`text-xs mt-1 ${testMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>{testMsg}</p>
          ) : (
            <p className="text-xs text-gray-500 mt-1">{meta.hint}</p>
          )}

          {/* API key row (configured providers) */}
          {!meta.keyless && !isP2P && configured && !expanded && (
            <div className="flex items-center gap-2 mt-2">
              <code className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded font-mono">
                {hasKey ? provider.token.slice(0, 4) + '•'.repeat(12) : '（未配置）'}
              </code>
              <button onClick={() => setExpanded(true)} className="text-xs text-gray-500 hover:text-gray-300">修改</button>
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
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <button onClick={() => setShowKey(v => !v)}
                  className="shrink-0 px-2.5 text-xs rounded-lg border border-gray-700 bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors">
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
              {expanded && (
                <button onClick={() => setExpanded(false)} className="text-xs text-gray-600 hover:text-gray-400">取消</button>
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
            className="shrink-0 text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-blue-400 border border-gray-700 rounded-lg transition-colors">
            立即启用 →
          </button>
        )}
      </div>
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

  const tiers = ['free', 'p2p', 'paid'];

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">供给源</h1>
          <p className="text-sm text-gray-500 mt-0.5">启用供给源后，网关可按场景路由请求</p>
        </div>
        <div className="flex items-center gap-3">
          {savedMsg && <span className="text-sm text-green-400">{savedMsg}</span>}
          <button onClick={save} disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors">
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>

      {/* Tier sections */}
      {tiers.map(tier => {
        const cfg   = TIER_CONFIG[tier];
        const items = providers.filter(p => p.type === tier);
        return (
          <section key={tier} className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
              <h2 className="text-sm font-semibold text-gray-200">{cfg.label}</h2>
              <span className="text-xs text-gray-600">{cfg.hint}</span>
            </div>
            <div className={`grid ${cfg.cols} gap-3`}>
              {items.map(p => (
                tier === 'p2p'
                  ? <P2PNetworkCard key={p.id} provider={p} onUpdate={updateProvider} />
                  : <ProviderCard key={p.id} provider={p} onUpdate={updateProvider} onTest={testProvider} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
