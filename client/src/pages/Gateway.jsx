import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getRates, getOnlineModels } from '../api/client';
import { getGateway, getLocalConfig, getConfig } from '../api/adapter';
import { listAgents, applyAgent, revertAgent } from '../api/agents';
import claudeDevModeImg1 from '../assets/claude-devmode-1.webp';
import claudeDevModeImg2 from '../assets/claude-devmode-2.webp';

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

// ── ImportConfigButton：在线同步（从服务器下发配置）─────────────────────────────
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

  // 同步成功提示：带上新增的应用 / 路由数量
  function importedMsg(r, prefix) {
    const apps = Array.isArray(r.addedApps) ? r.addedApps : [];
    const routes = Array.isArray(r.addedRoutes) ? r.addedRoutes : [];
    const parts = [];
    if (apps.length)   parts.push(`新增 ${apps.length} 个应用：${apps.join('、')}`);
    if (routes.length) parts.push(`新增 ${routes.length} 条路由：${routes.join('、')}`);
    if (parts.length)  return `${prefix}，${parts.join('；')}`;
    return `${prefix}（无新增）`;
  }

  async function handleUrl() {
    const base = serverBase.trim().replace(/\/$/, '');
    if (!base || !window.electronAPI?.toolsConfig) return;
    const fullUrl = base + endpoint;
    setBusy(true); setMsg('');
    // 服务器配置端点需用户 JWT 鉴权，带上本地登录 token
    const token = localStorage.getItem('token');
    const r = await window.electronAPI.toolsConfig.importUrl(fullUrl, token);
    setMsg(r.ok ? '✓ ' + importedMsg(r, '已同步') : '✗ ' + r.error);
    if (r.ok && onImported) { onImported(); setShowUrl(false); }
    setBusy(false);
  }

  return (
    <div className="relative">
      <button disabled={busy} onClick={openUrl}
        className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
        {busy ? '同步中…' : '🔄 在线同步'}
      </button>
      {msg && <div className={`text-xs mt-1 ${msg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</div>}
      {showUrl && (
        <div className="absolute right-0 top-8 z-10 flex items-center gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 shadow-lg min-w-max">
          <input value={serverBase} onChange={e => setServerBase(e.target.value)}
            placeholder="https://your-server.com"
            className="text-xs bg-transparent border-none outline-none text-gray-700 dark:text-gray-200 w-52" />
          <span className="text-[10px] text-gray-400 shrink-0 font-mono">{endpoint}</span>
          <button onClick={handleUrl} disabled={busy || !serverBase.trim()}
            className="text-xs px-2 py-0.5 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 shrink-0">
            同步
          </button>
        </div>
      )}
    </div>
  );
}

// ── AppManager：应用列表（Tab1: 所有应用 & 托管 | Tab2: API Key 管理）────────
const LINK_METHOD_LABEL = { shim: '应用', 'api-key': '应用', manual: 'API', direct: '直连' };
// 按 API Key 路由的应用：自动写配置的 api-key，和用户自配的 manual（手工添加）
const isKeyApp = (m) => m === 'api-key' || m === 'manual';

const STRATEGY_LABEL = {
  'base_url-env': '环境变量注入 base_url',
  'config-file':  '自动写入配置文件',
  'mitm-env':     '代理 + 证书注入',
};

// 单个应用的设置面板（路由规则绑定 + 详细配置）
function AppSettingsPanel({ app, routes, availableModels = [], localBase = '', onUpdate, onDelete, onRegenKey, onCancelManage, onWritten, onClose, onCancel }) {
  const dismiss = onCancel || onClose;   // ✕/取消/点遮罩 → 取消（新应用未保存会被丢弃）
  const [name,        setName]        = useState(app.name || '');
  const [icon,        setIcon]        = useState(app.icon || '🔧');
  const [desc,        setDesc]        = useState(app.description || '');
  const [routeId,     setRouteId]     = useState(app.route_id || '');
  const [allowStream, setAllowStream] = useState(app.allow_stream !== false);
  const [maxRpm,      setMaxRpm]      = useState(app.max_rpm || '');
  const [maxConc,     setMaxConc]     = useState(app.max_concurrent || '');
  const [models,      setModels]      = useState((app.allowed_models || []).join(', '));
  const [busy,        setBusy]        = useState(false);
  const [copied,      setCopied]      = useState(false);
  const [claudeDevMode, setClaudeDevMode] = useState(null); // Claude Desktop 开发者模式状态
  // config-file 类 API Key 应用：两 Tab（0=配置文件写入和 API Key｜1=路由规则和请求控制）
  const isCfg = app.link_method === 'api-key' && !!app.config_file;
  const isShim = app.link_method === 'shim';   // 透明托管：只编辑路由规则 + 请求控制
  const isClaudeDesktop = app.preset_id === 'claude-desktop';
  // Claude Desktop 且开发者模式未就绪 → 需引导用户先启用
  const needDevMode = isClaudeDesktop && claudeDevMode && !claudeDevMode.dev_mode_ready;
  const [tab,         setTab]         = useState(0);
  const [written,     setWritten]     = useState(!!app.configured);  // 配置文件是否已写入（决定显示「取消 API Key 管理」）

  // Claude Desktop：检测开发者模式是否就绪
  useEffect(() => {
    if (!isClaudeDesktop) return;
    (async () => {
      try {
        const st = await window.electronAPI?.apps?.claudeDevModeStatus?.();
        setClaudeDevMode(st || null);
      } catch {}
    })();
  }, [isClaudeDesktop]);

  // 网关 origin（去掉 /v1），用于解析环境变量模板里的 {BASE}
  const gwOrigin = (localBase || 'http://127.0.0.1:11430/v1').replace(/\/v1\/?$/, '');
  // 只对字符串做占位符替换；布尔/数字（如 modelDiscoveryEnabled: false）原样保留类型
  const resolveEnv = (tpl) => typeof tpl === 'string'
    ? tpl.replace(/\{BASE\}/g, gwOrigin).replace(/\{KEY\}/g, app.api_key || '')
    : tpl;
  // 环境变量编辑文本（VAR=value，每行一条）
  const [envText, setEnvText] = useState(() =>
    app.env ? Object.entries(app.env).map(([k, v]) => `${k}=${resolveEnv(v)}`).join('\n') : '');
  const [writeMsg, setWriteMsg] = useState('');

  function parseEnvText(text) {
    const out = {};
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
    return out;
  }

  async function save() {
    setBusy(true);
    await onUpdate({
      id: app.id, name, icon, description: desc,
      route_id: routeId || null,
      allow_stream: allowStream,
      max_rpm: maxRpm ? +maxRpm : null,
      max_concurrent: maxConc ? +maxConc : null,
      allowed_models: models.split(',').map(s => s.trim()).filter(Boolean),
      ...(app.env && !app.config_file ? { env: parseEnvText(envText) } : {}),
    });
    setBusy(false);
    onClose();
  }

  async function writeEnv() {
    setWriteMsg('');
    const r = await window.electronAPI?.apps?.writeEnv(parseEnvText(envText)).catch(e => ({ ok: false, error: e.message }));
    if (r?.ok) setWriteMsg(`✓ 已写入 ${r.count} 个环境变量，重开终端后生效`);
    else setWriteMsg('✗ ' + (r?.error || '写入失败'));
  }

  // config-file 注入：解析 {BASE}/{KEY} 后改目标工具配置文件（如 Codex Desktop ~/.codex/config.toml）
  async function writeConfigFile(force = false) {
    setWriteMsg('');
    const patch = {};
    for (const [k, v] of Object.entries(app.patch || {})) patch[k] = resolveEnv(v);
    const env = {};
    for (const [k, v] of Object.entries(app.env || {})) env[k] = resolveEnv(v);
    const r = await window.electronAPI?.apps?.writeConfigFile({
      app_id: app.id, config_file: app.config_file, patch, env, force,
    }).catch(e => ({ ok: false, error: e.message }));
    // 冲突：目标配置项已有不同的值 → 弹确认显示当前值，确认后强制覆盖
    if (r && !r.ok && Array.isArray(r.conflicts) && r.conflicts.length) {
      const lines = r.conflicts.map(c => `· ${c.key}\n    当前: ${c.current}\n    将改为: ${c.wanted}`).join('\n');
      const ok = window.confirm(`配置文件已有不同的配置，是否覆盖？\n\n${lines}\n\n确定覆盖请点「确定」。`);
      if (ok) return writeConfigFile(true);   // 用户确认 → 强制覆盖
      setWriteMsg('✗ 已取消（未覆盖现有配置）');
      return;
    }
    if (r?.ok) {
      setWriteMsg(`✓ 已写入 ${r.file}${r.envCount ? `（含 ${r.envCount} 个环境变量）` : ''}，重启该应用后生效`);
      setWritten(true);     // 已写入 → 显示「取消 API Key 管理」
      onWritten?.();        // 通知父级：该应用已落地（清除 _isNew，取消时不再删除）
    } else setWriteMsg('✗ ' + (r?.error || '写入失败'));
  }

  const ICONS = ['🤖','✏️','🔧','💻','🎯','🌐','📱','🔑','⚡','🛠️','🎨','📊'];

  // ── 各区块（按布局组合：config-file 应用走两 Tab，其余走单页）──
  const baseInfoSection = (
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
  );

  const apiKeyRow = isKeyApp(app.link_method) && app.api_key && (
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
  );

  const envSection = app.link_method === 'api-key' && app.env && !app.config_file && (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">环境变量（写入后该工具指向网关）</div>
        <button onClick={writeEnv}
          className="text-xs px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white shrink-0">
          写入配置
        </button>
      </div>
      <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={Math.max(2, envText.split('\n').length)}
        spellCheck={false}
        className="w-full font-mono text-[11px] bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 outline-none focus:border-blue-400 text-gray-700 dark:text-gray-200 resize-y"
        placeholder="VAR=value（每行一条）" />
      {writeMsg && <div className={`text-[11px] mt-1 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
      <div className="text-[10px] text-gray-400 mt-1">
        💡 「写入配置」会把上述变量写入系统（Windows: 用户环境变量；macOS/Linux: shell 配置），重开终端后该工具即指向本网关。
      </div>
    </div>
  );

  // 配置文件注入（信息展示；写入按钮在底部）
  // Claude Desktop 开发者模式引导（configLibrary 为空时显示）
  const devModeGuide = needDevMode && (
    <div className="rounded-lg border border-amber-300 dark:border-amber-700/50 bg-amber-50/60 dark:bg-amber-950/20 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">⚠️</span>
        <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">需要先在 Claude Desktop 启用开发者模式</span>
      </div>
      <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1 mb-3">
        <p>检测到 Claude Desktop 已安装，但还没启用第三方网关（开发者模式）。请按以下步骤操作：</p>
        <p>1️⃣ 打开 Claude Desktop → 顶部菜单 <b>Help → Troubleshooting → Enable Developer Mode</b></p>
        <p>2️⃣ 重启 Claude Desktop，首屏会出现 <b>Configure third-party inference</b>，选择 <b>Gateway</b></p>
        <p>3️⃣ 完成后回到本页点「刷新」，即可自动写入网关配置</p>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <div className="text-[10px] text-gray-400 mb-1">步骤 1：启用开发者模式</div>
          <img src={claudeDevModeImg1} alt="Enable Developer Mode" className="rounded border border-gray-200 dark:border-gray-700 w-full" />
        </div>
        <div>
          <div className="text-[10px] text-gray-400 mb-1">步骤 2：选择 Gateway</div>
          <img src={claudeDevModeImg2} alt="Configure Gateway" className="rounded border border-gray-200 dark:border-gray-700 w-full" />
        </div>
      </div>
      <button
        onClick={async () => {
          const st = await window.electronAPI?.apps?.claudeDevModeStatus?.();
          setClaudeDevMode(st || null);
          if (st?.dev_mode_ready) setWriteMsg('✓ 已检测到开发者模式，可以写入配置了');
          else setWriteMsg('✗ 仍未检测到，请确认已启用开发者模式并重启 Claude Desktop');
        }}
        className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors">
        🔄 我已启用，刷新检测
      </button>
      {writeMsg && <div className={`text-[11px] mt-2 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
    </div>
  );

  const configFileSection = app.config_file && (
    <div>
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">配置文件注入（指向网关）</div>
      <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-2 space-y-1">
        <div className="font-mono text-[11px] text-gray-700 dark:text-gray-300 break-all">{app.config_file}</div>
        {Object.entries(app.patch || {}).map(([k, v]) => (
          <div key={k} className="font-mono text-[10px] text-gray-500 break-all">{k} = {resolveEnv(v)}</div>
        ))}
        {Object.keys(app.env || {}).length > 0 && (
          <div className="font-mono text-[10px] text-gray-400 pt-1">+ 环境变量：{Object.keys(app.env).join(', ')}</div>
        )}
      </div>
      {writeMsg && <div className={`text-[11px] mt-1 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
      <div className="text-[10px] text-gray-400 mt-1">
        💡 「写入配置」会改写上述配置文件并指向本网关（API 模式）；需用 API Key 登录该应用，重启后生效。
      </div>
    </div>
  );

  const routeSection = (isKeyApp(app.link_method) || app.link_method === 'shim') && app.route_bindable !== false && (
    <div>
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">路由规则（模型或场景路由）</div>
      <select value={routeId} onChange={e => setRouteId(e.target.value)}
        className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 outline-none text-gray-800 dark:text-gray-200">
        {/* manual（手工添加）无官方可直连 → 必须绑定，「直连」改为不可选占位 */}
        {app.link_method === 'manual'
          ? <option value="" disabled>请选择模型 / 路由（手工添加必须绑定）</option>
          : <option value="">直连（不路由，用原始模型名）</option>}
        {(() => {
          const avail = new Set(availableModels.map(m => m.id));
          const usable = routes.filter(r => (r.steps || []).some(s => avail.has(s.model || s.label)));
          return usable.length > 0 && (
            <optgroup label="场景路由">
              {usable.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon} {r.scene_name}</option>)}
            </optgroup>
          );
        })()}
        {['free','p2p','paid'].map(tier => {
          const tm = availableModels.filter(m => m.tier === tier);
          if (!tm.length) return null;
          const label = tier === 'free' ? '🟢 免费模型' : tier === 'p2p' ? '🔵 P2P 模型' : '🟣 付费模型';
          return <optgroup key={tier} label={label}>{tm.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>;
        })}
      </select>
    </div>
  );

  const controlSection = (isKeyApp(app.link_method) || app.link_method === 'shim') && (
    <div>
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">请求控制</div>
      <div className="space-y-2">
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
  );

  const accessSection = isKeyApp(app.link_method) && app.api_key && !app.env && !app.config_file && (
    <div>
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">接入配置</div>
      <KeyConfigPanel apiKey={app.api_key} localBase="http://127.0.0.1:11430/v1"
        model={routeId || undefined} hideAuto />
    </div>
  );

  const btnSave = (
    <button onClick={save} disabled={busy}
      className="flex-1 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
      {busy ? '保存中…' : '保存'}
    </button>
  );
  const btnCancel = (
    <button onClick={dismiss}
      className="px-4 py-2 text-sm rounded-xl border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400">
      取消
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={dismiss}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-2xl mx-4 max-h-[92vh] overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <span className="text-xl">{icon}</span>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex-1">{app.name || '应用设置'}</h3>
          <button onClick={dismiss} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg">✕</button>
        </div>

        {(isCfg || isShim) ? (
          /* 纳管（config-file API Key / 透明托管）：编辑只保留路由规则 + 请求控制。
             配置文件写入/还原由列表的「纳管 / 还原」按钮完成，这里不再有 API Key 那个 Tab。*/
          <>
            <div className="p-5 space-y-4">
              {routeSection}{controlSection}
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-800">
              {btnSave}{btnCancel}
            </div>
          </>
        ) : (
          <>
            <div className="p-5 space-y-4">
              {baseInfoSection}{apiKeyRow}{envSection}{routeSection}{controlSection}{accessSection}
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-800">
              {onDelete && isKeyApp(app.link_method) && (
                <button onClick={() => onDelete(app.id)}
                  className="px-4 py-2 text-sm rounded-xl border border-red-200 dark:border-red-900/50 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                  删除
                </button>
              )}
              {btnSave}{btnCancel}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 手工添加面板（内联）：未被识别的应用 —— 仅给 Key + base_url，用户自行配置指向网关。
// 与 AppSettingsPanel（弹窗，用于编辑/桌面应用托管）是两套独立组件。
function ManualAddPanel({ app, routes, availableModels = [], onUpdate, onRegenKey, onSave, onCancel }) {
  const [name,        setName]        = useState(app.name || '');
  const [icon,        setIcon]        = useState(app.icon || '🔧');
  const [desc,        setDesc]        = useState(app.description || '');
  const [routeId,     setRouteId]     = useState(app.route_id || '');
  const [allowStream, setAllowStream] = useState(app.allow_stream !== false);
  const [maxRpm,      setMaxRpm]      = useState(app.max_rpm || '');
  const [maxConc,     setMaxConc]     = useState(app.max_concurrent || '');
  const [models,      setModels]      = useState((app.allowed_models || []).join(', '));
  const [busy,        setBusy]        = useState(false);
  const [copied,      setCopied]      = useState(false);
  const ICONS = ['🤖','✏️','🔧','💻','🎯','🌐','📱','🔑','⚡','🛠️','🎨','📊'];

  async function save() {
    setBusy(true);
    await onUpdate({
      id: app.id, name, icon, description: desc,
      route_id: routeId || null,
      allow_stream: allowStream,
      max_rpm: maxRpm ? +maxRpm : null,
      max_concurrent: maxConc ? +maxConc : null,
      allowed_models: models.split(',').map(s => s.trim()).filter(Boolean),
    });
    setBusy(false);
    onSave();
  }

  return (
    <div className="mb-3 bg-white dark:bg-gray-900 rounded-2xl border border-blue-200 dark:border-blue-800/50 shadow-sm">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-gray-800">
        <span className="text-xl">{icon}</span>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex-1">新建应用</h3>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg">✕</button>
      </div>
      <div className="p-5 space-y-4">
        {/* 基础信息 */}
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">基础信息</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="应用名称"
            className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-gray-800 dark:text-gray-200 mb-2" />
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
        {/* API Key */}
        {app.api_key && (
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
        {/* 路由规则 */}
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">路由规则（模型或场景路由）</div>
          <select value={routeId} onChange={e => setRouteId(e.target.value)}
            className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 outline-none text-gray-800 dark:text-gray-200">
            {/* 手工添加无官方可直连 → 必须绑定 */}
            <option value="" disabled>请选择模型 / 路由（手工添加必须绑定）</option>
            {(() => {
              const avail = new Set(availableModels.map(m => m.id));
              const usable = routes.filter(r => (r.steps || []).some(s => avail.has(s.model || s.label)));
              return usable.length > 0 && (
                <optgroup label="场景路由">
                  {usable.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon} {r.scene_name}</option>)}
                </optgroup>
              );
            })()}
            {['free','p2p','paid'].map(tier => {
              const tm = availableModels.filter(m => m.tier === tier);
              if (!tm.length) return null;
              const label = tier === 'free' ? '🟢 免费模型' : tier === 'p2p' ? '🔵 P2P 模型' : '🟣 付费模型';
              return <optgroup key={tier} label={label}>{tm.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>;
            })}
          </select>
        </div>
        {/* 请求控制 */}
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">请求控制</div>
          <div className="space-y-2">
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
        {/* 接入配置：Key + base_url + 示例（用户自行把应用指向网关）*/}
        {app.api_key && (
          <div>
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">接入配置（把你的应用指向以下地址）</div>
            <KeyConfigPanel apiKey={app.api_key} localBase="http://127.0.0.1:11430/v1"
              model={routeId || undefined} hideAuto />
          </div>
        )}
      </div>
      <div className="flex gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-800">
        <button onClick={save} disabled={busy}
          className="flex-1 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
          {busy ? '保存中…' : '保存'}
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 text-sm rounded-xl border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400">
          取消
        </button>
      </div>
    </div>
  );
}

// 单个应用的用量明细弹窗（合并网关实时 proxy + 会话补录 session-*，已在 DB 层按 request_id 去重）
function AppDetailModal({ app, onClose }) {
  const [days, setDays]       = useState(30);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    window.electronAPI?.apps?.detail?.(app, days)
      .then(d => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [app, days]);

  const fmtN = n => n >= 1_000_000 ? (n/1e6).toFixed(2)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);
  const fmtTime = ts => ts ? new Date(ts*1000).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  const shortId = id => id ? (String(id).length > 12 ? String(id).slice(0,8)+'…'+String(id).slice(-4) : String(id)) : '—';
  const proxy   = data?.bySource?.find(s => s.source === 'proxy')   || { calls:0, tokens:0 };
  const session = data?.bySource?.find(s => s.source === 'session') || { calls:0, tokens:0 };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-3xl mx-4 max-h-[92vh] overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900 z-10">
          <span className="text-xl">{app.icon}</span>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex-1">{app.name} · 用量明细</h3>
          <select value={days} onChange={e => setDays(+e.target.value)}
            className="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 outline-none text-gray-600 dark:text-gray-300">
            <option value={7}>近 7 天</option><option value={30}>近 30 天</option><option value={90}>近 90 天</option>
          </select>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg">✕</button>
        </div>

        {loading ? (
          <div className="py-16 flex flex-col items-center gap-2 text-xs text-gray-400">
            <div className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin" />加载中…
          </div>
        ) : !data ? (
          <div className="py-16 text-center text-xs text-gray-400">没有数据</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* 总计 */}
            <div className="grid grid-cols-4 gap-3">
              {[['总请求数', fmtN(data.total.calls)], ['总Token', fmtN(data.total.tokens)],
                ['输入Token', fmtN(data.total.inTok)], ['输出Token', fmtN(data.total.outTok)]].map(([l,v]) => (
                <div key={l} className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3">
                  <div className="text-[10px] text-gray-400 dark:text-gray-500">{l}</div>
                  <div className="text-xl font-bold text-gray-800 dark:text-gray-100 mt-0.5">{v}</div>
                </div>
              ))}
            </div>

            {/* 来源拆分 */}
            <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40 rounded-lg px-3 py-2">
              来源：<span className="text-blue-600 dark:text-blue-400 font-medium">🛰️ 网关实时</span> {proxy.calls} 次 · {fmtN(proxy.tokens)} tok
              <span className="mx-2 text-gray-300">|</span>
              <span className="text-green-600 dark:text-green-400 font-medium">📄 会话补录</span> {session.calls} 次 · {fmtN(session.tokens)} tok
              <div className="text-[10px] text-gray-400 mt-1">「网关实时」=经本网关转发；「会话补录」=直连官方、从本地会话(JSONL)解析。同一次调用已按 request_id 去重，不重复计。</div>
            </div>

            {/* 按模型 */}
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">按模型</div>
              {data.byModel.length === 0 ? <div className="text-xs text-gray-400">—</div> : (
                <div className="border border-gray-100 dark:border-gray-800 rounded-lg divide-y divide-gray-100 dark:divide-gray-800">
                  {data.byModel.map(m => (
                    <div key={m.model} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                      <span className="font-mono text-gray-700 dark:text-gray-300 flex-1 truncate">{m.model}</span>
                      <span className="text-gray-500 w-16 text-right">{m.calls} 次</span>
                      <span className="text-gray-700 dark:text-gray-300 w-20 text-right font-medium">{fmtN(m.tokens)} tok</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 按会话 */}
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">按会话（{data.sessions.length}）</div>
              {data.sessions.length === 0 ? <div className="text-xs text-gray-400">无会话记录（API 类应用通常没有会话文件）</div> : (
                <div className="border border-gray-100 dark:border-gray-800 rounded-lg divide-y divide-gray-100 dark:divide-gray-800 max-h-56 overflow-y-auto">
                  {data.sessions.map(s => (
                    <div key={s.session_id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                      <span className="font-mono text-gray-600 dark:text-gray-400 flex-1 truncate" title={s.session_id}>{shortId(s.session_id)}</span>
                      <span className="text-gray-500 w-12 text-right">{s.calls} 次</span>
                      <span className="text-gray-700 dark:text-gray-300 w-20 text-right font-medium">{fmtN(s.tokens)} tok</span>
                      <span className="text-gray-400 w-28 text-right">{fmtTime(s.lastTs)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 最近明细 */}
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">最近明细</div>
              {data.recent.length === 0 ? <div className="text-xs text-gray-400">—</div> : (
                <div className="border border-gray-100 dark:border-gray-800 rounded-lg divide-y divide-gray-100 dark:divide-gray-800 max-h-72 overflow-y-auto">
                  {data.recent.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                      <span className="text-gray-400 w-24 shrink-0">{fmtTime(r.ts)}</span>
                      <span className={`px-1 rounded text-[9px] shrink-0 ${r.source === 'proxy' ? 'bg-blue-50 text-blue-500 dark:bg-blue-900/20' : 'bg-green-50 text-green-600 dark:bg-green-900/20'}`}>
                        {r.source === 'proxy' ? '网关' : '会话'}
                      </span>
                      <span className="font-mono text-gray-600 dark:text-gray-400 flex-1 truncate">{r.model || '—'}</span>
                      <span className="text-gray-500 shrink-0">↑{fmtN(r.inTok)} ↓{fmtN(r.outTok)}</span>
                      {r.status_code != null && r.status_code >= 400 && <span className="text-red-500 shrink-0">{r.status_code}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AppManager({ externalRoutes, availableModels = [] }) {
  const [apps,     setApps]     = useState([]);
  const [detailApp, setDetailApp] = useState(null);   // 用量明细弹窗对应的 app
  const [claudeModels, setClaudeModels] = useState([]);  // Claude 名（写 Claude Desktop inferenceModels 用）
  const [routes,   setRoutes]   = useState([]);
  const [localBase, setLocalBase] = useState('');
  // 当 Gateway 的 routes 更新时同步进来（场景路由新建后立即可选）
  useEffect(() => { if (externalRoutes?.length) setRoutes(externalRoutes); }, [externalRoutes]);
  const [settings, setSettings] = useState(null);     // 设置弹窗对应的 app（编辑/桌面应用托管）
  const [manualDraft, setManualDraft] = useState(null); // 手工添加的内联面板对应的 app
  const [appStats, setAppStats] = useState({});     // id → {calls,tokens,lastTs}
  const [loading,  setLoading]  = useState(true);   // 首次加载中（应用检测较慢）→ 显示加载特效而非空状态

  const load = useCallback(async () => {
    if (!window.electronAPI) { setLoading(false); return; }
    try {
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
    } finally {
      setLoading(false);   // 首次置 false 后保持，后续刷新不再闪加载态
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Claude 名（Claude Desktop inferenceModels 的 name 只能用 Anthropic 名）
  useEffect(() => { window.electronAPI?.apps?.claudeModels?.().then(m => setClaudeModels(Array.isArray(m) ? m : [])).catch(() => {}); }, []);

  // 配置下发/变更后，主进程通知 → 重新加载应用列表（新托管/新可配置 api-key 行立即显示）
  useEffect(() => {
    const off = window.electronAPI?.apps?.onChanged?.(() => load());
    return () => { if (typeof off === 'function') off(); };
  }, [load]);

  // 手工添加点击时就先持久化了一条草稿（为了显示 api_key）。若用户没保存/取消就切走 tab
  // （AppManager 卸载），把这条未保存草稿删掉，否则切回来会多出一条「新应用」。
  const manualDraftRef = useRef(null);
  useEffect(() => { manualDraftRef.current = manualDraft; }, [manualDraft]);
  useEffect(() => () => {
    const d = manualDraftRef.current;
    if (d?._isNew && d.id) window.electronAPI.apps?.delete(d.id).catch(() => {});
  }, []);

  async function handleUpdateApp(data) {
    let id = data.id;
    // 虚拟 shim 应用（仅展示、未落库）：先落库拿到真实 id 再更新
    const app = apps.find(a => a.id === data.id);
    if (app?._virtual && app.link_method === 'shim') {
      const created = await window.electronAPI.apps?.ensureShimApp({
        agent_id: app.agent_id, name: app.name, icon: app.icon,
      }).catch(() => null);
      if (created?.id) id = created.id;
    }
    // 保存即清除草稿标记（新建面板保存后该应用才在列表显示）；对非草稿应用是无害的 no-op
    const updated = await window.electronAPI.apps?.update({ ...data, id, draft: false }).catch(() => null);
    // shim 应用：路由/key 改动后需重写 shim 脚本才生效
    if (app?.link_method === 'shim' && app.agent_id) {
      await window.electronAPI.agents?.apply(app.agent_id).catch(() => {});
    }
    await load();
    // 若设置弹窗仍开着且 id 未变，刷新其数据
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
      // 用最新 key 刷新设置弹窗 / 手工添加面板
      const fresh = (await window.electronAPI.apps?.list().catch(() => []) || []).find(a => a.id === id);
      if (fresh && settings?.id === id) setSettings(fresh);
      if (fresh && manualDraft?.id === id) setManualDraft({ ...fresh, _isNew: true });
    }
  }

  // 默认路由：新应用自动绑当前可用模型的第一个（P2P 在线 > 付费 > 免费）。
  // 否则「直连」会把客户端原始模型名（claude-*/gpt-*）直发，P2P 后端没有这些名字必 502。
  function defaultRouteId() {
    const order = { p2p: 0, paid: 1, free: 2 };
    const pick = [...availableModels].sort(
      (a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9))[0];
    return pick?.id || '';
  }

  // 手工添加：未被识别的应用 → 创建 manual 应用，内联展开 ManualAddPanel
  // （已识别的 CLI/桌面应用都在列表里直接托管，不走此入口）
  async function addCustom() {
    // draft:true → 列表不显示这条临时条目（只在内联面板里编辑），保存时清除草稿标记才出现。
    // 这样切 tab/不保存绝不会在列表里多出一条（不依赖卸载时的异步删除）。
    const created = await window.electronAPI.apps?.create({
      name: '新应用', icon: '🔧', link_method: 'manual',
      route_id: defaultRouteId() || null, draft: true,
    }).catch(() => null);
    if (created?.id) setManualDraft({ ...created, _isNew: true });
  }
  // 手工添加面板：保存（已在面板内持久化）→ 关闭并刷新
  function closeManualDraft() { setManualDraft(null); load(); }
  // 手工添加面板：取消 → 删除这条未保存的应用再刷新
  async function cancelManualDraft() {
    const d = manualDraft;
    setManualDraft(null);
    if (d?.id) await window.electronAPI.apps?.delete(d.id).catch(() => {});
    await load();
  }

  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState({});   // id → 提示文字
  function showNotice(id, msg, ms = 6000) {
    setNotice(n => ({ ...n, [id]: msg }));
    setTimeout(() => setNotice(n => { const c = { ...n }; delete c[id]; return c; }), ms);
  }

  // 纳管/还原（双轴的"纳管"轴）：
  //   纳管(on)  = 标记 hosted=true，默认进入「直连」（官方，只读会话文件统计，不写网关配置/不注入 shim）。
  //   还原(off) = 取消纳管 hosted=false（保留 route_id）+ 还原配置/撤 shim（回官方，不再读文件）。
  // 「绑路由/走网关」由路由下拉负责（选模型 → 写配置/注入 shim）。
  async function setTracked(app, on) {
    if (on) {
      let appId = app.id;
      if (app._virtual && app.link_method === 'shim') {
        const c = await window.electronAPI.apps?.ensureShimApp({ agent_id: app.agent_id, name: app.name, icon: app.icon }).catch(() => null);
        if (c) appId = c.id;
      }
      setBusyId(appId);
      // 不可直连(无本地用量源的桌面壳)：纳管直接走网关。优先复用上次选过的路由
      //（还原时已保留 route_id），没有再退默认路由——重新纳管即按原路由配置写入。
      if (app.allow_direct === false) {
        const rid = app.route_id || defaultRouteId();
        await window.electronAPI.apps?.update({ id: appId, hosted: true, route_id: rid || null }).catch(() => {});
        if (app.host_method === 'config-file') { await writeApiKeyConfig({ ...app, id: appId, route_id: rid || null }); showNotice(appId, '✓ 已纳管，重启应用后生效'); }
        else if (app.link_method === 'shim' && app.agent_id) { await window.electronAPI.agents?.apply(app.agent_id).catch(() => {}); showNotice(appId, '✓ 已纳管，重开终端后生效'); }
      } else {
        await window.electronAPI.apps?.update({ id: appId, hosted: true }).catch(() => {});   // 默认直连(只读文件)
      }
    } else {
      const msg = app.link_method === 'direct'
        ? '取消纳管该应用？将停止统计其会话日志（历史数据保留，可随时重新纳管）。'
        : '还原该应用？将取消纳管、恢复原始状态（不再读其会话文件统计；条目保留，可随时重新纳管）。';
      if (!window.confirm(msg)) return;
      // 虚拟 shim（未持久化）：先落条目，否则 hosted:false 无处可写，取消纳管不生效。
      let appId = app.id;
      if (app._virtual && app.link_method === 'shim') {
        const c = await window.electronAPI.apps?.ensureShimApp({ agent_id: app.agent_id, name: app.name, icon: app.icon }).catch(() => null);
        if (c) appId = c.id;
      }
      setBusyId(appId);
      if (app.link_method === 'shim' && app.agent_id) { await window.electronAPI.agents?.revert(app.agent_id).catch(() => {}); showNotice(appId, '✓ 已还原，重开终端后生效'); }
      else if (app.host_method === 'config-file') { await window.electronAPI.apps?.revertConfigFile({ app_id: appId, config_file: app.config_file }).catch(() => {}); showNotice(appId, '✓ 已还原，重启应用后生效'); }
      else if (app.link_method === 'direct') { showNotice(appId, '✓ 已取消纳管，停止统计'); }
      // 取消纳管并清空路由，回到「直连」状态。
      await window.electronAPI.apps?.update({ id: appId, hosted: false, route_id: null }).catch(() => {});
      if (settings?.id === appId) setSettings(null);
    }
    setBusyId(null);
    await load();
  }

  // 转发测试：用该应用的 api_key 向网关发一个最小请求，验证转发是否成功
  const [testState, setTestState] = useState({});   // appId -> {busy|ok|error|latency}
  async function runAppTest(app) {
    const key = app.api_key;
    if (!key) return;   // 无 key（未托管/虚拟行）不能测
    setTestState(s => ({ ...s, [app.id]: { busy: true } }));
    // 模型优先用绑定的路由；否则第一个可用真实模型；再否则一个占位
    const model = app.route_id || availableModels[0]?.id || 'gpt-4o';
    const base = (localBase || 'http://127.0.0.1:11430/v1').replace(/\/$/, '');
    const start = Date.now();
    // 流式 + max_tokens:1：首块计延迟（首字），但把流读完整，让网关正常结束并落账
    // （中途 abort 会导致不计入统计）；30s 硬超时防卡死。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'Hi' }] }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        const msg = b?.error?.detail || b?.error?.message || b?.detail || `HTTP ${res.status}`;
        setTestState(s => ({ ...s, [app.id]: { ok: false, error: msg, latency: Date.now() - start } }));
      } else {
        let latency = null;
        const reader = res.body?.getReader();
        if (reader) {
          // 读到首块即记下首字延迟，再把剩余流读完（让网关完成请求并落账）
          for (;;) {
            const { done } = await reader.read();
            if (latency == null) latency = Date.now() - start;
            if (done) break;
          }
        } else { latency = Date.now() - start; }
        setTestState(s => ({ ...s, [app.id]: { ok: true, latency } }));
        // 网关已落账 → 刷新统计（总请求数 / 总token）
        setTimeout(() => load(), 600);
      }
    } catch (e) {
      const msg = e?.name === 'AbortError' ? '超时（30s）' : (e?.message || '连接失败');
      setTestState(s => ({ ...s, [app.id]: { ok: false, error: msg, latency: Date.now() - start } }));
    } finally {
      clearTimeout(timer);
    }
    setTimeout(() => setTestState(s => ({ ...s, [app.id]: null })), 8000);
  }
  // 写入某 api-key 应用的配置文件指向网关（解析 {BASE}/{KEY}，处理冲突/失败）。
  // 返回 true=成功。onAbort：冲突取消/写入失败时的回滚回调（新建时删条目；重新纳管不删）。
  // Claude Desktop 的 inferenceModels 校验：name 必须是 Anthropic 模型名（claude-*）。
  // 所以 name 用 claude 名（过校验，keyScene 会把它改写成绑定的路由/模型），
  // labelOverride 显示我们绑定的「路由名 / 模型名」让用户看得懂。未绑路由(直连)则不写。
  function buildInferenceModels(app) {
    const claudeName = (claudeModels && claudeModels[0]) || 'claude-sonnet-4-5';
    const route = routes.find(x => x.model_key === app.route_id || x.id === app.route_id);
    let label = null;
    if (route) label = `${route.icon || '🔀'} ${route.scene_name}`;
    else if (app.route_id) label = app.route_id;   // 绑的是单个真实模型
    if (!label) return [];                          // 未绑路由（直连）→ 用默认
    return [{ name: claudeName, labelOverride: label }];
  }

  async function writeApiKeyConfig(app, { onAbort } = {}) {
    const gwOrigin = (localBase || 'http://127.0.0.1:11430/v1').replace(/\/v1\/?$/, '');
    const resolveTpl = (tpl) => typeof tpl === 'string'
      ? tpl.replace(/\{BASE\}/g, gwOrigin).replace(/\{KEY\}/g, app.api_key || '')
      : tpl;
    const isGatewayConfig = app.patch && 'inferenceProvider' in app.patch;   // Claude Desktop 等
    const isCodexConfig   = app.patch && 'model_provider' in app.patch;      // Codex Desktop（OpenAI 风格）
    const run = async (force) => {
      const patch = {}; for (const [k, v] of Object.entries(app.patch || {})) patch[k] = resolveTpl(v);
      const env   = {}; for (const [k, v] of Object.entries(app.env   || {})) env[k]   = resolveTpl(v);
      if (isGatewayConfig) {   // 显式 inferenceModels（不走 modelDiscovery，绕开 Anthropic 名校验）
        delete patch.modelDiscoveryEnabled;
        patch.coworkEgressAllowedHosts = ['*'];
        patch.disableDeploymentModeChooser = true;
        const im = buildInferenceModels(app);
        if (im.length) patch.inferenceModels = im;   // 为空则不写，Claude 用默认
      }
      // Codex：OpenAI 风格、接受任意模型名 → 顶层 model 写绑定的路由/模型（运行时按此发起请求）。
      // 注：Codex Desktop 的 GUI 模型选择器由其自身账号/provider 状态决定，配置文件改不动，仍显示「Custom」。
      if (isCodexConfig && app.route_id) patch.model = app.route_id;
      const r = await window.electronAPI?.apps?.writeConfigFile({
        app_id: app.id, config_file: app.config_file, patch, env, force,
      }).catch(e => ({ ok: false, error: e.message }));
      // 冲突：目标配置项已有不同的值 → 确认后强制覆盖；取消则回滚
      if (r && !r.ok && Array.isArray(r.conflicts) && r.conflicts.length) {
        const lines = r.conflicts.map(c => `· ${c.key}\n    当前: ${c.current}\n    将改为: ${c.wanted}`).join('\n');
        if (window.confirm(`配置文件已有不同的配置，是否覆盖？\n\n${lines}\n\n确定覆盖请点「确定」。`)) return run(true);
        await onAbort?.();
        return false;
      }
      if (!r?.ok) { await onAbort?.(); window.alert('纳管失败：' + (r?.error || '写入配置失败')); return false; }
      return true;
    };
    return run(false);
  }

  // API Key 应用（虚拟行）「纳管」：建条目 + 标记 hosted（默认直连，不写配置）。要走网关在路由下拉选模型。
  async function addApiKeyApp(d) {
    setBusyId(d.id);
    const created = await window.electronAPI.apps?.create({
      name: d.name, icon: d.icon, link_method: 'api-key',
      preset_id: d.preset_id, route_id: null,
      inject: 'config-file', config_file: d.config_file, patch: d.patch, env: d.env || null,
    }).catch(() => null);
    if (created?.id) await window.electronAPI.apps?.update({ id: created.id, hosted: true }).catch(() => {});
    setBusyId(null);
    if (created?.id) showNotice(created.id, '✓ 已纳管（默认直连，选模型即走网关）');
    await load();
  }

  // 已保存但已取消纳管的 api-key 应用「重新纳管」：用现有条目(同 api_key)重写配置 →
  // 请求数 / token 统计延续，不清零。失败不删条目，保留离线状态。
  async function rehostApiKeyApp(app) {
    setBusyId(app.id);
    // 可绑路由的应用纳管前确保有路由，否则 claude-* 等原始名直发会 502
    if (app.route_bindable !== false && !app.route_id) {
      const def = defaultRouteId();
      if (def) { await window.electronAPI.apps?.update({ id: app.id, route_id: def }).catch(() => {}); app = { ...app, route_id: def }; }
    }
    const ok = await writeApiKeyConfig(app);
    setBusyId(null);
    if (ok) showNotice(app.id, '✓ 已纳管，重启应用后生效');
    await load();
  }

  // 还原：仅还原配置文件，保留应用条目与统计（与透明托管「还原」一致，可随时重新纳管）。
  async function handleCancelManage(app) {
    if (!window.confirm('还原该应用？将取消纳管、恢复原始状态（不再读其会话文件统计；条目保留，可随时重新纳管）。')) return;
    setBusyId(app.id);
    const r = await window.electronAPI.apps?.revertConfigFile({ app_id: app.id, config_file: app.config_file }).catch(() => null);
    await window.electronAPI.apps?.update({ id: app.id, hosted: false, route_id: null }).catch(() => {});
    setBusyId(null);
    if (settings?.id === app.id) setSettings(null);
    if (!r || r.ok !== false) showNotice(app.id, '✓ 已还原，重启应用后生效');
    await load();
  }

  // 保存设置（已在面板内 onUpdate 持久化）→ 仅关闭并刷新
  function closeSettings() { setSettings(null); load(); }
  // 取消/关闭：若是未保存的新应用则删除（必须等删除完成再刷新，否则列表读到删除前的旧状态）
  async function cancelSettings() {
    const s = settings;
    setSettings(null);
    if (s?._isNew && s.id) {
      await window.electronAPI.apps?.delete(s.id).catch(() => {});
    }
    await load();
  }

  // 列表只显示非草稿条目（新建面板未保存的临时条目 draft:true 不进列表）
  const visibleApps = apps.filter(a => !a.draft);

  return (
    <>
      {/* 编辑已有应用 / 桌面应用托管 → 弹窗（AppSettingsPanel）*/}
      {settings && (
        <AppSettingsPanel app={settings} routes={routes} availableModels={availableModels} localBase={localBase}
          onUpdate={handleUpdateApp} onDelete={handleDeleteApp} onRegenKey={handleRegenKey}
          onCancelManage={handleCancelManage}
          onWritten={() => setSettings(s => s ? { ...s, _isNew: false, configured: true } : s)}
          onClose={closeSettings} onCancel={cancelSettings} />
      )}
      {/* 用量明细弹窗（点击统计区打开）*/}
      {detailApp && <AppDetailModal app={detailApp} onClose={() => setDetailApp(null)} />}
      <div className="p-4">
            {/* 操作栏 */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <button onClick={() => manualDraft ? cancelManualDraft() : addCustom()}
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors">
                + 新建应用
              </button>
              <span className="text-xs text-gray-400 dark:text-gray-500">已识别的应用在下方列表中纳管；此处新建未被识别的应用</span>
              <div className="ml-auto"><ImportConfigButton onImported={load} /></div>
            </div>

            {/* 提醒：纳管后若未生效需重启应用 */}
            <div className="mb-3 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-lg px-3 py-2">
              💡 点击「纳管」后若未生效，请重启对应应用（CLI 工具需重开终端）。
            </div>

            {/* 手工添加 → 内联面板（ManualAddPanel，独立组件）*/}
            {manualDraft && (
              <ManualAddPanel app={manualDraft} routes={routes} availableModels={availableModels}
                onUpdate={handleUpdateApp} onRegenKey={handleRegenKey}
                onSave={closeManualDraft} onCancel={cancelManualDraft} />
            )}

            {/* 应用列表 */}
            {loading ? (
              <div className="py-10 flex flex-col items-center justify-center gap-2 text-xs text-gray-400">
                <div className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin" />
                加载中…
              </div>
            ) : visibleApps.length === 0 ? (
              <div className="py-6 text-center text-xs text-gray-400">
                未检测到已识别的应用。安装 Claude Code / Codex / Gemini CLI 后会显示在这里，点「纳管」即可接入；或用上方「+ 新建应用」添加未被识别的应用。
              </div>
            ) : (
              <div className={`flex flex-col divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl ${visibleApps.length > 20 ? 'max-h-[min(75vh,900px)] overflow-y-auto' : 'overflow-hidden'}`}>
                {/* 表头（超过 20 个时列表滚动，表头吸顶）*/}
                <div className="flex items-center gap-3 px-3 py-2 bg-gray-100 dark:bg-gray-800 text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide sticky top-0 z-10">
                  <span className="text-base shrink-0 invisible">🔧</span>
                  <div className="w-28 shrink-0">应用</div>
                  <div className="w-14 shrink-0">状态</div>
                  <div className="w-16 shrink-0">接入方式</div>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-center w-12">总请求数</div>
                    <div className="text-center w-12">总Token</div>
                    <div className="text-center w-14">最后使用</div>
                  </div>
                  <div className="flex-1 min-w-0 max-w-[160px]">路由 / 模型</div>
                  <div className="shrink-0 ml-auto">操作</div>
                </div>
                {visibleApps.map(app => {
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
                  // 双轴状态：纳管(tracked) × 直连/绑路由。
                  //   在线 = 纳管+绑路由(经网关) | 直连 = 纳管+无路由(只读文件，不走网关) | 未纳管(不读文件)
                  const keyApp = isKeyApp(app.link_method);
                  const isCfgApp = keyApp && app.host_method === 'config-file';
                  const isManual = app.link_method === 'manual';
                  const isDirectOnly = app.link_method === 'direct';        // 仅直连·只统计（cursor 等）
                  const hostable = app.link_method === 'shim' || isCfgApp || isDirectOnly;   // 有"纳管/直连"概念的应用
                  const tracked  = app.hosted === true;
                  const isOnline = hostable ? !!(app.hosted && app.route_id) : keyApp;  // 经网关
                  const isDirect = hostable && tracked && !app.route_id;                // 纳管+直连
                  const isActive = isOnline || isDirect || (!hostable && keyApp);        // 纳管中(行不压暗)
                  const statusDot =
                    isOnline ? (isManual ? 'bg-blue-400' : 'bg-green-400 shadow-[0_0_6px] shadow-green-400/60')
                    : isDirect ? 'bg-blue-400'
                    : 'bg-gray-300 dark:bg-gray-600';
                  const rowBg =
                    isOnline ? (isManual ? 'bg-blue-50/40 dark:bg-blue-950/10' : 'bg-green-50/60 dark:bg-green-950/15')
                    : isDirect ? 'bg-blue-50/30 dark:bg-blue-950/10'
                    : 'bg-gray-50/50 dark:bg-gray-800/20';
                  const statusLabel = isOnline ? '在线' : isDirect ? '直连' : (!hostable && keyApp) ? '在线' : '未纳管';
                  const statusText = isOnline ? (isManual ? 'text-blue-500' : 'text-green-600 dark:text-green-400')
                    : isDirect ? 'text-blue-500' : 'text-gray-400';
                  return (
                    // 离线不整行压暗（否则操作按钮看着像禁用）；离线感由灰底/灰点/「离线」标签/
                    // 图标灰度/灰名体现，操作按钮保持全亮可点（含「测试」）。
                    <div key={app.id} className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${rowBg}`}>
                      {/* 图标 + 名称 */}
                      <span className={`text-base shrink-0 ${isActive ? '' : 'grayscale opacity-60'}`}>{app.icon}</span>
                      <div className={`text-xs font-medium truncate w-28 shrink-0 ${isActive ? 'text-gray-800 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}>{app.name}</div>

                      {/* 状态列（在线 / 直连 / 未纳管） */}
                      <div className="w-14 shrink-0 flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
                        <span className={`text-[11px] font-medium ${statusText}`}>{statusLabel}</span>
                      </div>

                      {/* 接入方式列 */}
                      <div className="w-16 shrink-0 text-[11px] text-gray-400 truncate">
                        {LINK_METHOD_LABEL[app.link_method] || app.link_method}
                      </div>

                      {/* 统计：请求数 / token / 最后使用（点击打开用量明细）*/}
                      <div className="flex items-center gap-4 shrink-0 cursor-pointer rounded hover:bg-gray-100/60 dark:hover:bg-gray-700/30 -mx-1 px-1"
                        title="点击查看用量明细（含会话补录）" onClick={() => setDetailApp(app)}>
                        <div className="text-center w-12 text-xs font-semibold text-gray-700 dark:text-gray-200">{st.calls > 0 ? st.calls.toLocaleString() : '—'}</div>
                        <div className="text-center w-12 text-xs font-semibold text-gray-700 dark:text-gray-200">{st.tokens > 0 ? fmtTokens(st.tokens) : '—'}</div>
                        <div className="text-center w-14 text-[10px] font-medium text-gray-600 dark:text-gray-300">{fmtTime(st.lastTs)}</div>
                      </div>

                      {/* 路由下拉：api-key / 手工添加 / 透明托管(shim) 应用可绑路由；route_bindable=false(如 Claude)不显示。
                          仅直连应用(cursor 等)：保留下拉但只有「直连」一项且禁用，UI 一致、不可绑路由。 */}
                      {(((keyApp || app.link_method === 'shim') && app.route_bindable !== false) || isDirectOnly) && !app._virtual_apikey && (
                      <select
                        value={app.route_id || ''}
                        disabled={isDirectOnly || (hostable && !tracked)}
                        onChange={async e => {
                          if (isDirectOnly) return;   // 仅直连应用：不可改路由
                          const val = e.target.value || null;
                          // 直连官方(空) = 还原配置/撤 shim → 应用直连官方、不走网关；
                          // 选模型/路由 = 写配置纳管/注入 shim → 走网关并按 keyScene 路由。
                          setBusyId(app.id);
                          // 选模型/路由 = 纳管 + 走网关（hosted:true）；直连官方(空) = 还原配置/撤 shim，保持纳管
                          if (app.host_method === 'config-file') {        // Claude Desktop 等 config-file 应用
                            await window.electronAPI.apps?.update({ id: app.id, route_id: val, ...(val ? { hosted: true } : {}) }).catch(() => {});
                            if (val) { await writeApiKeyConfig({ ...app, route_id: val }); showNotice(app.id, '⚠ 路由已切换，重启应用后生效'); }   // 写配置→网关
                            else     { await window.electronAPI.apps?.revertConfigFile({ app_id: app.id, config_file: app.config_file }).catch(() => {}); showNotice(app.id, '✓ 已切直连，重启应用后生效'); }  // 直连官方(还原)
                          } else if (app.link_method === 'shim' && app.agent_id) {  // CLI 透明托管
                            let appId = app.id;
                            if (app._virtual) {
                              const created = await window.electronAPI.apps?.ensureShimApp({ agent_id: app.agent_id, name: app.name, icon: app.icon }).catch(() => null);
                              if (created) appId = created.id;
                            }
                            await window.electronAPI.apps?.update({ id: appId, route_id: val, ...(val ? { hosted: true } : {}) }).catch(() => {});
                            if (val) { await window.electronAPI.agents?.apply(app.agent_id).catch(() => {}); showNotice(appId, '⚠ 路由已切换，重开终端后生效'); }   // 注入 shim → 网关
                            else     { await window.electronAPI.agents?.revert(app.agent_id).catch(() => {}); showNotice(appId, '✓ 已撤接管，重开终端后生效'); }  // 撤 shim → 直连官方
                          } else {                                          // 纯 api-key / manual：只改路由
                            await window.electronAPI.apps?.update({ id: app.id, route_id: val }).catch(() => {});
                          }
                          setBusyId(null);
                          await load();
                        }}
                        className="flex-1 min-w-0 text-[10px] bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-1 outline-none text-gray-600 dark:text-gray-400 max-w-[160px] disabled:opacity-40 disabled:cursor-not-allowed">
                        {/* 仅直连应用(cursor)：只有「直连」一项；manual / 无本地用量源桌面壳必须绑路由；其余可「直连官方」*/}
                        {isDirectOnly
                          ? <option value="">直连（仅统计，不走网关）</option>
                          : (isManual || app.allow_direct === false)
                          ? <option value="" disabled>请选择模型 / 路由（不可直连）</option>
                          : <option value="">直连官方（不走网关）</option>}
                        {!isDirectOnly && (() => {
                          const avail = new Set(availableModels.map(m => m.id));
                          const usable = routes.filter(r => (r.steps || []).some(s => avail.has(s.model || s.label)));
                          return (
                            <>
                              {usable.length > 0 && (
                                <optgroup label="场景路由">
                                  {usable.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon} {r.scene_name}</option>)}
                                </optgroup>
                              )}
                              {['free','p2p','paid'].map(tier => {
                                const tm = availableModels.filter(m => m.tier === tier);
                                if (!tm.length) return null;
                                const label = tier === 'free' ? '🟢 免费模型' : tier === 'p2p' ? '🔵 P2P 模型' : '🟣 付费模型';
                                return <optgroup key={tier} label={label}>{tm.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>;
                              })}
                            </>
                          );
                        })()}
                      </select>
                      )}

                      {/* 转发测试：有 api_key 的应用可一键测试转发；仅直连应用(cursor)也显示但置灰(不可测) */}
                      {(app.api_key || isDirectOnly) && (() => {
                        const ts = testState[app.id];
                        return (
                          <>
                            {ts && !ts.busy && (
                              <span title={ts.ok ? `${ts.latency}ms` : ts.error}
                                className={`text-[10px] font-mono shrink-0 max-w-[120px] truncate ${ts.ok ? 'text-green-500 dark:text-green-400' : 'text-red-400'}`}>
                                {ts.ok ? `✓ ${ts.latency}ms` : `✗ ${ts.error}`}
                              </span>
                            )}
                            <button onClick={() => runAppTest(app)} disabled={ts?.busy || !isOnline}
                              className={`text-[10px] px-2 py-1 rounded-lg border transition-colors shrink-0 ${ts?.busy
                                ? 'border-gray-300 dark:border-gray-600 text-gray-400 opacity-60 cursor-wait'
                                : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-500'} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-200 disabled:hover:text-gray-500`}>
                              {ts?.busy ? '测试中…' : '测试'}
                            </button>
                          </>
                        );
                      })()}

                      {/* 操作按钮：按托管方式区分 */}
                      {isDirectOnly ? (
                        /* 仅直连·只统计（cursor 等）：与其它应用「直连」态一致——编辑/测试不可用，还原可用（=取消纳管，停统计）*/
                        <>
                          <button onClick={() => setSettings(app)} disabled={!isOnline}
                            className="text-[10px] px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent shrink-0">
                            编辑
                          </button>
                          {tracked ? (
                            <button onClick={() => setTracked(app, false)} disabled={busyId === app.id}
                              title="还原：停止统计该应用的会话日志（历史数据保留）"
                              className="text-[10px] px-2 py-1 rounded-lg border border-red-200 dark:border-red-900/50 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 disabled:opacity-50 shrink-0">
                              {busyId === app.id ? '…' : '还原'}
                            </button>
                          ) : (
                            <button onClick={() => setTracked(app, true)} disabled={busyId === app.id}
                              className="text-[10px] px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50 shrink-0 font-medium">
                              {busyId === app.id ? '…' : '纳管'}
                            </button>
                          )}
                        </>
                      ) : app.link_method === 'shim' ? (
                        /* 透明托管：编辑（仅在线可用）+ 纳管/还原 开关（按 tracked）*/
                        <>
                          <button onClick={() => setSettings(app)} disabled={!isOnline}
                            className="text-[10px] px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent shrink-0">
                            编辑
                          </button>
                          {tracked ? (
                            <button onClick={() => setTracked(app, false)} disabled={busyId === app.agent_id || busyId === app.id}
                              className="text-[10px] px-2 py-1 rounded-lg border border-red-200 dark:border-red-900/50 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 disabled:opacity-50 shrink-0">
                              {(busyId === app.agent_id || busyId === app.id) ? '…' : '还原'}
                            </button>
                          ) : (
                            <button onClick={() => setTracked(app, true)} disabled={busyId === app.agent_id || busyId === app.id}
                              className="text-[10px] px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50 shrink-0 font-medium">
                              {(busyId === app.agent_id || busyId === app.id) ? '…' : '纳管'}
                            </button>
                          )}
                        </>
                      ) : app._virtual_apikey ? (
                        /* API Key 应用（未纳管虚拟行）：一键纳管（写配置文件指向网关），与透明托管一致 */
                        <button onClick={() => addApiKeyApp(app)} disabled={busyId === app.id}
                          className="text-[10px] px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50 shrink-0 font-medium">
                          {busyId === app.id ? '…' : '纳管'}
                        </button>
                      ) : app.host_method === 'config-file' ? (
                        /* config-file api-key 应用：编辑（仅在线可用）+ 纳管/还原 开关（按 tracked）。
                           纳管后默认直连（只读文件）；要走网关请在路由下拉选模型/路由。*/
                        <>
                          <button onClick={() => setSettings(app)} disabled={!isOnline}
                            className="text-[10px] px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent shrink-0">
                            编辑
                          </button>
                          {tracked ? (
                            <button onClick={() => setTracked(app, false)} disabled={busyId === app.id}
                              className="text-[10px] px-2 py-1 rounded-lg border border-red-200 dark:border-red-900/50 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 disabled:opacity-50 shrink-0">
                              {busyId === app.id ? '…' : '还原'}
                            </button>
                          ) : (
                            <button onClick={() => setTracked(app, true)} disabled={busyId === app.id}
                              className="text-[10px] px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50 shrink-0 font-medium">
                              {busyId === app.id ? '…' : '纳管'}
                            </button>
                          )}
                        </>
                      ) : (
                        /* 普通 api-key 应用：设置 + 删除 */
                        <>
                          <button onClick={() => setSettings(app)}
                            className="text-[10px] px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0">
                            设置
                          </button>
                          <button onClick={() => handleDeleteApp(app.id)}
                            className="text-[10px] px-2 py-1 rounded-lg border border-red-200 dark:border-red-900/50 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 shrink-0">
                            删除
                          </button>
                        </>
                      )}
                      {/* 操作结果提示（重启提醒）*/}
                      {(() => {
                        const key = app.agent_id || app.id;
                        const msg = notice[key];
                        if (!msg) return null;
                        const isWarn = msg.startsWith('⚠');
                        return (
                          <span className={`text-[10px] shrink-0 font-medium ${isWarn ? 'text-amber-500 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                            {msg}
                          </span>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            )}
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

// 层级配色：柔和、跟随明暗模式（浅色 -50 底/-700 字，深色 -900/25 底/-300 字），与全站徽标一致
function tierStyle(tier) {
  if (tier === 'p2p')  return 'bg-blue-50 dark:bg-blue-900/25 border-blue-200 dark:border-blue-800/40 text-blue-700 dark:text-blue-300';
  if (tier === 'paid') return 'bg-amber-50 dark:bg-amber-900/25 border-amber-200 dark:border-amber-800/40 text-amber-700 dark:text-amber-300';
  return 'bg-emerald-50 dark:bg-emerald-900/25 border-emerald-200 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-300';
}
function tierDot(tier) {
  if (tier === 'p2p')  return 'bg-blue-500';
  if (tier === 'paid') return 'bg-amber-500';
  return 'bg-emerald-500';
}
function normTier(t) {
  if (t === 'p2p' || t === 'open' || t === 'free') return 'p2p';
  if (t === 'paid' || t === 'premium') return 'paid';
  return 'p2p';
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

// 条件路由：条件类型元数据（与网关 evalWhen 的 type/op 一致）
const RULE_COND_TYPES = [
  { type: 'request_type', label: '请求类型', ops: ['is', 'not'], values: ['chat', 'image', 'video', 'embedding', 'audio'] },
  { type: 'input_tokens', label: '输入Token', ops: ['gt', 'lt', 'gte', 'lte'], value: 'number' },
  { type: 'keyword',      label: '关键词',   ops: ['match', 'contains'], value: 'text', placeholder: '正则或文本，如 翻译|translate' },
  { type: 'model',        label: '请求模型', ops: ['is', 'contains'], value: 'text', placeholder: '如 claude-opus-4-8' },
  { type: 'caller',       label: '调用方',   ops: ['is'], value: 'text', placeholder: 'API key' },
  { type: 'classifier',   label: '智能分类', ops: ['is', 'not'], value: 'category' },
];
const RULE_OP_LABEL = { is: '是', not: '不是', gt: '>', lt: '<', gte: '≥', lte: '≤', match: '匹配(正则)', contains: '包含' };
const RULE_SEL = 'bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-1 text-[11px] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500';

// 单条 when 条件编辑器：条件类型 + 算子 + 值（值控件随类型变化）。
// categories：智能分类的类别集合（来自分类器配置），用于「智能分类」条件的值下拉。
function RuleConditionEditor({ when, onChange, categories = [] }) {
  const meta = RULE_COND_TYPES.find(c => c.type === when.type) || RULE_COND_TYPES[0];
  const setType = (t) => {
    const m = RULE_COND_TYPES.find(c => c.type === t);
    const v = m.values ? m.values[0] : (m.value === 'number' ? 0 : (m.value === 'category' ? (categories[0] || '') : ''));
    onChange({ type: t, op: m.ops[0], value: v });
  };
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] text-gray-500 shrink-0">当</span>
      <select value={when.type} onChange={e => setType(e.target.value)} className={RULE_SEL}>
        {RULE_COND_TYPES.map(c => <option key={c.type} value={c.type}>{c.label}</option>)}
      </select>
      <select value={when.op} onChange={e => onChange({ ...when, op: e.target.value })} className={RULE_SEL}>
        {meta.ops.map(o => <option key={o} value={o}>{RULE_OP_LABEL[o] || o}</option>)}
      </select>
      {meta.values ? (
        <select value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} className={RULE_SEL}>
          {meta.values.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      ) : meta.value === 'category' ? (
        categories.length
          ? <select value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} className={RULE_SEL}>
              {categories.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          : <input value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} placeholder="类别（先在下方配置分类器）" className={RULE_SEL + ' w-44'} />
      ) : meta.value === 'number' ? (
        <input type="number" value={when.value} onChange={e => onChange({ ...when, value: +e.target.value })} className={RULE_SEL + ' w-24'} />
      ) : (
        <input value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} placeholder={meta.placeholder} className={RULE_SEL + ' w-44'} />
      )}
    </div>
  );
}

// 路由链编辑器（默认链 + 每条规则各一个）
function ChainEditor({ steps, setSteps, availableModels }) {
  const free = availableModels.filter(m => m.tier === 'free');
  const p2p  = availableModels.filter(m => m.tier === 'p2p');
  const paid = availableModels.filter(m => m.tier === 'paid');
  const list = steps || [];
  const add    = () => setSteps([...list, { label: '', model: '', tier: 'free' }]);
  const remove = (i) => setSteps(list.filter((_, idx) => idx !== i));
  const update = (i, val) => { const m = availableModels.find(x => x.id === val); setSteps(list.map((s, idx) => idx === i ? { label: val, model: val, tier: m ? m.tier : 'free' } : s)); };
  return (
    <div className="space-y-1.5">
      {list.map((step, i) => (
        <div key={i} className="flex items-center gap-2 group">
          <span className="text-[10px] text-gray-400 w-4 text-right shrink-0">{i + 1}</span>
          <select value={step.model} onChange={e => update(i, e.target.value)}
            className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500">
            <option value="">-- 选择模型 --</option>
            {free.length > 0 && <optgroup label="🟢 免费层">{free.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>}
            {p2p.length  > 0 && <optgroup label="🔵 P2P 层">{p2p.map(m =>  <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>}
            {paid.length > 0 && <optgroup label="🟡 付费层">{paid.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>}
          </select>
          <button onClick={() => remove(i)}
            className="text-[10px] text-gray-400 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-1">✕</button>
        </div>
      ))}
      <button onClick={add} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ 添加步骤</button>
    </div>
  );
}

function SceneRouteEditor({ route, availableModels, onSave, onCancel }) {
  const [name, setName]   = useState(route.scene_name || '');
  const [icon, setIcon]   = useState(route.icon || '🔀');
  const [steps, setSteps] = useState(route.steps || []);
  const [rules, setRules] = useState(route.rules || []);
  const [clsModel, setClsModel] = useState(route.classifier?.model || '');
  const [clsCats,  setClsCats]  = useState((route.classifier?.categories || ['代码', '数学', '翻译', '创意写作', '通用']).join('、'));

  const setRuleAt  = (i, patch) => setRules(rules.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const removeRule = (i) => setRules(rules.filter((_, idx) => idx !== i));
  const addRule    = () => setRules([...rules, { when: { type: 'input_tokens', op: 'gt', value: 50000 }, steps: [] }]);

  const usesClassifier = rules.some(r => r.when?.type === 'classifier');
  const categories = clsCats.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean);

  function save() {
    const clean = (arr) => (arr || []).filter(s => s.model).map(s => ({ model: s.model, tier: s.tier }));
    const cleanRules = (rules || [])
      .map(r => ({ when: r.when, steps: clean(r.steps) }))
      .filter(r => r.when && r.when.type && r.steps.length);
    const classifier = (usesClassifier && clsModel && categories.length)
      ? { model: clsModel, categories } : undefined;
    onSave({ ...route, scene_name: name, icon, rules: cleanRules.length ? cleanRules : undefined, steps: clean(steps), classifier });
  }

  return (
    <div className="border-t border-gray-200/60 dark:border-gray-800/60 bg-gray-50/50 dark:bg-gray-800/20 px-5 py-4 space-y-3">
      <div className="flex gap-2">
        <input value={icon} onChange={e => setIcon(e.target.value)}
          className="w-10 bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none"
          maxLength={2} />
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="场景名称，如：智能路由"
          className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500" />
      </div>

      {/* 条件规则（可选）：从上到下匹配，命中即用 */}
      <div className="text-xs text-gray-500 font-medium">
        条件规则 <span className="text-gray-400 dark:text-gray-500">· 从上到下匹配，命中即用其路由链（可选）</span>
      </div>
      <div className="space-y-2">
        {rules.map((rule, ri) => (
          <div key={ri} className="border border-gray-200 dark:border-gray-700 rounded-lg p-2 space-y-1.5 bg-white/60 dark:bg-gray-900/30">
            <div className="flex items-start justify-between gap-2">
              <RuleConditionEditor when={rule.when} onChange={w => setRuleAt(ri, { when: w })} categories={categories} />
              <button onClick={() => removeRule(ri)} className="text-[10px] text-gray-400 hover:text-red-500 shrink-0 px-1">删除</button>
            </div>
            <div className="pl-3 border-l-2 border-gray-200 dark:border-gray-700">
              <div className="text-[10px] text-gray-400 mb-1">→ 路由到（路由链）</div>
              <ChainEditor steps={rule.steps} setSteps={s => setRuleAt(ri, { steps: s })} availableModels={availableModels} />
            </div>
          </div>
        ))}
        <button onClick={addRule} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ 添加规则</button>
      </div>

      {/* 分类器配置（用到「智能分类」条件时显示）：先用便宜模型把输入归类，再按类别路由 */}
      {usesClassifier && (
        <div className="border border-indigo-200 dark:border-indigo-800/40 rounded-lg p-2.5 space-y-2 bg-indigo-50/40 dark:bg-indigo-900/10">
          <div className="text-xs font-medium text-indigo-600 dark:text-indigo-400">🧠 分类器（每请求多一次小模型调用，有缓存）</div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-gray-500 w-12 shrink-0">分类模型</label>
            <select value={clsModel} onChange={e => setClsModel(e.target.value)} className={RULE_SEL + ' flex-1'}>
              <option value="">-- 选择便宜/快的模型 --</option>
              {availableModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-gray-500 w-12 shrink-0">类别</label>
            <input value={clsCats} onChange={e => setClsCats(e.target.value)} placeholder="顿号/逗号分隔，如 代码、数学、翻译、通用"
              className={RULE_SEL + ' flex-1'} />
          </div>
          <div className="text-[10px] text-gray-400">规则里「智能分类 是 X」会把输入分到这些类别之一(X)再路由。</div>
        </div>
      )}

      {/* 默认链（else）：规则都不命中时用 */}
      <div className="text-xs text-gray-500 font-medium pt-1">
        默认链{rules.length > 0 && <span className="text-gray-400 dark:text-gray-500">（否则）· 规则都不命中时用</span>}
        <span className="text-gray-400 dark:text-gray-500"> · 失败时按顺序尝试下一步</span>
      </div>
      <ChainEditor steps={steps} setSteps={setSteps} availableModels={availableModels} />
      {steps.length === 0 && rules.length === 0 && <p className="text-xs text-gray-500">还没有步骤，点击「添加步骤」</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={save}
          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium transition-colors">
          保存
        </button>
        <button onClick={onCancel}
          className="text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
          取消
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

function KeyConfigPanel({ apiKey, localBase, model, hideAuto = false }) {
  const [tab,     setTab]     = useState('curl');
  const [tool,    setTool]    = useState('claude-code');
  const [writeOk, setWriteOk] = useState(false);
  const tabs = hideAuto ? CONFIG_TABS.filter(t => t.id !== 'auto') : CONFIG_TABS;

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
        {tabs.map(t => (
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
    const add    = (id, tier) => { if (id && !seen.has(id)) { seen.add(id); models.push({ id, tier }); } };

    // 本地已启用 provider 的模型（本地直连，始终可用）
    try {
      const cfg = await getConfig().read();
      for (const p of (cfg?.providers || [])) {
        if (!p.enabled || p.type === 'p2p') continue;
        for (const m of (p.models || [])) add(typeof m === 'string' ? m : m.name, p.type);
      }
    } catch {}

    // 只列「现在能提供的」：
    //   付费(premium/paid) —— 后端用真实 key 直供，始终可用
    //   P2P(open/free)     —— 由 peer worker 提供，仅当前在线（/v1/models）才列
    try {
      let rates = [];
      try { rates = (await getRates()).data?.models || []; } catch {}
      // 在线 P2P 集：优先用网关的 peerModels（cloud token 拉取，可靠），
      // 回退到 /v1/models（用户 token，可能 401）
      const online = new Set();
      try {
        const gw = await getGateway().status();
        for (const id of (gw?.peerModels || [])) online.add(id);
      } catch {}
      if (online.size === 0) {
        try { for (const m of ((await getOnlineModels()).data?.data || [])) online.add(m.id); } catch {}
      }
      for (const m of rates) {
        const tier = normTier(m.tier);
        if (tier === 'paid') add(m.name, 'paid');         // 付费始终可用
        else if (online.has(m.name)) add(m.name, tier);   // P2P 需在线
      }
      // 在线但 rates 里没有的，按 p2p 兜底列出
      for (const id of online) add(id, 'p2p');
    } catch (e) {
      console.error('loadAvailableModels', e);
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
          id: route.id, scene_name: route.scene_name, icon: route.icon, steps: route.steps, rules: route.rules, classifier: route.classifier,
        });
      } else {
        await getLocalConfig().createSceneRoute({
          scene_name: route.scene_name, icon: route.icon, steps: route.steps, rules: route.rules, classifier: route.classifier,
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
        {/* 操作栏：新建（蓝色，最左）｜说明｜在线同步（最右）——布局与应用列表一致 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-200 dark:border-gray-800 flex-wrap">
          <button
            onClick={() => { if (newRoute) { setNewRoute(null); } else { setExpandedRoute(null); setNewRoute({ scene_name: '', icon: '🔀', steps: [] }); } }}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
          >+ 新建路由</button>
          <span className="text-xs text-gray-400 dark:text-gray-500">定义每个场景的模型路由链，通过 llm-router-xxx 触发</span>
          <div className="ml-auto">
            <ImportConfigButton onImported={() => { refresh(); loadSceneData(); loadAvailableModels(); }} endpoint="/api/config/scenes" />
          </div>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
          {/* 新建路由编辑器：放在列表最上面 */}
          {newRoute && (
            <SceneRouteEditor key="new-route-editor" route={newRoute} availableModels={availableModels} onSave={saveRoute} onCancel={() => setNewRoute(null)} />
          )}
          {routes.map(route => {
            const health = routeHealth[route.model_key] ?? { status: null, activeStep: null, degraded: false };
            const ftMs = health.first_token_ms;
            // 本地供给源是否缺少该路由用到的模型（缺则名称前的点也标红）
            const availSet = new Set(availableModels.map(m => m.id));
            const routeMissing = (route.steps || []).some(s => !availSet.has(s.model || s.label));
            const healthDot =
              routeMissing ? 'bg-red-500' :
              health.status === 'error' ? 'bg-red-500' :
              health.status === 'ok'
                ? (ftMs != null && ftMs > 3000 ? 'bg-amber-400' : 'bg-green-500')
                : 'bg-gray-300 dark:bg-gray-600';
            const ftLabel = ftMs != null ? `首token ${(ftMs / 1000).toFixed(1)}s` : null;
            const healthTitle =
              routeMissing ? '含本地不可用的模型，需重新设置' :
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
                      <span className="text-[9px] px-1 py-0.5 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/40 text-rose-600 dark:text-rose-400 shrink-0">
                        降级中
                      </span>
                    )}
                    {route.rules?.length > 0 && (
                      <span title="含条件路由规则" className="text-[9px] px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 text-indigo-600 dark:text-indigo-400 shrink-0">
                        🔀 {route.rules.length} 条规则
                      </span>
                    )}
                    {route.model_key && (
                      <>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 shrink-0">
                          {route.model_key}
                        </span>
                        <span onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(route.model_key); }}
                          className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer transition-colors shrink-0">复制</span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {(() => {
                      const steps = route.steps || [];
                      return (<>
                        {steps.map((step, i) => {
                          const t = resolveStepTier(step.model || step.label, step, availableModels);
                          const stepName = step.model || step.label;
                          const isActive = health.activeStep === stepName;
                          const isFailed = health.triedSteps?.includes(stepName);
                          const missing = !availSet.has(stepName);   // 本地供给源里没有该模型
                          return (
                            <React.Fragment key={i}>
                              {i > 0 && <span className="text-gray-400 text-xs">→</span>}
                              <span title={missing ? '本地供给源没有此模型，请在「供给源」启用对应模型或重新设置该路由' : undefined}
                                className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border transition-all ${
                                  isActive
                                    ? 'bg-green-100 dark:bg-green-900/40 border-green-400 dark:border-green-600 text-green-800 dark:text-green-200'
                                    : missing
                                      ? 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700 text-red-600 dark:text-red-300'
                                      : tierStyle(t)
                                }`}>
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  isActive ? 'bg-green-500' : (missing || isFailed) ? 'bg-red-500' : tierDot(t)
                                }`} />
                                {step.label || step.model}
                                <span className="opacity-50">({TIER_SHORT[t] || t})</span>
                              </span>
                            </React.Fragment>
                          );
                        })}
                        {!steps.length && <span className="text-xs text-gray-400">暂无步骤</span>}
                        {routeMissing && (
                          <span className="text-[10px] text-red-600 dark:text-red-400 ml-1 shrink-0">⚠ 含本地不可用的模型，需重新设置</span>
                        )}
                      </>);
                    })()}
                  </div>
                </div>
                <button onClick={e => { e.stopPropagation(); setExpandedRoute(expandedRoute === route.id ? null : route.id); }}
                  className="text-[10px] px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mt-0.5 shrink-0">
                  {expandedRoute === route.id ? '收起' : '编辑'}
                </button>
                <button onClick={e => { e.stopPropagation(); removeRoute(route.id); }}
                  className="text-[10px] text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors mt-1 shrink-0">删除</button>
                <span className="text-gray-400 text-xs mt-1 shrink-0">{expandedRoute === route.id ? '▲' : '▼'}</span>
              </div>
              {expandedRoute === route.id && (
                <SceneRouteEditor key={'editor-' + route.id} route={route} availableModels={availableModels} onSave={saveRoute} onCancel={() => setExpandedRoute(null)} />
              )}
            </div>
            );
          })}
          {routes.length === 0 && !newRoute && (
            <div className="px-5 py-8 text-xs text-gray-400 text-center">还没有场景路由，点击「新建路由」开始</div>
          )}
        </div>
        </div>
        )}
      </div>

      {/* 路由明细 — 仅在「场景路由」Tab 显示，应用列表 Tab 不显示 */}
      {mainTab === 1 && (
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
                    {/* Claude 透明映射标记：claude 名 → (改写成真实模型) */}
                    {e.claude_from && (
                      <>
                        <span title="Claude 请求名透明映射到真实模型" className="font-mono text-[10px] px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 text-indigo-600 dark:text-indigo-400 shrink-0">
                          🎭 {e.claude_from}
                        </span>
                        <span className="text-gray-300 dark:text-gray-600">→</span>
                      </>
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
                      {!e.claude_from && !isRouter && (
                        <span title="直连模型（未经 Claude 透明映射）" className="ml-1 text-[9px] text-gray-400">直连</span>
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
      )}
    </div>
  );
}
