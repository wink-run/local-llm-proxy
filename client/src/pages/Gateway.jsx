import React, { useEffect, useState, useCallback } from 'react';
import { getRates } from '../api/client';
import { getGateway, getLocalConfig, getConfig } from '../api/adapter';

// ── Tier helpers ──────────────────────────────────────────────────────────────

function tierStyle(tier) {
  if (tier === 'p2p')  return 'bg-blue-950/70 border-blue-300 dark:border-blue-800/30 text-blue-300';
  if (tier === 'paid') return 'bg-amber-950/70 border-amber-800/30 text-amber-300';
  return 'bg-green-950/70 border-green-300 dark:border-green-800/30 text-green-300';
}
function tierDot(tier) {
  if (tier === 'p2p')  return 'bg-blue-400';
  if (tier === 'paid') return 'bg-amber-400';
  return 'bg-green-400';
}
function normTier(t) {
  if (t === 'p2p' || t === 'open') return 'p2p';
  if (t === 'paid') return 'paid';
  return 'free';
}

// Short tier label for inline display, e.g. "glm-5.1(p2p)"
const TIER_SHORT = { p2p: 'p2p', free: 'free', paid: 'paid' };

// Resolve step tier: prefer availableModels lookup (most accurate), fallback to stored
function resolveStepTier(stepModel, step, availableModels) {
  const m = availableModels.find(x => x.id === stepModel);
  return m ? m.tier : (step?.tier || 'free');
}

// ── CopyButton ────────────────────────────────────────────────────────────────

function CopyButton({ text, label = '复制', className = '' }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button onClick={copy}
      className={`text-xs px-2.5 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors min-w-[48px] ${className}`}>
      {copied ? '已复制 ✓' : label}
    </button>
  );
}

// ── ModelSelect ───────────────────────────────────────────────────────────────

function ModelSelect({ availableModels, value, onChange }) {
  const freeModels = availableModels.filter(m => m.tier === 'free');
  const p2pModels  = availableModels.filter(m => m.tier === 'p2p');
  const paidModels = availableModels.filter(m => m.tier === 'paid');
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-2.5 py-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500">
      {freeModels.length > 0 && (
        <optgroup label="🟢 免费层">
          {freeModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
        </optgroup>
      )}
      {p2pModels.length > 0 && (
        <optgroup label="🔵 P2P 层">
          {p2pModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
        </optgroup>
      )}
      {paidModels.length > 0 && (
        <optgroup label="🟡 付费层">
          {paidModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
        </optgroup>
      )}
    </select>
  );
}

// ── SceneRouteEditor ──────────────────────────────────────────────────────────

function SceneRouteEditor({ route, availableModels, onSave, onCancel }) {
  const [name, setName]   = useState(route.scene_name || '');
  const [icon, setIcon]   = useState(route.icon || '🔀');
  const [steps, setSteps] = useState(route.steps || []);

  const addStep    = () => setSteps(prev => [...prev, { label: '', model: '', tier: 'free' }]);
  const removeStep = (i) => setSteps(prev => prev.filter((_, idx) => idx !== i));
  const updateStep = (i, modelId) => {
    const m    = availableModels.find(x => x.id === modelId);
    const tier = m ? m.tier : 'free';
    setSteps(prev => prev.map((s, idx) => idx === i ? { label: modelId, model: modelId, tier } : s));
  };

  const freeModels = availableModels.filter(m => m.tier === 'free');
  const p2pModels  = availableModels.filter(m => m.tier === 'p2p');
  const paidModels = availableModels.filter(m => m.tier === 'paid');

  return (
    <div className="border-t border-gray-200/60 dark:border-gray-800/60 bg-gray-50/50 dark:bg-gray-800/20 px-5 py-4 space-y-3">
      <div className="flex gap-2">
        <input value={icon} onChange={e => setIcon(e.target.value)}
          className="w-10 bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none"
          maxLength={2} />
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="场景名称，如：Claude Code"
          className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500" />
      </div>
      <div className="text-xs text-gray-500 font-medium">
        降级链 <span className="text-gray-400 dark:text-gray-500">· 失败时按顺序尝试下一步</span>
      </div>
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2 group">
            <span className="text-[10px] text-gray-400 w-4 text-right shrink-0">{i + 1}</span>
            <select value={step.model} onChange={e => updateStep(i, e.target.value)}
              className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500">
              <option value="">-- 选择模型 --</option>
              {freeModels.length > 0 && <optgroup label="🟢 免费层">{freeModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>}
              {p2pModels.length  > 0 && <optgroup label="🔵 P2P 层">{p2pModels.map(m =>  <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>}
              {paidModels.length > 0 && <optgroup label="🟡 付费层">{paidModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>}
            </select>
            <button onClick={() => removeStep(i)}
              className="text-[10px] text-gray-400 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-1">✕</button>
          </div>
        ))}
        {steps.length === 0 && <p className="text-xs text-gray-500">还没有步骤，点击「添加步骤」</p>}
      </div>
      <button onClick={addStep} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ 添加步骤</button>
      <div className="flex gap-2 pt-1">
        <button onClick={onCancel}
          className="text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
          取消
        </button>
        <button onClick={() => onSave({ ...route, scene_name: name, icon, steps })}
          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium transition-colors">
          保存
        </button>
      </div>
    </div>
  );
}

// ── Code snippets ─────────────────────────────────────────────────────────────

function codeSnippet(lang, baseUrl, apiKey, model = 'claude-opus-4-5') {
  switch (lang) {
    case 'curl':
      return `curl ${baseUrl}/messages \\
  -H "x-api-key: ${apiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
    case 'python':
      return `import anthropic

client = anthropic.Anthropic(
    base_url="${baseUrl}",
    api_key="${apiKey}",
)
msg = client.messages.create(
    model="${model}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)`;
    case 'nodejs':
      return `import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: '${baseUrl}',
  apiKey: '${apiKey}',
});
const msg = await client.messages.create({
  model: '${model}',
  maxTokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(msg.content[0].text);`;
    case 'openai':
      return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",
)
resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`;
    case 'curl-oai':
      return `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
    default: return '';
  }
}

// ── KeyConfigPanel ────────────────────────────────────────────────────────────

const CONFIG_TABS = [
  { id: 'curl',     label: 'curl' },
  { id: 'curl-oai', label: 'curl (OAI)' },
  { id: 'python',   label: 'Python' },
  { id: 'nodejs',   label: 'Node.js' },
  { id: 'openai',   label: 'OpenAI SDK' },
  { id: 'auto',     label: '⚡ 自动配置' },
];

function KeyConfigPanel({ apiKey, localBase, model }) {
  const [tab,     setTab]     = useState('curl');
  const [tool,    setTool]    = useState('claude-code');
  const [writeOk, setWriteOk] = useState(false);

  const isRouter = model?.startsWith('llm-router-');
  const envText  = [
    `ANTHROPIC_BASE_URL=${localBase}`,
    `ANTHROPIC_API_KEY=${apiKey}`,
    model ? `ANTHROPIC_MODEL=${model}` : '',
  ].filter(Boolean).join('\n');

  async function handleWrite() {
    try {
      await window.electronAPI?.claude?.configure(localBase, apiKey, []);
      setWriteOk(true);
    } catch (e) {
      alert('写入失败: ' + e.message);
    }
  }

  const isCodeTab = tab !== 'auto';
  const code = isCodeTab ? codeSnippet(tab, localBase, apiKey, model) : '';

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
        {CONFIG_TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setWriteOk(false); }}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}>
            {t.label}
          </button>
        ))}
        {isCodeTab && (
          <>
            <div className="flex-1" />
            <CopyButton text={code} label="复制" className="mx-2 py-1 text-[10px]" />
          </>
        )}
      </div>

      {/* Code snippet */}
      {isCodeTab && (
        <pre className="px-4 py-3 text-[11px] font-mono leading-relaxed text-gray-700 dark:text-gray-300 overflow-x-auto bg-gray-50/30 dark:bg-gray-900/30 whitespace-pre">
          {code}
        </pre>
      )}

      {/* Auto-configure tab */}
      {tab === 'auto' && (
        <div className="p-4 space-y-4">
          {/* Model name badge */}
          {model && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500">模型名称</span>
              <code className={`text-[11px] font-mono px-2 py-0.5 rounded border ${
                isRouter
                  ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800/40 text-purple-600 dark:text-purple-400'
                  : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300'
              }`}>{model}</code>
              <CopyButton text={model} label="复制" className="py-0.5 text-[10px]" />
            </div>
          )}
          <div className="grid grid-cols-4 gap-2">
            {TOOLS.map(t => (
              <button key={t.id} onClick={() => { setTool(t.id); setWriteOk(false); }}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-colors ${
                  tool === t.id
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 hover:border-gray-400 dark:hover:border-gray-600'
                }`}>
                <span className="text-xl">{t.icon}</span>
                <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{t.label}</span>
                <span className={`text-[10px] ${tool === t.id ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>{t.hint}</span>
              </button>
            ))}
          </div>
          <div className="bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
              <span className="text-[10px] text-gray-500 font-medium">环境变量</span>
              <CopyButton text={envText} label="复制全部" className="py-0.5 text-[10px]" />
            </div>
            <pre className="px-3 py-2.5 text-[11px] font-mono text-gray-700 dark:text-gray-300 leading-relaxed">
              {envText}
            </pre>
          </div>
          {tool === 'claude-code' && window.electronAPI?.claude && (
            <button onClick={handleWrite} disabled={writeOk}
              className="w-full py-2 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-green-700 text-white">
              {writeOk ? '✓ 已写入 ~/.claude/settings.json' : '⚡ 自动写入 Claude Code 配置'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── InstanceList ──────────────────────────────────────────────────────────────

function InstanceList({ keysScene, onDelete, localBase, newKeyId, routeHealth }) {
  const [expandedId, setExpandedId] = useState(newKeyId ?? null);

  // Auto-expand whenever a brand-new key is passed in
  React.useEffect(() => { if (newKeyId) setExpandedId(newKeyId); }, [newKeyId]);

  // Newest first — ids are random hex; sort by created_at ISO string (lexicographic = chronological)
  const sorted = [...keysScene].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || ''));
  // { [keyId]: { busy, ok, latency, error } | null }
  const [testState, setTestState]   = useState({});

  async function runTest(k) {
    setTestState(s => ({ ...s, [k.id]: { busy: true } }));
    const model = k.model_key || 'claude-opus-4-5';
    const start = Date.now();
    try {
      const res = await fetch(`${localBase}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': k.key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      const latency = Date.now() - start;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg  = body?.error?.message || `HTTP ${res.status}`;
        setTestState(s => ({ ...s, [k.id]: { ok: false, error: msg, latency } }));
      } else {
        setTestState(s => ({ ...s, [k.id]: { ok: true, latency } }));
      }
    } catch (e) {
      const latency = Date.now() - start;
      setTestState(s => ({ ...s, [k.id]: { ok: false, error: e.message || '连接失败', latency } }));
    }
    setTimeout(() => setTestState(s => ({ ...s, [k.id]: null })), 6000);
  }

  if (keysScene.length === 0) return null;
  return (
    <div className="border-t border-gray-200 dark:border-gray-800">
      <div className="px-5 py-3 flex items-center justify-between">
        <span className="text-xs text-gray-500 font-medium">应用列表</span>
        <span className="text-[10px] text-gray-400">{keysScene.length} 个</span>
      </div>
      <div className="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800/60">
        {sorted.map(k => {
          const ts = testState[k.id];
          const rh = k.model_key ? (routeHealth?.[k.model_key] ?? null) : null;
          const rhFt = rh?.first_token_ms ?? null;
          const rhFtLabel = rhFt != null ? `首token ${(rhFt / 1000).toFixed(1)}s` : null;
          // test result overrides health dot (temporary, 6s)
          const dotColor = ts && !ts.busy
            ? ts.ok ? 'bg-green-500' : 'bg-red-500'
            : rh
              ? rh.status === 'error' ? 'bg-red-500'
                : rh.status === 'ok'
                  ? (rhFt != null && rhFt > 3000 ? 'bg-amber-400' : 'bg-green-500')
                  : 'bg-gray-400'
              : k.is_active ? 'bg-green-500' : 'bg-gray-400';
          const dotTitle = ts && !ts.busy
            ? ts.ok
              ? `测试通过${ts.latency ? ` · ${ts.latency}ms` : ''}`
              : `测试失败 · ${ts.error || '连接错误'}`
            : rh
              ? rh.status === 'error' ? '路由最近请求失败'
                : rh.status === 'ok'
                  ? [rh.degraded ? `已降级至 ${rh.activeStep}` : `命中 ${rh.activeStep}`, rhFtLabel].filter(Boolean).join(' · ')
                  : '路由暂无请求记录'
              : k.is_active ? '应用已启用' : '应用未启用';
          return (
            <div key={k.id}>
              <div
                className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/20 transition-colors cursor-pointer"
                onClick={() => setExpandedId(expandedId === k.id ? null : k.id)}
              >
                <div title={dotTitle} className={`w-1.5 h-1.5 rounded-full shrink-0 cursor-help ${dotColor}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{k.app_name || k.note || '未命名'}</span>
                    {k.scene_name && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40 shrink-0">
                        {k.icon} {k.scene_name}
                      </span>
                    )}
                  </div>
                  <code className="text-[10px] font-mono text-gray-400 mt-0.5 block">{k.key?.slice(0, 20)}…</code>
                </div>

                <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                  {/* Test result badge */}
                  {ts && !ts.busy && (
                    <span className={`text-[10px] font-mono shrink-0 max-w-[120px] truncate ${ts.ok ? 'text-green-500 dark:text-green-400' : 'text-red-400'}`}
                      title={ts.ok ? `${ts.latency}ms` : ts.error}>
                      {ts.ok ? `✓ ${ts.latency}ms` : `✗ ${ts.error}`}
                    </span>
                  )}
                  <button
                    onClick={() => runTest(k)}
                    disabled={ts?.busy}
                    className={`text-[10px] px-2 py-1 rounded border transition-colors shrink-0 ${
                      ts?.busy
                        ? 'border-gray-300 dark:border-gray-600 text-gray-400 opacity-60 cursor-wait'
                        : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-500 dark:hover:text-blue-400'
                    }`}>
                    {ts?.busy ? '测试中…' : '测试'}
                  </button>
                  <CopyButton text={k.key} label="复制" className="text-[10px] py-1 px-2 min-w-0" />
                  <button onClick={() => onDelete(k.id)}
                    className="text-[10px] text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors">删除</button>
                </div>
                <span className="text-gray-400 text-[10px] shrink-0">{expandedId === k.id ? '▲' : '▼'}</span>
              </div>
              {expandedId === k.id && (
                <div className="px-5 pb-4 pt-1">
                  <KeyConfigPanel
                    apiKey={k.key}
                    localBase={localBase}
                    model={k.model_key || undefined}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Auto-config tool list ─────────────────────────────────────────────────────

const TOOLS = [
  { id: 'claude-code', icon: '🤖', label: 'Claude Code', hint: '自动写入' },
  { id: 'cursor',      icon: '🔮', label: 'Cursor',      hint: '手动配置' },
  { id: 'continue',   icon: '🪟', label: 'Continue',    hint: '手动配置' },
  { id: 'other',       icon: '📋', label: '其他',         hint: '通用' },
];

// ── Main Component ────────────────────────────────────────────────────────────

export default function Gateway() {
  const [status, setStatus]     = useState(null);
  const [stats, setStats]       = useState(null);
  const [logEntries, setLog]    = useState([]);
  const [restarting, setRestarting] = useState(false);

  // Scene routing
  const [routes, setRoutes]               = useState([]);
  const [expandedRoute, setExpandedRoute] = useState(null);
  const [newRoute, setNewRoute]           = useState(null);
  const [availableModels, setAvailableModels] = useState([]);

  // Keys list
  const [keysScene, setKeysScene] = useState([]);
  const [newKeyId,  setNewKeyId]  = useState(null);  // auto-expand after creation

  // 场景应用 — new unified flow
  const [appNote,        setAppNote]        = useState('');
  const [appBusy,        setAppBusy]        = useState(false);
  const [appKey,         setAppKey]         = useState(null);   // created key object
  const [appRouteMode,   setAppRouteMode]   = useState(null);   // 'scene' | 'model'
  const [appSceneId,     setAppSceneId]     = useState('');
  const [appModelId,     setAppModelId]     = useState('');
  const [appRouterModel, setAppRouterModel] = useState('');     // resolved model/router key

  const localBase = status?.port
    ? `http://127.0.0.1:${status.port}/v1`
    : 'http://127.0.0.1:11430/v1';

  // ── Data loading ────────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    const [s, st, lg] = await Promise.all([
      getGateway().status(),
      getGateway().getDailyStats(),
      getGateway().getLog(),
    ]);
    setStatus(s);
    setStats(st);
    setLog(lg.slice(0, 50));
  }, []);

  const loadSceneData = useCallback(async () => {
    try {
      const cfg = await getLocalConfig().get();
      const localRoutes = cfg.scene_routes || [];
      setRoutes(localRoutes);
      // Enrich local keys with scene info
      const enriched = (cfg.local_keys || []).map(k => {
        const route = k.model_key ? localRoutes.find(r => r.model_key === k.model_key) : null;
        return { ...k, scene_name: route?.scene_name, icon: route?.icon, steps: route?.steps };
      });
      setKeysScene(enriched);
    } catch (e) {
      console.error('loadSceneData', e);
    }
  }, []);

  const loadAvailableModels = useCallback(async () => {
    const models = [];
    const seen   = new Set();
    const add    = (id, tier) => { if (!seen.has(id)) { seen.add(id); models.push({ id, tier }); } };

    // Free / paid models from configured provider model lists
    try {
      const cfg = await getConfig().read();
      for (const p of (cfg?.providers || [])) {
        if (!p.enabled || p.type === 'p2p') continue;
        for (const m of (p.models || [])) add(typeof m === 'string' ? m : m.name, p.type);
      }
    } catch {}

    // P2P models from backend rates (includes all registered models)
    try {
      const res = await getRates();
      for (const m of (res.data?.models || [])) add(m.name, normTier(m.tier));
    } catch (e) {
      console.error('loadAvailableModels p2p', e);
    }

    setAvailableModels(models);
  }, []);

  useEffect(() => {
    refresh();
    loadSceneData();
    loadAvailableModels();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh, loadSceneData, loadAvailableModels]);

  // ── Computed stats ──────────────────────────────────────────────────────────

  const totalCalls   = stats?.total_calls ?? 0;
  const totalErrors  = 0;  // not tracked in local stats
  const providerEntries = [...(stats?.providers ?? [])]
    .sort((a, b) => b.calls - a.calls)
    .map(p => [p.id, { calls: p.calls, tier: p.tier }]);
  const freeCalls    = providerEntries
    .filter(([id]) => !['tokenbank-p2p', 'openai', 'anthropic-paid'].includes(id))
    .reduce((s, [, v]) => s + v.calls, 0);
  const freeRatio    = totalCalls > 0 ? Math.round((freeCalls / totalCalls) * 100) : 0;
  const errorRatio   = (totalCalls + totalErrors) > 0
    ? ((totalErrors / (totalCalls + totalErrors)) * 100).toFixed(1) : '0.0';
  const okLogs       = logEntries.filter(e => e.status === 'ok');
  const avgLatency   = okLogs.length > 0
    ? Math.round(okLogs.reduce((s, e) => s + e.latency_ms, 0) / okLogs.length) : 0;

  // ── Route / model health: derived from recent log entries ─────────────────
  // Covers both scene-route keys (llm-router-xxx) and direct model keys
  const routeHealth = React.useMemo(() => {
    // Collect all known model_keys: from routes + from keysScene
    const allKeys = new Set([
      ...routes.map(r => r.model_key).filter(Boolean),
      ...keysScene.map(k => k.model_key).filter(Boolean),
    ]);
    const map = {};
    for (const key of allKeys) {
      const entries = logEntries.filter(e => e.requested_model === key);
      if (!entries.length) { map[key] = { status: null, activeStep: null, triedSteps: [], degraded: false }; continue; }
      const last = entries[0]; // newest first
      map[key] = {
        status: last.status,
        activeStep: last.status === 'ok' ? last.model : null,
        triedSteps: Array.isArray(last.tried) ? last.tried : [],
        degraded: last.status === 'ok' && Array.isArray(last.tried) && last.tried.length > 0,
        first_token_ms: last.first_token_ms ?? null,
      };
    }
    return map;
  }, [logEntries, routes, keysScene]);

  // ── Scene route actions ────────────────────────────────────────────────────

  const saveRoute = async (route) => {
    try {
      if (route.id) {
        await getLocalConfig().updateSceneRoute({
          id: route.id, scene_name: route.scene_name, icon: route.icon, steps: route.steps,
        });
      } else {
        await getLocalConfig().createSceneRoute({
          scene_name: route.scene_name, icon: route.icon, steps: route.steps,
        });
      }
      setNewRoute(null);
      setExpandedRoute(null);
      await loadSceneData();
    } catch (e) {
      alert('保存失败: ' + e.message);
    }
  };

  const removeRoute = async (id) => {
    if (!confirm('删除此场景路由？')) return;
    try { await getLocalConfig().deleteSceneRoute(id); await loadSceneData(); }
    catch (e) { alert('删除失败'); }
  };

  // ── App key actions ────────────────────────────────────────────────────────

  async function handleCreateAppKey() {
    if (!appNote.trim()) return;
    setAppBusy(true);
    setAppKey(null);
    setAppRouteMode(null);
    setAppSceneId('');
    setAppModelId('');
    setAppRouterModel('');
    try {
      const key = await getLocalConfig().createKey({ note: appNote.trim() });
      setAppKey(key);
      setNewKeyId(key.id);
      await loadSceneData();
    } catch (e) {
      alert('创建失败: ' + e.message);
    } finally {
      setAppBusy(false);
    }
  }

  async function handleDeleteKey(keyId) {
    if (!confirm('删除此 Key？操作不可恢复。')) return;
    try { await getLocalConfig().deleteKey(keyId); await loadSceneData(); }
    catch (e) { alert('删除失败'); }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status?.running ? 'bg-green-400' : 'bg-gray-400'}`} />
          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${status?.running ? 'bg-green-500' : 'bg-gray-400'}`} />
        </span>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">网关</h1>
        {status && (
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            status.running
              ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 border-green-300 dark:border-green-800/50'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 border-gray-300 dark:border-gray-700'
          }`}>
            {status.running ? `运行中 · :${status.port}` : '已停止'}
          </span>
        )}
        <button
          onClick={async () => {
            if (restarting) return;
            setRestarting(true);
            await getGateway().restart();
            await new Promise(r => setTimeout(r, 600));
            await refresh();
            setRestarting(false);
          }}
          disabled={restarting}
          title="重启网关"
          className="ml-auto flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"
            className={`w-3.5 h-3.5 ${restarting ? 'animate-spin' : ''}`}>
            <path fillRule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08 1.01.75.75 0 1 1-1.3-.75 6 6 0 0 1 9.44-1.344l.842.841V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.344l-.84-.841v1.371a.75.75 0 0 1-1.5 0V9.691a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-1.01.75.75 0 0 1 1.025-.295Z" clipRule="evenodd" />
          </svg>
          {restarting ? '重启中…' : '重启'}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: '今日请求', value: totalCalls,   color: 'text-gray-900 dark:text-gray-100' },
          { label: '免费命中率', value: `${freeRatio}%`, color: 'text-green-600 dark:text-green-400' },
          { label: '错误率',   value: `${errorRatio}%`, color: 'text-amber-600 dark:text-amber-400' },
          { label: '平均延迟', value: avgLatency > 0 ? `${avgLatency}ms` : '—', color: 'text-gray-900 dark:text-gray-100' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3">
            <div className="text-xs text-gray-500">{label}</div>
            <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Endpoint */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-2">接入端点</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm font-mono text-green-600 dark:text-green-400 bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-2 border border-gray-300 dark:border-gray-700">
            {localBase}
          </code>
          <CopyButton text={localBase} label="复制" />
        </div>
      </div>

      {/* 场景路由 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">场景路由</h2>
            <p className="text-xs text-gray-500 mt-0.5">定义每个场景的模型降级链</p>
          </div>
          <button
            onClick={() => { setExpandedRoute(null); setNewRoute({ scene_name: '', icon: '🔀', steps: [] }); }}
            className="text-xs bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 px-3 py-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >+ 新建路由</button>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
          {routes.map(route => {
            const health = routeHealth[route.model_key] ?? { status: null, activeStep: null, degraded: false };
            const ftMs = health.first_token_ms;
            const healthDot =
              health.status === 'error' ? 'bg-red-500' :
              health.status === 'ok'
                ? (ftMs != null && ftMs > 3000 ? 'bg-amber-400' : 'bg-green-500')
                : 'bg-gray-300 dark:bg-gray-600';
            const ftLabel = ftMs != null ? `首token ${(ftMs / 1000).toFixed(1)}s` : null;
            const healthTitle =
              health.status === 'error' ? '最近请求失败' :
              health.status === 'ok'
                ? [health.degraded ? '已降级' : '运行正常', ftLabel].filter(Boolean).join(' · ')
                : '暂无请求记录';
            return (
            <div key={route.id}>
              <div
                className="flex items-start gap-4 px-5 py-3.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                onClick={() => setExpandedRoute(expandedRoute === route.id ? null : route.id)}
              >
                <span className="text-lg mt-0.5">{route.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {/* Health dot */}
                    <span title={healthTitle} className={`w-2 h-2 rounded-full shrink-0 ${healthDot}`} />
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{route.scene_name}</span>
                    {health.degraded && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 text-amber-600 dark:text-amber-400 shrink-0">
                        降级中
                      </span>
                    )}
                    {route.model_key && (
                      <>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800/40 text-purple-600 dark:text-purple-400 shrink-0">
                          {route.model_key}
                        </span>
                        <span onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(route.model_key); }}
                          className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer transition-colors shrink-0">复制</span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {(route.steps || []).map((step, i) => {
                      const t = resolveStepTier(step.model || step.label, step, availableModels);
                      const stepName = step.model || step.label;
                      const isActive = health.activeStep === stepName;
                      const isFailed = health.triedSteps?.includes(stepName);
                      return (
                        <React.Fragment key={i}>
                          {i > 0 && <span className="text-gray-400 text-xs">→</span>}
                          <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border transition-all ${
                            isActive
                              ? 'bg-green-100 dark:bg-green-900/40 border-green-400 dark:border-green-600 text-green-800 dark:text-green-200'
                              : tierStyle(t)
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              isActive ? 'bg-green-500' : isFailed ? 'bg-red-500' : tierDot(t)
                            }`} />
                            {step.label || step.model}
                            <span className="opacity-50">({TIER_SHORT[t] || t})</span>
                          </span>
                        </React.Fragment>
                      );
                    })}
                    {!route.steps?.length && <span className="text-xs text-gray-400">暂无步骤</span>}
                  </div>
                </div>
                <button onClick={e => { e.stopPropagation(); removeRoute(route.id); }}
                  className="text-[10px] text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors mt-1 shrink-0">删除</button>
                <span className="text-gray-400 text-xs mt-1 shrink-0">{expandedRoute === route.id ? '▲' : '▼'}</span>
              </div>
              {expandedRoute === route.id && (
                <SceneRouteEditor route={route} availableModels={availableModels} onSave={saveRoute} onCancel={() => setExpandedRoute(null)} />
              )}
            </div>
            );
          })}
          {newRoute && (
            <SceneRouteEditor route={newRoute} availableModels={availableModels} onSave={saveRoute} onCancel={() => setNewRoute(null)} />
          )}
          {routes.length === 0 && !newRoute && (
            <div className="px-5 py-8 text-xs text-gray-400 text-center">还没有场景路由，点击「新建路由」开始</div>
          )}
        </div>
      </div>

      {/* 场景应用 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">场景应用</h2>
          <p className="text-xs text-gray-500 mt-0.5">创建 API Key，接入本地网关</p>
        </div>

        {/* Step 1: Create key */}
        <div className="p-5 space-y-4">
          <div className="flex gap-2">
            <input
              value={appNote}
              onChange={e => setAppNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
              placeholder="Key 备注，如：工作用 Claude Code"
              className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-400 dark:placeholder-gray-500"
            />
            <button
              onClick={handleCreateAppKey}
              disabled={appBusy || !appNote.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
            >
              {appBusy ? '创建中…' : '创建 Key'}
            </button>
          </div>

          {/* Key row (shown once key is created) */}
          {appKey && (
            <div className="flex items-center gap-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/40 rounded-lg px-4 py-2.5">
              <span className="text-[10px] font-semibold text-green-600 dark:text-green-400 shrink-0">✓ Key 已生成</span>
              <code className="flex-1 text-[11px] font-mono text-gray-700 dark:text-gray-300 truncate min-w-0">{appKey.key}</code>
              <CopyButton text={appKey.key} label="复制 Key" className="py-1 text-[10px] shrink-0" />
            </div>
          )}

          {/* Step 2: Route selection (shown after key created) */}
          {appKey && (
            <div className="space-y-3">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">选择模型路由</p>

              {/* Mode cards */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'scene', icon: '🔀', label: '场景路由', hint: '多模型降级链' },
                  { id: 'model', icon: '🧠', label: '指定模型', hint: '固定单一模型' },
                ].map(t => (
                  <button key={t.id}
                    onClick={() => { setAppRouteMode(t.id); setAppSceneId(''); setAppModelId(''); setAppRouterModel(''); }}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-colors ${
                      appRouteMode === t.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 hover:border-gray-400 dark:hover:border-gray-600'
                    }`}>
                    <span className="text-xl">{t.icon}</span>
                    <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{t.label}</span>
                    <span className={`text-[10px] ${appRouteMode === t.id ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>{t.hint}</span>
                  </button>
                ))}
              </div>

              {/* Scene route picker */}
              {appRouteMode === 'scene' && (
                routes.length > 0 ? (
                  <select value={appSceneId}
                    onChange={async e => {
                      const id = e.target.value;
                      setAppSceneId(id);
                      if (id && appKey) {
                        const r = routes.find(x => x.id === id);
                        if (r) {
                          try {
                            await getLocalConfig().bindKey({ id: appKey.id, model_key: r.model_key });
                            loadSceneData();
                          } catch {}
                          // Reset creation area; InstanceList keeps the expanded key via newKeyId
                          setAppKey(null); setAppNote('');
                          setAppRouteMode(null); setAppSceneId(''); setAppModelId(''); setAppRouterModel('');
                        }
                      }
                    }}
                    className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500">
                    <option value="">-- 选择场景路由 --</option>
                    {routes.map(r => (
                      <option key={r.id} value={r.id}>{r.icon} {r.scene_name}{r.model_key ? `  ·  ${r.model_key}` : ''}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-lg px-3 py-2">
                    暂无场景路由，请先在上方「场景路由」中创建
                  </p>
                )
              )}

              {/* Model picker */}
              {appRouteMode === 'model' && (
                <ModelSelect availableModels={availableModels} value={appModelId}
                  onChange={async v => {
                    if (!v || !appKey) return;
                    try {
                      await getLocalConfig().bindKey({ id: appKey.id, model_key: v });
                      loadSceneData();
                    } catch {}
                    // Reset creation area; InstanceList keeps the expanded key via newKeyId
                    setAppKey(null); setAppNote('');
                    setAppRouteMode(null); setAppSceneId(''); setAppModelId(''); setAppRouterModel('');
                  }} />
              )}
            </div>
          )}
        </div>

        {/* All keys list */}
        <InstanceList keysScene={keysScene} onDelete={handleDeleteKey} localBase={localBase} newKeyId={newKeyId} routeHealth={routeHealth} />
      </div>

      {/* Route log */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">路由明细</h2>
        {logEntries.length === 0 ? (
          <p className="text-sm text-gray-500">
            暂无请求记录。将 AI 工具的 base_url 指向{' '}
            <code className="font-mono text-green-600 dark:text-green-400">{localBase}</code> 后开始使用。
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1.5 pr-1">
            {logEntries.map((e, i) => {
              const isRouter = e.requested_model?.startsWith('llm-router-');
              return (
                <div key={`${e.ts}-${e.via}-${i}`}
                  className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/60">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                  <span className="font-mono text-gray-400 shrink-0 w-12">
                    {new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>

                  {/* Model chain */}
                  <div className="flex-1 min-w-0 flex items-center gap-1 flex-wrap">
                    {/* Scene route label */}
                    {isRouter && (
                      <span className="font-mono text-purple-500 dark:text-purple-400 shrink-0">{e.requested_model}</span>
                    )}
                    {/* Failed models in degradation chain */}
                    {e.tried?.map((m, j) => (
                      <React.Fragment key={j}>
                        {(isRouter || j > 0) && <span className="text-gray-300 dark:text-gray-600">→</span>}
                        <span className="font-mono text-red-400 line-through opacity-60 shrink-0">{m}</span>
                      </React.Fragment>
                    ))}
                    {/* Actual model used */}
                    {(isRouter || e.tried?.length > 0) && <span className="text-gray-300 dark:text-gray-600">→</span>}
                    <span className="font-mono text-gray-700 dark:text-gray-300 truncate">
                      {e.model || '—'}
                      {e.tier && (
                        <span className={`ml-0.5 text-[9px] not-italic ${
                          e.tier === 'p2p'  ? 'text-blue-500 dark:text-blue-400' :
                          e.tier === 'paid' ? 'text-amber-500 dark:text-amber-400' :
                                              'text-green-600 dark:text-green-500'
                        }`}>({e.tier})</span>
                      )}
                    </span>
                  </div>

                  <span className="text-gray-400 shrink-0">→</span>
                  <span className={`shrink-0 font-medium ${e.status === 'ok' ? 'text-blue-600 dark:text-blue-400' : 'text-red-500'}`}>
                    {e.status === 'ok' ? (e.via_label || e.via || '—') : '失败'}
                  </span>
                  <span className="text-gray-400 shrink-0">{e.latency_ms}ms</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
