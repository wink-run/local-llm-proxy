import React, { useEffect, useState, useCallback } from 'react';
import { getServerUrl } from '../config';
import {
  listKeys, getRates,
  getSceneRoutes, createSceneRoute, updateSceneRoute, deleteSceneRoute,
  getKeysWithScene, bindKeyToScene,
} from '../api/client';

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function CopyButton({ text, label = '复制' }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return (
    <button onClick={copy}
      className="shrink-0 text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
      {copied ? '已复制 ✓' : label}
    </button>
  );
}

function StrategyToggle({ strategy, onChange }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      {['cost', 'quality'].map((s) => (
        <button key={s} onClick={() => onChange(s)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            strategy === s
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}>
          {s === 'cost' ? '省钱优先' : '质量优先'}
        </button>
      ))}
    </div>
  );
}

const VIA_LABELS = {
  ollama: 'Ollama',
  groq: 'Groq',
  'github-models': 'GitHub Models',
  'tokenbank-p2p': 'P2P 网络',
  openai: 'OpenAI',
  'anthropic-paid': 'Anthropic',
};

function tierStyle(tier) {
  if (tier === 'p2p') return 'bg-blue-950/70 border-blue-800/30 text-blue-300';
  if (tier === 'paid') return 'bg-amber-950/70 border-amber-800/30 text-amber-300';
  return 'bg-green-950/70 border-green-800/30 text-green-300';
}
function tierDot(tier) {
  if (tier === 'p2p') return 'bg-blue-400';
  if (tier === 'paid') return 'bg-amber-400';
  return 'bg-green-400';
}
function normTier(t) {
  if (t === 'p2p') return 'p2p';
  if (t === 'paid') return 'paid';
  return 'free'; // 'open' or anything else → free
}

export default function Gateway() {
  const [status, setStatus]     = useState(null);
  const [stats, setStats]       = useState(null);
  const [logEntries, setLog]    = useState([]);
  const [ccStatus, setCcStatus] = useState(null);
  const [ccMsg, setCcMsg]       = useState('');
  const [ccBusy, setCcBusy]     = useState(false);

  // Scene routing state
  const [routes, setRoutes]       = useState([]);
  const [expandedRoute, setExpandedRoute] = useState(null);
  const [newRoute, setNewRoute]   = useState(null);
  const [keysScene, setKeysScene] = useState([]);
  const [expandedKey, setExpandedKey] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);

  const localBase = status?.port ? `http://localhost:${status.port}/v1` : 'http://localhost:11430/v1';

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.gateway) return;
    const [s, st, lg] = await Promise.all([
      window.electronAPI.gateway.status(),
      window.electronAPI.gateway.getDailyStats(),
      window.electronAPI.gateway.getLog(),
    ]);
    setStatus(s);
    setStats(st);
    setLog(lg.slice(0, 20));
  }, []);

  const loadSceneData = useCallback(async () => {
    try {
      const [rRes, kRes] = await Promise.all([getSceneRoutes(), getKeysWithScene()]);
      setRoutes(rRes.data?.routes || []);
      setKeysScene(kRes.data?.keys || []);
    } catch (e) {
      console.error('loadSceneData', e);
    }
  }, []);

  const loadAvailableModels = useCallback(async () => {
    try {
      const res = await getRates();
      const models = (res.data?.models || []).map(m => ({
        id: m.name,
        tier: normTier(m.tier),
      }));
      setAvailableModels(models);
    } catch (e) {
      console.error('loadAvailableModels', e);
    }
  }, []);

  useEffect(() => {
    refresh();
    loadSceneData();
    loadAvailableModels();
    window.electronAPI?.claude?.status().then(r => setCcStatus(r?.configured)).catch(() => {});
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh, loadSceneData, loadAvailableModels]);

  async function handleStrategy(s) {
    await window.electronAPI?.gateway?.setStrategy(s);
    setStatus(prev => prev ? { ...prev, strategy: s } : prev);
  }

  async function handleClaudeConfigure() {
    setCcBusy(true); setCcMsg('');
    try {
      const keysRes = await listKeys().catch(() => ({ data: { keys: [] } }));
      const activeKey = (keysRes.data.keys || []).find(k => k.is_active);
      if (!activeKey) { setCcMsg('请先在盘点页面创建并启用 API Key'); return; }
      await window.electronAPI?.claude?.configure(localBase, activeKey.key, []);
      setCcStatus(true);
      setCcMsg('配置成功，重启 Claude Code 生效');
      setTimeout(() => setCcMsg(''), 4000);
    } finally { setCcBusy(false); }
  }

  const saveRoute = async (route) => {
    try {
      if (route.id) {
        await updateSceneRoute(route.id, { scene_name: route.scene_name, icon: route.icon, steps: route.steps });
      } else {
        await createSceneRoute({ scene_name: route.scene_name, icon: route.icon, steps: route.steps });
      }
      setNewRoute(null);
      setExpandedRoute(null);
      await loadSceneData();
    } catch (e) {
      alert('保存失败: ' + (e.response?.data?.detail || e.message));
    }
  };

  const removeRoute = async (id) => {
    if (!confirm('删除此场景路由？绑定该路由的 Key 将变为默认路由。')) return;
    try {
      await deleteSceneRoute(id);
      await loadSceneData();
    } catch (e) {
      alert('删除失败');
    }
  };

  const saveKeyBinding = async (keyId, sceneRouteId, appName) => {
    try {
      await bindKeyToScene(keyId, { scene_route_id: sceneRouteId || null, app_name: appName });
      setExpandedKey(null);
      await loadSceneData();
    } catch (e) {
      alert('绑定失败: ' + (e.response?.data?.detail || e.message));
    }
  };

  // ── Sub-components ────────────────────────────────────────────────────────

  function SceneRouteEditor({ route, onSave, onCancel }) {
    const [name, setName] = useState(route.scene_name || '');
    const [icon, setIcon] = useState(route.icon || '🔀');
    const [steps, setSteps] = useState(route.steps || []);

    const addStep = () => setSteps(prev => [...prev, { label: '', model: '', tier: 'free' }]);
    const removeStep = (i) => setSteps(prev => prev.filter((_, idx) => idx !== i));
    const updateStep = (i, modelId) => {
      const m = availableModels.find(x => x.id === modelId);
      const tier = m ? m.tier : normTier('open');
      setSteps(prev => prev.map((s, idx) => idx === i ? { label: modelId, model: modelId, tier } : s));
    };

    const freeModels = availableModels.filter(m => m.tier === 'free');
    const p2pModels  = availableModels.filter(m => m.tier === 'p2p');
    const paidModels = availableModels.filter(m => m.tier === 'paid');

    return (
      <div className="border-t border-gray-200 dark:border-gray-800/60 bg-gray-50 dark:bg-gray-800/20 px-5 py-4 space-y-3">
        <div className="flex gap-2">
          <input
            value={icon} onChange={e => setIcon(e.target.value)}
            className="w-10 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none"
            maxLength={2}
          />
          <input
            value={name} onChange={e => setName(e.target.value)}
            placeholder="场景名称，如：Claude Code"
            className="flex-1 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-500 font-medium">
          降级链 <span className="text-gray-400 dark:text-gray-700">· 失败时按顺序尝试下一步</span>
        </div>
        <div className="space-y-2">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <span className="text-[10px] text-gray-400 dark:text-gray-600 w-4 text-right shrink-0">{i + 1}</span>
              <select
                value={step.model}
                onChange={e => updateStep(i, e.target.value)}
                className="flex-1 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">-- 选择模型 --</option>
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
              <button
                onClick={() => removeStep(i)}
                className="text-[10px] text-gray-300 dark:text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              >✕</button>
            </div>
          ))}
          {steps.length === 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-600">还没有步骤，点击「添加步骤」</p>
          )}
        </div>
        <button onClick={addStep} className="text-xs text-blue-500 hover:text-blue-400">+ 添加步骤</button>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">取消</button>
          <button onClick={() => onSave({ ...route, scene_name: name, icon, steps })} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium">保存</button>
        </div>
      </div>
    );
  }

  function KeyBindEditor({ apiKey, onSave, onCancel }) {
    const [selectedRoute, setSelectedRoute] = useState(apiKey.scene_route_id || '');
    const [appName, setAppName] = useState(apiKey.app_name || apiKey.note || '');

    return (
      <div className="border-t border-gray-200 dark:border-gray-800/60 bg-gray-50 dark:bg-gray-800/20 px-5 py-4 space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs text-gray-500">应用名称</label>
          <input
            value={appName} onChange={e => setAppName(e.target.value)}
            placeholder="如：Claude Code 主机"
            className="w-full bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-gray-500">绑定场景路由</label>
          <select
            value={selectedRoute}
            onChange={e => setSelectedRoute(e.target.value ? Number(e.target.value) : '')}
            className="w-full bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
          >
            <option value="">不绑定（按请求模型名路由）</option>
            {routes.map(r => (
              <option key={r.id} value={r.id}>{r.icon} {r.scene_name}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">取消</button>
          <button
            onClick={() => onSave(apiKey.id, selectedRoute || null, appName)}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium"
          >保存</button>
        </div>
      </div>
    );
  }

  // ── Computed stats ────────────────────────────────────────────────────────

  const totalCalls  = stats?.calls ?? 0;
  const providerEntries = Object.entries(stats?.by_provider ?? {})
    .sort((a, b) => b[1].calls - a[1].calls);
  const freeCalls   = providerEntries
    .filter(([id]) => !['tokenbank-p2p', 'openai', 'anthropic-paid'].includes(id))
    .reduce((s, [, v]) => s + v.calls, 0);
  const freeRatio   = totalCalls > 0 ? Math.round((freeCalls / totalCalls) * 100) : 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">本地网关</h1>
        {status && (
          <div className="flex items-center gap-3">
            <span className={`flex items-center gap-1.5 text-sm ${status.running ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>
              <span className={`w-2 h-2 rounded-full ${status.running ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`} />
              {status.running ? `运行中 :${status.port}` : '已停止'}
            </span>
            <StrategyToggle strategy={status.strategy} onChange={handleStrategy} />
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="今日调用" value={totalCalls} sub="次请求" />
        <StatCard label="免费路由占比" value={`${freeRatio}%`} sub={`${freeCalls} 次走免费层`} />
        <StatCard label="供给来源" value={providerEntries.length} sub="活跃 Provider" />
      </div>

      {/* Endpoint card */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">接入配置</h2>
        <div className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">本地网关地址</p>
            <p className="font-mono text-sm text-gray-800 dark:text-gray-200">{localBase}</p>
          </div>
          <CopyButton text={localBase} />
        </div>
        <div className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            {ccStatus !== null && (
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${ccStatus ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'}`}>
                {ccStatus ? 'Claude Code 已配置' : 'Claude Code 未配置'}
              </span>
            )}
            {ccMsg && <span className={`text-xs truncate ${ccMsg.includes('成功') ? 'text-green-600 dark:text-green-400' : 'text-yellow-600'}`}>{ccMsg}</span>}
          </div>
          {window.electronAPI?.claude && (
            <button onClick={handleClaudeConfigure} disabled={ccBusy}
              className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
              {ccBusy ? '配置中…' : '一键配置'}
            </button>
          )}
        </div>
      </div>

      {/* 场景路由 */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-700/50">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">场景路由</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">定义每个场景的降级链规则</p>
          </div>
          <button
            onClick={() => { setExpandedRoute(null); setNewRoute({ scene_name: '', icon: '🔀', steps: [] }); }}
            className="text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 px-3 py-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >+ 新建场景</button>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-700/40">
          {routes.map(route => (
            <div key={route.id}>
              <div
                className="flex items-start gap-4 px-5 py-3.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/20"
                onClick={() => setExpandedRoute(expandedRoute === route.id ? null : route.id)}
              >
                <span className="text-lg mt-0.5">{route.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{route.scene_name}</div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {(route.steps || []).map((step, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <span className="text-gray-300 dark:text-gray-600 text-xs">→</span>}
                        <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border ${tierStyle(step.tier)}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${tierDot(step.tier)}`} />
                          {step.label || step.model}
                        </span>
                      </React.Fragment>
                    ))}
                    {!route.steps?.length && <span className="text-xs text-gray-400 dark:text-gray-600">暂无步骤</span>}
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); removeRoute(route.id); }}
                  className="text-xs text-gray-300 dark:text-gray-700 hover:text-red-400 transition-colors mt-1 shrink-0"
                >删除</button>
                <span className="text-gray-400 dark:text-gray-600 text-xs mt-1 shrink-0">
                  {expandedRoute === route.id ? '▲' : '▼'}
                </span>
              </div>
              {expandedRoute === route.id && (
                <SceneRouteEditor
                  route={route}
                  onSave={saveRoute}
                  onCancel={() => setExpandedRoute(null)}
                />
              )}
            </div>
          ))}
          {newRoute && (
            <SceneRouteEditor
              route={newRoute}
              onSave={saveRoute}
              onCancel={() => setNewRoute(null)}
            />
          )}
          {routes.length === 0 && !newRoute && (
            <div className="px-5 py-8 text-xs text-gray-400 dark:text-gray-600 text-center">
              还没有场景路由，点击「新建场景」开始
            </div>
          )}
        </div>
      </div>

      {/* 场景应用 */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700/50">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">场景应用</h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">将 API Key 与场景路由绑定，接入 AI 工具</p>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-700/40">
          {keysScene.map(key => (
            <div key={key.id}>
              <div
                className="flex items-center gap-4 px-5 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/20"
                onClick={() => setExpandedKey(expandedKey === key.id ? null : key.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-800 dark:text-gray-200">
                    {key.app_name || key.note || '未命名'}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <code className="text-[10px] text-gray-400 dark:text-gray-600 font-mono">{key.key?.slice(0, 10)}…</code>
                    {key.scene_name ? (
                      <span className="text-[10px] text-blue-500">{key.icon} {key.scene_name}</span>
                    ) : (
                      <span className="text-[10px] text-gray-400 dark:text-gray-600">未绑定路由</span>
                    )}
                  </div>
                </div>
                <span className="text-gray-300 dark:text-gray-600 text-xs">
                  {expandedKey === key.id ? '▲' : '▼'}
                </span>
              </div>
              {expandedKey === key.id && (
                <KeyBindEditor
                  apiKey={key}
                  onSave={saveKeyBinding}
                  onCancel={() => setExpandedKey(null)}
                />
              )}
            </div>
          ))}
          {keysScene.length === 0 && (
            <div className="px-5 py-8 text-xs text-gray-400 dark:text-gray-600 text-center">
              先在「盘点」页创建 API Key，再回来绑定场景路由
            </div>
          )}
        </div>
      </div>

      {/* Route log */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">路由明细</h2>
        {logEntries.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">暂无请求记录。将 AI 工具的 base_url 指向 {localBase} 后开始使用。</p>
        ) : (
          <div className="space-y-1.5">
            {logEntries.map((e, i) => (
              <div key={`${e.ts}-${e.via}-${i}`} className="flex items-center gap-3 text-xs px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                <span className="font-mono text-gray-500 dark:text-gray-500 shrink-0 w-12">
                  {new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{e.model || '—'}</span>
                <span className="text-gray-400 dark:text-gray-500 shrink-0">→</span>
                <span className={`shrink-0 font-medium ${e.status === 'ok' ? 'text-blue-600 dark:text-blue-400' : 'text-red-500'}`}>
                  {e.status === 'ok' ? (VIA_LABELS[e.via] || e.via || '—') : '失败'}
                </span>
                <span className="text-gray-400 dark:text-gray-500 shrink-0">{e.latency_ms}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
