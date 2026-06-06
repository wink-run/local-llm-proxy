import React, { useEffect, useState, useCallback } from 'react';
import { getRates } from '../api/client';
import { getGateway, getLocalConfig, getConfig } from '../api/adapter';
import { listAgents, applyAgent, revertAgent } from '../api/agents';

// ── PolicyManager：策略组管理 UI ──────────────────────────────────────────────
const STRATEGY_OPTIONS = [
  { value: 'fallback',    label: '故障转移', desc: '按序尝试，主挂了用备' },
  { value: 'round-robin', label: '轮询',     desc: '依次循环使用' },
  { value: 'weighted',    label: '加权随机', desc: '按权重随机选择' },
  { value: 'latency',     label: '延迟优先', desc: '选历史延迟最低的' },
  { value: 'direct',      label: '直连',     desc: '只用第一个，不降级' },
];

function PolicyManager() {
  const [policies, setPolicies] = useState([]);
  const [providers, setProviders] = useState([]);
  const [editing, setEditing] = useState(null);   // null | policy object | 'new'
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 编辑表单状态
  const [formName, setFormName] = useState('');
  const [formStrategy, setFormStrategy] = useState('fallback');
  const [formProviders, setFormProviders] = useState([]);  // [{id, weight}]

  const load = useCallback(async () => {
    if (!window.electronAPI?.policies) return;
    const [pl, cfg] = await Promise.all([
      window.electronAPI.policies.list(),
      window.electronAPI.config?.read?.(),
    ]);
    setPolicies(Array.isArray(pl) ? pl : []);
    setProviders((cfg?.providers || []).filter(p => p.enabled && p.base_url));
  }, []);
  useEffect(() => { load(); }, [load]);

  function openNew() {
    setFormName(''); setFormStrategy('fallback'); setFormProviders([]);
    setEditing('new'); setMsg('');
  }
  function openEdit(p) {
    setFormName(p.name); setFormStrategy(p.strategy || 'fallback');
    setFormProviders((p.providers || []).map(x => typeof x === 'string' ? { id: x, weight: 1 } : x));
    setEditing(p); setMsg('');
  }
  function cancelEdit() { setEditing(null); setMsg(''); }

  async function save() {
    if (!formName.trim()) return setMsg('策略名不能为空');
    setBusy(true);
    try {
      const d = { name: formName.trim(), strategy: formStrategy, providers: formProviders };
      if (editing === 'new') await window.electronAPI.policies.create(d);
      else await window.electronAPI.policies.update({ id: editing.id, ...d });
      await load(); setEditing(null); setMsg('');
    } catch (e) { setMsg('✗ ' + e.message); }
    setBusy(false);
  }

  async function del(id) {
    if (!window.confirm('删除策略组？')) return;
    await window.electronAPI.policies.delete(id);
    await load();
  }

  function addProvider(provId) {
    if (!provId || formProviders.find(p => p.id === provId)) return;
    setFormProviders(prev => [...prev, { id: provId, weight: 1 }]);
  }
  function removeProvider(id) { setFormProviders(prev => prev.filter(p => p.id !== id)); }
  function setWeight(id, w) { setFormProviders(prev => prev.map(p => p.id === id ? { ...p, weight: Math.max(1, +w || 1) } : p)); }
  function moveUp(idx) { if (idx === 0) return; const a = [...formProviders]; [a[idx-1], a[idx]] = [a[idx], a[idx-1]]; setFormProviders(a); }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">⚖️</span>
        <h2 className="font-semibold text-gray-800 dark:text-gray-100 text-sm">路由策略组</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">配置 provider 调度策略，透明接入与场景路由均可使用</span>
        <button onClick={openNew}
          className="ml-auto text-xs px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors">
          + 新建策略组
        </button>
      </div>

      {/* 策略组列表 */}
      <div className="flex flex-col gap-1.5 mb-2">
        {policies.length === 0 && <div className="text-xs text-gray-400 py-1">暂无策略组</div>}
        {policies.map(p => (
          <div key={p.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 text-sm">
            <span className="font-medium text-gray-800 dark:text-gray-100 truncate flex-1">{p.name}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
              {STRATEGY_OPTIONS.find(s => s.value === p.strategy)?.label || p.strategy}
            </span>
            <span className="text-xs text-gray-400 shrink-0">{(p.providers||[]).length} 个 provider</span>
            <button onClick={() => openEdit(p)}
              className="text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 shrink-0">
              编辑
            </button>
            <button onClick={() => del(p.id)}
              className="text-xs text-red-400 hover:text-red-600 shrink-0">删</button>
          </div>
        ))}
      </div>

      {/* 编辑面板 */}
      {editing && (
        <div className="mt-3 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-200 mb-2">
            {editing === 'new' ? '新建策略组' : `编辑：${editing.name}`}
          </div>
          <div className="flex flex-col gap-2">
            {/* 名称 */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-14 shrink-0">策略名</label>
              <input value={formName} onChange={e => setFormName(e.target.value)}
                placeholder="如：code-policy"
                className="flex-1 text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 outline-none focus:border-blue-400 text-gray-800 dark:text-gray-200" />
            </div>
            {/* Strategy */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-14 shrink-0">执行方式</label>
              <select value={formStrategy} onChange={e => setFormStrategy(e.target.value)}
                className="flex-1 text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 outline-none text-gray-800 dark:text-gray-200">
                {STRATEGY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                ))}
              </select>
            </div>
            {/* Provider 列表 */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <label className="text-xs text-gray-500 w-14 shrink-0">Provider</label>
                <select defaultValue="" onChange={e => { addProvider(e.target.value); e.target.value = ''; }}
                  className="flex-1 text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 outline-none text-gray-800 dark:text-gray-200">
                  <option value="">+ 添加 provider…</option>
                  {providers.filter(p => !formProviders.find(fp => fp.id === p.id)).map(p => (
                    <option key={p.id} value={p.id}>{p.label || p.id}</option>
                  ))}
                </select>
              </div>
              {formProviders.map((fp, idx) => (
                <div key={fp.id} className="flex items-center gap-1.5 ml-16 mb-1">
                  <span className="text-xs text-gray-600 dark:text-gray-300 flex-1 truncate">{fp.id}</span>
                  {formStrategy === 'weighted' && (
                    <label className="text-xs text-gray-400">weight
                      <input type="number" min="1" value={fp.weight} onChange={e => setWeight(fp.id, e.target.value)}
                        className="ml-1 w-12 text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 text-center" />
                    </label>
                  )}
                  <button onClick={() => moveUp(idx)} disabled={idx===0}
                    className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-30">↑</button>
                  <button onClick={() => removeProvider(fp.id)}
                    className="text-xs text-red-400 hover:text-red-600">✕</button>
                </div>
              ))}
              {formProviders.length === 0 && (
                <div className="ml-16 text-xs text-gray-400">暂无 provider（保存后策略将 fallthrough 到默认逻辑）</div>
              )}
            </div>
            {/* 操作 */}
            {msg && <div className={`text-xs ml-16 ${msg.startsWith('✗') ? 'text-red-500' : 'text-green-600'}`}>{msg}</div>}
            <div className="flex gap-2 ml-16">
              <button onClick={save} disabled={busy}
                className="text-xs px-3 py-1 rounded bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50">
                {busy ? '保存中…' : '保存'}
              </button>
              <button onClick={cancelEdit}
                className="text-xs px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
        💡 策略组由 yaml 路由规则自动匹配（如「有 tool calls → code-policy」），也可在场景路由中直接指定。
      </p>
    </div>
  );
}

// ── ImportConfigButton：导入配置（本地文件 or URL）─────────────────────────────
// endpoint: 服务器端内置的配置文件路径，如 '/api/config/apps' 或 '/api/config/scenes'
// URL 框只让用户填服务器根地址，文件路径由 endpoint 内置拼接
function ImportConfigButton({ onImported, endpoint = '/api/config/apps' }) {
  const [busy, setBusy] = useState(false);
  const [msg,  setMsg]  = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [serverBase, setServerBase] = useState(''); // 只填服务器根地址

  // 点开 URL 框时，预填登录时配置的服务器根地址
  async function openUrl() {
    if (!showUrl && !serverBase) {
      try {
        const cfg = await getLocalConfig().get();
        const base = cfg?.cloud_config?.url;
        if (base) {
          // 取根地址（去掉 /api、/v1 等路径后缀）
          const origin = base.replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
          setServerBase(origin);
        }
      } catch {}
    }
    setShowUrl(v => !v);
  }

  async function handleFile() {
    if (!window.electronAPI?.toolsConfig) return;
    setBusy(true); setMsg('');
    const r = await window.electronAPI.toolsConfig.importFile();
    if (r.canceled) { setBusy(false); return; }
    setMsg(r.ok ? '✓ 已导入' : '✗ ' + r.error);
    if (r.ok && onImported) onImported();
    setBusy(false);
  }

  async function handleUrl() {
    const base = serverBase.trim().replace(/\/$/, '');
    if (!base || !window.electronAPI?.toolsConfig) return;
    const fullUrl = base + endpoint;
    setBusy(true); setMsg('');
    const r = await window.electronAPI.toolsConfig.importUrl(fullUrl);
    setMsg(r.ok ? '✓ 已从服务器导入' : '✗ ' + r.error);
    if (r.ok && onImported) { onImported(); setShowUrl(false); }
    setBusy(false);
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <button disabled={busy} onClick={handleFile}
          className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
          {busy ? '导入中…' : '📥 导入配置'}
        </button>
        <button onClick={openUrl}
          className="text-xs px-1.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          🔗
        </button>
      </div>
      {msg && <div className={`text-xs mt-1 ${msg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</div>}
      {showUrl && (
        <div className="absolute right-0 top-8 z-10 flex items-center gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 shadow-lg min-w-max">
          <input value={serverBase} onChange={e => setServerBase(e.target.value)}
            placeholder="https://your-server.com"
            className="text-xs bg-transparent border-none outline-none text-gray-700 dark:text-gray-200 w-52" />
          <span className="text-[10px] text-gray-400 shrink-0 font-mono">{endpoint}</span>
          <button onClick={handleUrl} disabled={busy || !serverBase.trim()}
            className="text-xs px-2 py-0.5 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 shrink-0">
            导入
          </button>
        </div>
      )}
    </div>
  );
}

// ── AppManager：应用列表（Tab1: 所有应用 & 托管 | Tab2: API Key 管理）────────
const LINK_METHOD_LABEL = { shim: '透明托管', 'api-key': 'API Key' };
// 自动配置里识别的应用（与 tokenbank.tools.default.yaml 的 tools 对应）+ 其他
const RECOGNIZED_APPS = [
  { id: 'claude-code', name: 'Claude Code', icon: '🤖', request_format: 'anthropic' },
  { id: 'codex',       name: 'Codex',       icon: '💻', request_format: 'auto' },
  { id: 'gemini-cli',  name: 'Gemini CLI',  icon: '🔮', request_format: 'openai' },
];
const FORMAT_OPTIONS = [
  { value: 'auto',      label: '自动检测' },
  { value: 'openai',    label: 'OpenAI 格式' },
  { value: 'anthropic', label: 'Anthropic 格式' },
];

// 单个应用的设置面板（路由规则绑定 + 详细配置）
function AppSettingsPanel({ app, routes, availableModels = [], onUpdate, onDelete, onRegenKey, onClose }) {
  const [name,        setName]        = useState(app.name || '');
  const [icon,        setIcon]        = useState(app.icon || '🔧');
  const [desc,        setDesc]        = useState(app.description || '');
  const [routeId,     setRouteId]     = useState(app.route_id || '');
  const [allowStream, setAllowStream] = useState(app.allow_stream !== false);
  const [format,      setFormat]      = useState(app.request_format || 'auto');
  const [maxRpm,      setMaxRpm]      = useState(app.max_rpm || '');
  const [maxConc,     setMaxConc]     = useState(app.max_concurrent || '');
  const [models,      setModels]      = useState((app.allowed_models || []).join(', '));
  const [busy,        setBusy]        = useState(false);
  const [copied,      setCopied]      = useState(false);

  async function save() {
    setBusy(true);
    await onUpdate({
      id: app.id, name, icon, description: desc,
      route_id: routeId || null,
      allow_stream: allowStream, request_format: format,
      max_rpm: maxRpm ? +maxRpm : null,
      max_concurrent: maxConc ? +maxConc : null,
      allowed_models: models.split(',').map(s => s.trim()).filter(Boolean),
    });
    setBusy(false);
    onClose();
  }

  const ICONS = ['🤖','✏️','🔧','💻','🎯','🌐','📱','🔑','⚡','🛠️','🎨','📊'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-2xl mx-4 max-h-[92vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <span className="text-xl">{icon}</span>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex-1">应用设置</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg">✕</button>
        </div>
        <div className="p-5 space-y-4">
          {/* 基础信息 */}
          <div>
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">基础信息</div>
            <div className="flex gap-2 mb-2">
              <input value={name} onChange={e => setName(e.target.value)} placeholder="应用名称"
                className="flex-1 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-gray-800 dark:text-gray-200" />
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {ICONS.map(e => (
                <button key={e} onClick={() => setIcon(e)}
                  className={`text-lg p-1 rounded ${icon === e ? 'bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-400' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                  {e}
                </button>
              ))}
            </div>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="描述（可选）" rows={2}
              className="w-full text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 outline-none resize-none text-gray-600 dark:text-gray-400" />
          </div>
          {/* API Key 行（仅 api-key 类）*/}
          {app.link_method === 'api-key' && app.api_key && (
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">API Key</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] font-mono bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 text-gray-600 dark:text-gray-400 truncate">{app.api_key}</code>
                <button onClick={() => { navigator.clipboard.writeText(app.api_key); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  className="text-xs px-2 py-1.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 shrink-0">
                  {copied ? '已复制✓' : '复制'}
                </button>
                {onRegenKey && (
                  <button onClick={() => onRegenKey(app.id)}
                    className="text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 shrink-0">重置</button>
                )}
              </div>
            </div>
          )}
          {/* 路由规则：同时显示模型和场景路由 */}
          <div>
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">路由规则（模型或场景路由）</div>
            <select value={routeId} onChange={e => setRouteId(e.target.value)}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 outline-none text-gray-800 dark:text-gray-200">
              <option value="">不绑定（走默认策略）</option>
              {routes.length > 0 && (
                <optgroup label="场景路由">
                  {routes.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon} {r.scene_name}</option>)}
                </optgroup>
              )}
              {['free','p2p','paid'].map(tier => {
                const tm = availableModels.filter(m => m.tier === tier);
                if (!tm.length) return null;
                const label = tier === 'free' ? '🟢 免费模型' : tier === 'p2p' ? '🔵 P2P 模型' : '🟣 付费模型';
                return <optgroup key={tier} label={label}>{tm.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>;
              })}
            </select>
          </div>
          {/* 请求控制（仅 api-key 类 app） */}
          {app.link_method === 'api-key' && (
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">请求控制</div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 w-20 shrink-0">请求格式</label>
                  <select value={format} onChange={e => setFormat(e.target.value)}
                    className="flex-1 text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 outline-none text-gray-800 dark:text-gray-200">
                    {FORMAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 w-20 shrink-0">允许流式</label>
                  <button onClick={() => setAllowStream(!allowStream)}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${allowStream ? 'bg-blue-600' : 'bg-gray-400'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${allowStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 w-20 shrink-0">RPM 限制</label>
                  <input type="number" value={maxRpm} onChange={e => setMaxRpm(e.target.value)} placeholder="不限"
                    className="flex-1 text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 outline-none text-gray-800 dark:text-gray-200" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 w-20 shrink-0">并发限制</label>
                  <input type="number" value={maxConc} onChange={e => setMaxConc(e.target.value)} placeholder="不限"
                    className="flex-1 text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 outline-none text-gray-800 dark:text-gray-200" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 w-20 shrink-0">允许模型</label>
                  <input value={models} onChange={e => setModels(e.target.value)} placeholder="空=不限，逗号分隔"
                    className="flex-1 text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 outline-none text-gray-800 dark:text-gray-200" />
                </div>
              </div>
            </div>
          )}
          {/* 接入配置（仅 api-key 类：展示 Key + 代码示例）*/}
          {app.link_method === 'api-key' && app.api_key && (
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">接入配置</div>
              <KeyConfigPanel apiKey={app.api_key} localBase="http://127.0.0.1:11430/v1"
                model={routeId || undefined} />
            </div>
          )}
        </div>
        <div className="flex gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-800">
          {onDelete && app.link_method === 'api-key' && (
            <button onClick={() => onDelete(app.id)}
              className="px-4 py-2 text-sm rounded-xl border border-red-200 dark:border-red-900/50 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
              删除
            </button>
          )}
          <button onClick={save} disabled={busy}
            className="flex-1 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
            {busy ? '保存中…' : '保存'}
          </button>
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-xl border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function AppManager({ externalRoutes, availableModels = [] }) {
  const [apps,     setApps]     = useState([]);
  const [routes,   setRoutes]   = useState([]);
  const [localBase, setLocalBase] = useState('');
  // 当 Gateway 的 routes 更新时同步进来（场景路由新建后立即可选）
  useEffect(() => { if (externalRoutes?.length) setRoutes(externalRoutes); }, [externalRoutes]);
  const [settings, setSettings] = useState(null);   // 设置弹窗对应的 app
  const [appStats, setAppStats] = useState({});     // id → {calls,tokens,lastTs}
  const [addOpen,  setAddOpen]  = useState(false);  // 添加流程：应用类型选择

  const load = useCallback(async () => {
    if (!window.electronAPI) return;
    const [appList, localCfg, gw] = await Promise.all([
      window.electronAPI.apps?.list().catch(() => []),
      getLocalConfig().get().catch(() => ({})),
      window.electronAPI.gateway?.status?.().catch(() => null),
    ]);
    const list = Array.isArray(appList) ? appList : [];
    setApps(list);
    setRoutes(localCfg?.scene_routes || []);
    if (gw?.port) setLocalBase(`http://localhost:${gw.port}/v1`);
    // 异步拉统计（不阻塞主列表渲染）
    if (list.length && window.electronAPI.apps?.stats) {
      window.electronAPI.apps.stats(list).then(s => setAppStats(s || {})).catch(() => {});
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleUpdateApp(data) {
    const updated = await window.electronAPI.apps?.update(data).catch(() => null);
    await load();
    // 若设置弹窗仍开着，刷新其数据
    if (updated && settings?.id === updated.id) setSettings(updated);
  }

  async function handleDeleteApp(id) {
    if (!window.confirm('删除该应用？')) return;
    await window.electronAPI.apps?.delete(id).catch(() => {});
    if (settings?.id === id) setSettings(null);
    await load();
  }

  async function handleRegenKey(id) {
    const r = await window.electronAPI.apps?.regenKey(id).catch(() => null);
    if (r?.ok) {
      await load();
      // 用最新 key 刷新设置弹窗
      const fresh = (await window.electronAPI.apps?.list().catch(() => []) || []).find(a => a.id === id);
      if (fresh && settings?.id === id) setSettings(fresh);
    }
  }

  // 添加流程：选择已识别的应用 → 用预设快速创建 api-key 应用并打开设置
  async function addPreset(preset) {
    const created = await window.electronAPI.apps?.create({
      name: preset.name, icon: preset.icon, link_method: 'api-key',
      request_format: preset.request_format,
    }).catch(() => null);
    setAddOpen(false);
    await load();
    if (created?.id) setSettings(created);   // 直接进入设置，可继续配置路由等
  }

  // 添加流程：其他（未被识别的应用）→ 创建空白 api-key 应用并打开完整配置
  async function addCustom() {
    const created = await window.electronAPI.apps?.create({
      name: '新应用', icon: '🔧', link_method: 'api-key',
    }).catch(() => null);
    setAddOpen(false);
    await load();
    if (created?.id) setSettings(created);
  }

  return (
    <>
      {settings && (
        <AppSettingsPanel app={settings} routes={routes} availableModels={availableModels}
          onUpdate={handleUpdateApp} onDelete={handleDeleteApp} onRegenKey={handleRegenKey}
          onClose={() => setSettings(null)} />
      )}
      <div className="p-4">
            {/* 操作栏 */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <button onClick={() => setAddOpen(v => !v)}
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors">
                + 添加应用
              </button>
              <span className="text-xs text-gray-400 dark:text-gray-500">已安装的 CLI 工具自动托管</span>
              <div className="ml-auto"><ImportConfigButton onImported={load} /></div>
            </div>

            {/* 添加流程：先选已识别的应用，或「其他」自定义 */}
            {addOpen && (
              <div className="mb-3 p-3 rounded-xl border border-blue-200 dark:border-blue-800/50 bg-blue-50/50 dark:bg-blue-950/15">
                <div className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">选择要添加的应用</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {RECOGNIZED_APPS.map(p => (
                    <button key={p.id} onClick={() => addPreset(p)}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-blue-400 dark:hover:border-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                      <span className="text-base">{p.icon}</span>
                      <span className="text-xs text-gray-700 dark:text-gray-200 truncate">{p.name}</span>
                    </button>
                  ))}
                  <button onClick={addCustom}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 hover:border-blue-400 dark:hover:border-blue-600 transition-colors">
                    <span className="text-base">➕</span>
                    <span className="text-xs text-gray-600 dark:text-gray-300">其他（自定义）</span>
                  </button>
                </div>
                <div className="text-[10px] text-gray-400 mt-2">选择已识别的应用快速添加；选「其他」可手动配置未被识别的应用。</div>
              </div>
            )}

            {/* 应用列表 */}
            {apps.length === 0 ? (
              <div className="py-6 text-center text-xs text-gray-400">
                未检测到已安装的 CLI 工具。安装 Claude Code / Codex / Gemini CLI 后会自动托管并显示在这里，或在 API Key 管理 Tab 手动添加应用。
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                {apps.map(app => {
                  const st = appStats[app.id] || { calls: 0, tokens: 0, lastTs: null };
                  const fmtTokens = n => n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M'
                    : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);
                  const fmtTime = ts => {
                    if (!ts) return '—';
                    const diff = Math.floor((Date.now() - ts*1000)/1000);
                    if (diff < 60) return '刚刚';
                    if (diff < 3600) return `${Math.floor(diff/60)}m前`;
                    if (diff < 86400) return `${Math.floor(diff/3600)}h前`;
                    if (diff < 7*86400) return `${Math.floor(diff/86400)}天前`;
                    return new Date(ts*1000).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
                  };
                  // 在线 = 已托管(shim linked) 或 api-key 应用；离线 = 已安装但用户取消托管
                  const isOnline = app.link_method === 'api-key' || app.linked;
                  const statusDot = isOnline
                    ? (app.link_method === 'api-key' ? 'bg-blue-400' : 'bg-green-400 shadow-[0_0_6px] shadow-green-400/60')
                    : 'bg-gray-300 dark:bg-gray-600';
                  const rowBg = isOnline
                    ? (app.link_method === 'api-key'
                        ? 'bg-blue-50/40 dark:bg-blue-950/10'
                        : 'bg-green-50/60 dark:bg-green-950/15')
                    : 'bg-gray-50/50 dark:bg-gray-800/20';
                  return (
                    <div key={app.id} className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${rowBg} ${isOnline ? '' : 'opacity-60'}`}>
                      {/* 图标 + 名称 */}
                      <span className={`text-base shrink-0 ${isOnline ? '' : 'grayscale'}`}>{app.icon}</span>
                      <div className={`text-xs font-medium truncate w-28 shrink-0 ${isOnline ? 'text-gray-800 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}>{app.name}</div>

                      {/* 状态列（在线/离线） */}
                      <div className="w-14 shrink-0 flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
                        <span className={`text-[11px] font-medium ${isOnline ? (app.link_method === 'api-key' ? 'text-blue-500' : 'text-green-600 dark:text-green-400') : 'text-gray-400'}`}>
                          {isOnline ? '在线' : '离线'}
                        </span>
                      </div>

                      {/* 接入方式列 */}
                      <div className="w-16 shrink-0 text-[11px] text-gray-400 truncate">
                        {LINK_METHOD_LABEL[app.link_method] || app.link_method}
                      </div>

                      {/* 统计：请求数 / token / 最后使用 */}
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-center w-12">
                          <div className="text-xs font-semibold text-gray-700 dark:text-gray-200">{st.calls > 0 ? st.calls.toLocaleString() : '—'}</div>
                          <div className="text-[9px] text-gray-400">请求</div>
                        </div>
                        <div className="text-center w-12">
                          <div className="text-xs font-semibold text-gray-700 dark:text-gray-200">{st.tokens > 0 ? fmtTokens(st.tokens) : '—'}</div>
                          <div className="text-[9px] text-gray-400">Token</div>
                        </div>
                        <div className="text-center w-14">
                          <div className="text-[10px] font-medium text-gray-600 dark:text-gray-300">{fmtTime(st.lastTs)}</div>
                          <div className="text-[9px] text-gray-400">最后用</div>
                        </div>
                      </div>

                      {/* 路由下拉：同时显示模型（按层级分组）和场景路由 */}
                      <select
                        value={app.route_id || ''}
                        onChange={async e => {
                          const val = e.target.value || null;
                          if (app._virtual) {
                            const created = await window.electronAPI.apps?.ensureShimApp({
                              agent_id: app.agent_id, name: app.name, icon: app.icon,
                            }).catch(() => null);
                            if (created) await window.electronAPI.apps?.update({ id: created.id, route_id: val }).catch(() => {});
                          } else {
                            await window.electronAPI.apps?.update({ id: app.id, route_id: val }).catch(() => {});
                          }
                          await load();
                        }}
                        className="flex-1 min-w-0 text-[10px] bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-1 outline-none text-gray-600 dark:text-gray-400 max-w-[160px]">
                        <option value="">不绑定</option>
                        {routes.length > 0 && (
                          <optgroup label="场景路由">
                            {routes.map(r => (
                              <option key={r.id} value={r.model_key || r.id}>{r.icon} {r.scene_name}</option>
                            ))}
                          </optgroup>
                        )}
                        {['free','p2p','paid'].map(tier => {
                          const tierModels = availableModels.filter(m => m.tier === tier);
                          if (!tierModels.length) return null;
                          const label = tier === 'free' ? '🟢 免费模型' : tier === 'p2p' ? '🔵 P2P 模型' : '🟣 付费模型';
                          return (
                            <optgroup key={tier} label={label}>
                              {tierModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
                            </optgroup>
                          );
                        })}
                      </select>

                      {/* 操作按钮：api-key 类显示设置；shim 类自动托管无需按钮 */}
                      {app.link_method === 'api-key' && (
                        <button onClick={() => setSettings(app)}
                          className="text-[10px] px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0">
                          设置
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              💡 已安装的 CLI 工具会自动托管（无需手动操作）；托管后需重开终端生效，关闭 Token Bank 时自动还原。
            </p>
          </div>
    </>
  );
}

function AgentLinker() {
  const [agents, setAgents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState({});   // id → true
  const [notice, setNotice]   = useState({});   // id → 提示文字

  const refresh = useCallback(async () => {
    try { setAgents(await listAgents()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleApply(id) {
    setBusy(b => ({ ...b, [id]: true }));
    setNotice(n => ({ ...n, [id]: '' }));
    try {
      const r = await applyAgent(id);
      if (r.ok) {
        let msg = r.needsRestartShell ? '✓ 已接入，重开终端后生效' : '✓ 已接入';
        if (r.enabledProvider) msg += `，已开启供给源 [${r.enabledProvider}]，请去供给源页填写 Key`;
        setNotice(n => ({ ...n, [id]: msg }));
        await refresh();
      } else {
        setNotice(n => ({ ...n, [id]: '✗ ' + (r.error || '失败') }));
      }
    } catch (e) { setNotice(n => ({ ...n, [id]: '✗ ' + e.message })); }
    setBusy(b => ({ ...b, [id]: false }));
  }

  async function handleRevert(id) {
    setBusy(b => ({ ...b, [id]: true }));
    setNotice(n => ({ ...n, [id]: '' }));
    try {
      const r = await revertAgent(id);
      if (r.ok) { setNotice(n => ({ ...n, [id]: '✓ 已还原' })); await refresh(); }
      else       { setNotice(n => ({ ...n, [id]: '✗ ' + (r.error || '失败') })); }
    } catch (e) { setNotice(n => ({ ...n, [id]: '✗ ' + e.message })); }
    setBusy(b => ({ ...b, [id]: false }));
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">🔌</span>
        <h2 className="font-semibold text-gray-800 dark:text-gray-100 text-sm">CLI Agent 透明接入</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">自动把本机 CLI 工具流量导入网关，无需手动配置</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={refresh} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">↻ 刷新</button>
          <ImportConfigButton onImported={refresh} />
        </div>
      </div>
      {loading ? (
        <div className="text-xs text-gray-400 py-2">检测中…</div>
      ) : agents.length === 0 ? (
        <div className="text-xs text-gray-400 py-2">未检测到已知 CLI Agent（配置文件加载中）</div>
      ) : (
        <div className="flex flex-col gap-2">
          {agents.map(a => (
            <div key={a.id}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-sm transition-colors
                ${!a.installed ? 'opacity-40 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/30' :
                  a.linked ? 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30' :
                             'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40'}`}
            >
              {/* 状态点 */}
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                !a.installed ? 'bg-gray-300 dark:bg-gray-600' :
                a.linked     ? 'bg-green-400' : 'bg-gray-400 dark:bg-gray-500'}`} />

              {/* 名称 + 策略 */}
              <div className="flex-1 min-w-0">
                <span className="font-medium text-gray-800 dark:text-gray-100">{a.name}</span>
                <span className="ml-2 text-xs text-gray-400">
                  {a.installed ? (STRATEGY_LABEL[a.strategy] || a.strategy) : '未安装'}
                </span>
              </div>

              {/* 接入状态标签 */}
              {a.installed && (
                <span className={`text-xs px-2 py-0.5 rounded-full shrink-0
                  ${a.linked ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                  {a.linked ? '接入中' : '未接入'}
                </span>
              )}

              {/* 提示文字 */}
              {notice[a.id] && (
                <span className={`text-xs shrink-0 max-w-[200px] truncate ${notice[a.id].startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}
                  title={notice[a.id]}>
                  {notice[a.id]}
                </span>
              )}

              {/* 操作按钮 */}
              {a.installed && !a.linked && (
                <button
                  disabled={busy[a.id]}
                  onClick={() => handleApply(a.id)}
                  className="shrink-0 text-xs px-3 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors">
                  {busy[a.id] ? '接入中…' : '一键接入'}
                </button>
              )}
              {a.installed && a.linked && (
                <button
                  disabled={busy[a.id]}
                  onClick={() => handleRevert(a.id)}
                  className="shrink-0 text-xs px-3 py-1 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 disabled:opacity-50 transition-colors">
                  {busy[a.id] ? '还原中…' : '还原'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
        💡 接入后需<b>重开终端</b>才能对新启动的工具生效；关闭 Token Bank 时自动还原。
      </p>
    </div>
  );
}

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
  const [mainTab, setMainTab]   = useState(0);   // 0=应用列表 1=场景路由

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

      {/* 应用列表 / 场景路由 Tab */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="flex border-b border-gray-200 dark:border-gray-800">
          {['📱 应用列表', '🔀 场景路由'].map((t, i) => (
            <button key={i} onClick={() => setMainTab(i)}
              className={`px-5 py-3 text-sm font-medium transition-colors ${mainTab === i
                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-500'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* Tab0: 应用列表 & 托管 */}
        {mainTab === 0 && (
          <AppManager externalRoutes={routes} availableModels={availableModels} />
        )}

        {/* Tab1: 场景路由 */}
        {mainTab === 1 && (
        <div>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">场景路由</h2>
            <p className="text-xs text-gray-500 mt-0.5">定义每个场景的模型降级链，通过 llm-router-xxx 触发</p>
          </div>
          <div className="flex items-center gap-2">
            <ImportConfigButton onImported={refresh} endpoint="/api/config/scenes" />
            <button
              onClick={() => { setExpandedRoute(null); setNewRoute({ scene_name: '', icon: '🔀', steps: [] }); }}
              className="text-xs bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 px-3 py-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >+ 新建路由</button>
          </div>
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
        )}
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
