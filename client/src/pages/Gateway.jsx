import React, { useEffect, useState, useCallback, useRef } from 'react';
import { loadGatewayAvailableModels } from '../api/gatewayModels';
import { getSyncServerBase } from '../config';
import { getGateway, getLocalConfig, getConfig, getApps } from '../api/adapter';
import { listAgents, applyAgent, revertAgent } from '../api/agents';
import claudeDevModeImg1 from '../assets/claude-devmode-1.webp';
import claudeDevModeImg2 from '../assets/claude-devmode-2.webp';
import { useLang } from '../store/lang';
import {
  encodeTierModelRoute,
  modelIdFromRoute,
  routeSelectValue,
  isKnownRouteSelectValue,
} from '../lib/route-binding';

// tier:id 作为下拉唯一 value，避免同模型跨层选中错位
function modelTierKey(m) {
  return encodeTierModelRoute(m.tier, m.id);
}

// ── PolicyManager：策略组管理 UI ──────────────────────────────────────────────
function strategyOptions(t) {
  return [
    { value: 'fallback',    label: t('gateway.strategy.fallback'),    desc: t('gateway.strategy.fallbackDesc') },
    { value: 'round-robin', label: t('gateway.strategy.roundRobin'),  desc: t('gateway.strategy.roundRobinDesc') },
    { value: 'weighted',    label: t('gateway.strategy.weighted'),    desc: t('gateway.strategy.weightedDesc') },
    { value: 'latency',     label: t('gateway.strategy.latency'),     desc: t('gateway.strategy.latencyDesc') },
    { value: 'direct',      label: t('gateway.strategy.direct'),      desc: t('gateway.strategy.directDesc') },
  ];
}

function PolicyManager() {
  const { t } = useLang();
  const STRATEGY_OPTIONS = strategyOptions(t);
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
    if (!window.electronAPI?.policies) return setMsg(t('gateway.sync.cliOnly'));
    if (!formName.trim()) return setMsg(t('gateway.policy.nameRequired'));
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
    if (!window.electronAPI?.policies) return;
    if (!window.confirm(t('gateway.policy.confirmDelete'))) return;
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
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">⚖️</span>
        <h2 className="font-semibold text-zinc-800 dark:text-zinc-100 text-sm">{t('gateway.policy.title')}</h2>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('gateway.policy.subtitle')}</span>
        <button onClick={openNew}
          className="ml-auto text-xs px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors">
          {t('gateway.policy.new')}
        </button>
      </div>

      {/* 策略组列表 */}
      <div className="flex flex-col gap-1.5 mb-2">
        {policies.length === 0 && <div className="text-xs text-zinc-400 py-1">{t('gateway.policy.empty')}</div>}
        {policies.map(p => (
          <div key={p.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 text-sm">
            <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate flex-1">{p.name}</span>
            <span className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0">
              {STRATEGY_OPTIONS.find(s => s.value === p.strategy)?.label || p.strategy}
            </span>
            <span className="text-xs text-zinc-400 shrink-0">{t('gateway.policy.providerCount', { n: (p.providers||[]).length })}</span>
            <button onClick={() => openEdit(p)}
              className="text-xs px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300 shrink-0">
              {t('gateway.common.edit')}
            </button>
            <button onClick={() => del(p.id)}
              className="text-xs text-red-400 hover:text-red-600 shrink-0">{t('gateway.common.del')}</button>
          </div>
        ))}
      </div>

      {/* 编辑面板 */}
      {editing && (
        <div className="mt-3 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <div className="text-xs font-medium text-zinc-700 dark:text-zinc-200 mb-2">
            {editing === 'new' ? t('gateway.policy.newTitle') : t('gateway.policy.editTitle', { name: editing.name })}
          </div>
          <div className="flex flex-col gap-2">
            {/* 名称 */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-500 w-14 shrink-0">{t('gateway.policy.nameLabel')}</label>
              <input value={formName} onChange={e => setFormName(e.target.value)}
                placeholder={t('gateway.policy.namePlaceholder')}
                className="flex-1 text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200" />
            </div>
            {/* Strategy */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-500 w-14 shrink-0">{t('gateway.policy.strategyLabel')}</label>
              <select value={formStrategy} onChange={e => setFormStrategy(e.target.value)}
                className="flex-1 text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 outline-none text-zinc-800 dark:text-zinc-200">
                {STRATEGY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                ))}
              </select>
            </div>
            {/* Provider 列表 */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <label className="text-xs text-zinc-500 w-14 shrink-0">Provider</label>
                <select defaultValue="" onChange={e => { addProvider(e.target.value); e.target.value = ''; }}
                  className="flex-1 text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 outline-none text-zinc-800 dark:text-zinc-200">
                  <option value="">{t('gateway.policy.addProvider')}</option>
                  {providers.filter(p => !formProviders.find(fp => fp.id === p.id)).map(p => (
                    <option key={p.id} value={p.id}>{p.label || p.id}</option>
                  ))}
                </select>
              </div>
              {formProviders.map((fp, idx) => (
                <div key={fp.id} className="flex items-center gap-1.5 ml-16 mb-1">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300 flex-1 truncate">{fp.id}</span>
                  {formStrategy === 'weighted' && (
                    <label className="text-xs text-zinc-400">weight
                      <input type="number" min="1" value={fp.weight} onChange={e => setWeight(fp.id, e.target.value)}
                        className="ml-1 w-12 text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded px-1 py-0.5 text-center" />
                    </label>
                  )}
                  <button onClick={() => moveUp(idx)} disabled={idx===0}
                    className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-30">↑</button>
                  <button onClick={() => removeProvider(fp.id)}
                    className="text-xs text-red-400 hover:text-red-600">✕</button>
                </div>
              ))}
              {formProviders.length === 0 && (
                <div className="ml-16 text-xs text-zinc-400">{t('gateway.policy.noProviders')}</div>
              )}
            </div>
            {/* 操作 */}
            {msg && <div className={`text-xs ml-16 ${msg.startsWith('✗') ? 'text-red-500' : 'text-green-600'}`}>{msg}</div>}
            <div className="flex gap-2 ml-16">
              <button onClick={save} disabled={busy}
                className="text-xs px-3 py-1 rounded bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50">
                {busy ? t('gateway.common.saving') : t('gateway.common.save')}
              </button>
              <button onClick={cancelEdit}
                className="text-xs px-3 py-1 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300">
                {t('gateway.common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
        {t('gateway.policy.hint')}
      </p>
    </div>
  );
}

// ── ImportConfigButton：在线同步（地址取自设置页，不在 UI 展示）────────────
function ImportConfigButton({ onImported, endpoint = '/api/config/apps' }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const msgTimerRef = useRef(null);

  // 同步结果提示 5 秒后自动隐藏
  useEffect(() => {
    if (!msg) return;
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    msgTimerRef.current = setTimeout(() => setMsg(''), 5000);
    return () => {
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    };
  }, [msg]);

  function importedMsg(r, prefix) {
    const apps = Array.isArray(r.addedApps) ? r.addedApps : [];
    const routes = Array.isArray(r.addedRoutes) ? r.addedRoutes : [];
    const parts = [];
    if (apps.length)   parts.push(t('gateway.sync.addedApps', { n: apps.length, list: apps.join('、') }));
    if (routes.length) parts.push(t('gateway.sync.addedRoutes', { n: routes.length, list: routes.join('、') }));
    if (parts.length)  return `${prefix}，${parts.join('；')}`;
    return t('gateway.sync.noChanges', { prefix });
  }

  async function handleSync() {
    const base = await getSyncServerBase();
    if (!base) {
      setMsg(t('gateway.sync.noServer'));
      return;
    }
    const fullUrl = base + endpoint;
    setBusy(true);
    setMsg('');
    const token = localStorage.getItem('token');

    // 桌面端：主进程拉 YAML 并合并
    if (window.electronAPI?.toolsConfig?.importUrl) {
      const r = await window.electronAPI.toolsConfig.importUrl(fullUrl, token);
      setMsg(r.ok ? '✓ ' + importedMsg(r, t('gateway.sync.done')) : '✗ ' + r.error);
      if (r.ok && onImported) onImported();
      setBusy(false);
      return;
    }

    // Docker / 浏览器 CLI 模式：在线同步需桌面端能力
    setMsg('✗ ' + t('gateway.sync.cliOnly'));
    setBusy(false);
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button type="button" disabled={busy} onClick={handleSync}
        title={t('gateway.sync.title')}
        className="text-xs px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors">
        {busy ? t('gateway.sync.syncing') : t('gateway.sync.btn')}
      </button>
      {msg && <div className={`text-xs ${msg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</div>}
    </div>
  );
}

// ── AppManager：应用列表（Tab1: 所有应用 & 托管 | Tab2: API Key 管理）────────
// 接入方式列：仅「应用」/「API」（manual=手工 API，其余均为应用）
function linkMethodLabel(method, t) {
  return method === 'manual' ? t('gateway.link.api') : t('gateway.link.app');
}
// 应用列表统一栅格，保证表头与数据列对齐
const APPS_TABLE_GRID = 'grid grid-cols-[1.5rem_minmax(4rem,6rem)_4rem_3rem_3.5rem_3.5rem_3.5rem_minmax(0,1fr)_3rem_auto] gap-x-2 items-center px-3';
// 按 API Key 路由的应用：自动写配置的 api-key，和用户自配的 manual（手工添加）
const isKeyApp = (m) => m === 'api-key' || m === 'manual';

function tierModelLabel(tier, t) {
  if (tier === 'free') return t('gateway.app.tier.free');
  if (tier === 'p2p') return t('gateway.app.tier.p2p');
  return t('gateway.app.tier.paid');
}
function tierLayerLabel(tier, t) {
  if (tier === 'free') return t('gateway.app.tier.freeLayer');
  if (tier === 'p2p') return t('gateway.app.tier.p2pLayer');
  return t('gateway.app.tier.paidLayer');
}

function strategyLabel(key, t) {
  const map = {
    'base_url-env': t('gateway.strategyLabel.baseUrlEnv'),
    'config-file':  t('gateway.strategyLabel.configFile'),
    'mitm-env':     t('gateway.strategyLabel.mitmEnv'),
  };
  return map[key] || key;
}

// 单个应用的设置面板（路由规则绑定 + 详细配置）
function AppSettingsPanel({ app, routes, availableModels = [], localBase = '', onUpdate, onDelete, onRegenKey, onCancelManage, onWritten, onClose, onCancel }) {
  const { t } = useLang();
  const dismiss = onCancel || onClose;   // ✕/取消/点遮罩 → 取消（新应用未保存会被丢弃）
  const [name,        setName]        = useState(app.name || '');
  const [icon,        setIcon]        = useState(app.icon || '🔧');
  const [desc,        setDesc]        = useState(app.description || '');
  const [routeId,     setRouteId]     = useState(() => routeSelectValue(app.route_id, availableModels, routes));
  const [busy,        setBusy]        = useState(false);
  const [copied,      setCopied]      = useState(false);
  const [claudeDevMode, setClaudeDevMode] = useState(null); // Claude Desktop 开发者模式状态
  // config-file 类 API Key 应用：两 Tab（0=配置文件写入和 API Key｜1=路由规则）
  const isCfg = app.link_method === 'api-key' && !!app.config_file;
  const isShim = app.link_method === 'shim';   // 透明托管：路由规则 + 基础信息
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
      ...(app.env && !app.config_file ? { env: parseEnvText(envText) } : {}),
    });
    setBusy(false);
    onClose();
  }

  async function writeEnv() {
    setWriteMsg('');
    const r = await window.electronAPI?.apps?.writeEnv(parseEnvText(envText)).catch(e => ({ ok: false, error: e.message }));
    if (r?.ok) setWriteMsg(t('gateway.app.envWritten', { count: r.count }));
    else setWriteMsg('✗ ' + (r?.error || t('gateway.common.writeFailed')));
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
      const lines = r.conflicts.map(c => `· ${c.key}\n${t('gateway.app.conflictCurrent', { val: c.current })}\n${t('gateway.app.conflictWanted', { val: c.wanted })}`).join('\n');
      const ok = window.confirm(t('gateway.app.conflictConfirm', { lines }));
      if (ok) return writeConfigFile(true);   // 用户确认 → 强制覆盖
      setWriteMsg(t('gateway.app.conflictCancelled'));
      return;
    }
    if (r?.ok) {
      setWriteMsg(t('gateway.app.configWritten', { file: r.file, envPart: r.envCount ? t('gateway.app.configWrittenEnvPart', { n: r.envCount }) : '' }));
      setWritten(true);     // 已写入 → 显示「取消 API Key 管理」
      onWritten?.();        // 通知父级：该应用已落地（清除 _isNew，取消时不再删除）
    } else setWriteMsg('✗ ' + (r?.error || t('gateway.common.writeFailed')));
  }

  const ICONS = ['🤖','✏️','🔧','💻','🎯','🌐','📱','🔑','⚡','🛠️','🎨','📊'];

  // ── 各区块（按布局组合：config-file 应用走两 Tab，其余走单页）──
  const baseInfoSection = (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.basicInfo')}</div>
      <div className="flex gap-2 mb-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder={t('gateway.app.namePlaceholder')}
          className="flex-1 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200" />
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {ICONS.map(e => (
          <button key={e} onClick={() => setIcon(e)}
            className={`text-lg p-1 rounded ${icon === e ? 'bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-400' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
            {e}
          </button>
        ))}
      </div>
      <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder={t('gateway.app.descPlaceholder')} rows={2}
        className="w-full text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none resize-none text-zinc-600 dark:text-zinc-400" />
    </div>
  );

  const apiKeyRow = isKeyApp(app.link_method) && app.api_key && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">API Key</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 text-zinc-600 dark:text-zinc-400 truncate">{app.api_key}</code>
        <button onClick={() => { navigator.clipboard.writeText(app.api_key); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="text-xs px-2 py-1.5 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300 shrink-0">
          {copied ? t('gateway.common.copied') : t('gateway.common.copy')}
        </button>
        {onRegenKey && (
          <button onClick={() => onRegenKey(app.id)}
            className="text-xs px-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 shrink-0">{t('gateway.common.reset')}</button>
        )}
      </div>
    </div>
  );

  const envSection = app.link_method === 'api-key' && app.env && !app.config_file && (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{t('gateway.app.envTitle')}</div>
        <button onClick={writeEnv}
          className="text-xs px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white shrink-0">
          {t('gateway.app.writeConfig')}
        </button>
      </div>
      <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={Math.max(2, envText.split('\n').length)}
        spellCheck={false}
        className="w-full font-mono text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-blue-400 text-zinc-700 dark:text-zinc-200 resize-y"
        placeholder={t('gateway.app.envPlaceholder')} />
      {writeMsg && <div className={`text-xs mt-1 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
      <div className="text-xs text-zinc-400 mt-1">
        {t('gateway.app.envHint')}
      </div>
    </div>
  );

  // 配置文件注入（信息展示；写入按钮在底部）
  // Claude Desktop 开发者模式引导（configLibrary 为空时显示）
  const devModeGuide = needDevMode && (
    <div className="rounded-lg border border-amber-300 dark:border-amber-700/50 bg-amber-50/60 dark:bg-amber-950/20 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">⚠️</span>
        <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">{t('gateway.app.devModeTitle')}</span>
      </div>
      <div className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1 mb-3">
        <p>{t('gateway.app.devModeIntro')}</p>
        <p>{t('gateway.app.devModeStep1')}</p>
        <p>{t('gateway.app.devModeStep2')}</p>
        <p>{t('gateway.app.devModeStep3')}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <div className="text-xs text-zinc-400 mb-1">{t('gateway.app.devModeImg1')}</div>
          <img src={claudeDevModeImg1} alt="Enable Developer Mode" className="rounded border border-zinc-200 dark:border-zinc-700 w-full" />
        </div>
        <div>
          <div className="text-xs text-zinc-400 mb-1">{t('gateway.app.devModeImg2')}</div>
          <img src={claudeDevModeImg2} alt="Configure Gateway" className="rounded border border-zinc-200 dark:border-zinc-700 w-full" />
        </div>
      </div>
      <button
        onClick={async () => {
          const st = await window.electronAPI?.apps?.claudeDevModeStatus?.();
          setClaudeDevMode(st || null);
          if (st?.dev_mode_ready) setWriteMsg(t('gateway.app.devModeReady'));
          else setWriteMsg(t('gateway.app.devModeNotReady'));
        }}
        className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors">
        {t('gateway.app.devModeRefresh')}
      </button>
      {writeMsg && <div className={`text-xs mt-2 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
    </div>
  );

  const configFileSection = app.config_file && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.configFileTitle')}</div>
      <div className="bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 space-y-1">
        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-300 break-all">{app.config_file}</div>
        {Object.entries(app.patch || {}).map(([k, v]) => (
          <div key={k} className="font-mono text-xs text-zinc-500 break-all">{k} = {resolveEnv(v)}</div>
        ))}
        {Object.keys(app.env || {}).length > 0 && (
          <div className="font-mono text-xs text-zinc-400 pt-1">{t('gateway.app.envVars', { list: Object.keys(app.env).join(', ') })}</div>
        )}
      </div>
      {writeMsg && <div className={`text-xs mt-1 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
      <div className="text-xs text-zinc-400 mt-1">
        {t('gateway.app.configFileHint')}
      </div>
    </div>
  );

  const routeSection = (isKeyApp(app.link_method) || app.link_method === 'shim') && app.route_bindable !== false && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.routeRules')}</div>
      <select value={routeId} onChange={e => setRouteId(e.target.value)}
        className="w-full text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none text-zinc-800 dark:text-zinc-200">
        {/* manual（手工添加）无官方可直连 → 必须绑定，「直连」改为不可选占位 */}
        {app.link_method === 'manual'
          ? <option value="" disabled>{t('gateway.app.routeRequired')}</option>
          : <option value="">{t('gateway.app.routeDirect')}</option>}
        {(() => {
          const avail = new Set(availableModels.map(m => m.id));
          const usable = routes.filter(r => (r.steps || []).some(s => avail.has(s.model || s.label)));
          return usable.length > 0 && (
            <optgroup label={t('gateway.app.sceneRoutes')}>
              {usable.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon} {r.scene_name}</option>)}
            </optgroup>
          );
        })()}
        {['free','p2p','paid'].map(tier => {
          const tm = availableModels.filter(m => m.tier === tier);
          if (!tm.length) return null;
          const label = tierModelLabel(tier, t);
          return <optgroup key={tier} label={label}>{tm.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}</optgroup>;
        })}
      </select>
    </div>
  );

  const accessSection = isKeyApp(app.link_method) && app.api_key && !app.env && !app.config_file && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.accessConfig')}</div>
      <KeyConfigPanel apiKey={app.api_key} localBase="http://127.0.0.1:11430/v1"
        model={routeId ? (modelIdFromRoute(routeId, routes) || routeId) : undefined} hideAuto />
    </div>
  );

  const btnSave = (
    <button onClick={save} disabled={busy}
      className="flex-1 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
      {busy ? t('gateway.common.saving') : t('gateway.common.save')}
    </button>
  );
  const btnCancel = (
    <button onClick={dismiss}
      className="px-4 py-2 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400">
      {t('gateway.common.cancel')}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={dismiss}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl mx-4 max-h-[92vh] overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <span className="text-xl">{icon}</span>
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">{app.name || t('gateway.app.settingsTitle')}</h3>
          <button onClick={dismiss} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg">✕</button>
        </div>

        {(isCfg || isShim) ? (
          /* 纳管应用（config-file / 透明托管）：基础信息 + 路由规则 */
          <>
            <div className="p-5 space-y-4">
              {baseInfoSection}{routeSection}
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-zinc-200 dark:border-zinc-800">
              {btnSave}{btnCancel}
            </div>
          </>
        ) : (
          <>
            <div className="p-5 space-y-4">
              {baseInfoSection}{apiKeyRow}{envSection}{routeSection}{accessSection}
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-zinc-200 dark:border-zinc-800">
              {onDelete && isKeyApp(app.link_method) && (
                <button onClick={() => onDelete(app.id)}
                  className="px-4 py-2 text-sm rounded-xl border border-red-200 dark:border-red-900/50 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                  {t('gateway.common.delete')}
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
  const { t } = useLang();
  const [name,        setName]        = useState(app.name || '');
  const [icon,        setIcon]        = useState(app.icon || '🔧');
  const [desc,        setDesc]        = useState(app.description || '');
  const [routeId,     setRouteId]     = useState(() => routeSelectValue(app.route_id, availableModels, routes));
  const [busy,        setBusy]        = useState(false);
  const [copied,      setCopied]      = useState(false);
  const ICONS = ['🤖','✏️','🔧','💻','🎯','🌐','📱','🔑','⚡','🛠️','🎨','📊'];

  async function save() {
    setBusy(true);
    await onUpdate({
      id: app.id, name, icon, description: desc,
      route_id: routeId || null,
    });
    setBusy(false);
    onSave();
  }

  return (
    <div className="mb-3 bg-white dark:bg-zinc-900 rounded-2xl border border-blue-200 dark:border-blue-800/50 shadow-sm">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-xl">{icon}</span>
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">{t('gateway.app.newTitle')}</h3>
        <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg">✕</button>
      </div>
      <div className="p-5 space-y-4">
        {/* 基础信息 */}
        <div>
          <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.basicInfo')}</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={t('gateway.app.namePlaceholder')}
            className="w-full text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200 mb-2" />
          <div className="flex flex-wrap gap-1.5 mb-2">
            {ICONS.map(e => (
              <button key={e} onClick={() => setIcon(e)}
                className={`text-lg p-1 rounded ${icon === e ? 'bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-400' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
                {e}
              </button>
            ))}
          </div>
          <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder={t('gateway.app.descPlaceholder')} rows={2}
            className="w-full text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none resize-none text-zinc-600 dark:text-zinc-400" />
        </div>
        {/* API Key */}
        {app.api_key && (
          <div>
            <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">API Key</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 text-zinc-600 dark:text-zinc-400 truncate">{app.api_key}</code>
              <button onClick={() => { navigator.clipboard.writeText(app.api_key); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="text-xs px-2 py-1.5 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300 shrink-0">
                {copied ? t('gateway.common.copied') : t('gateway.common.copy')}
              </button>
              {onRegenKey && (
                <button onClick={() => onRegenKey(app.id)}
                  className="text-xs px-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 shrink-0">{t('gateway.common.reset')}</button>
              )}
            </div>
          </div>
        )}
        {/* 路由规则 */}
        <div>
          <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.routeRules')}</div>
          <select value={routeId} onChange={e => setRouteId(e.target.value)}
            className="w-full text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none text-zinc-800 dark:text-zinc-200">
            {/* 手工添加无官方可直连 → 必须绑定 */}
            <option value="" disabled>{t('gateway.app.routeRequired')}</option>
            {(() => {
              const avail = new Set(availableModels.map(m => m.id));
              const usable = routes.filter(r => (r.steps || []).some(s => avail.has(s.model || s.label)));
              return usable.length > 0 && (
                <optgroup label={t('gateway.app.sceneRoutes')}>
                  {usable.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon} {r.scene_name}</option>)}
                </optgroup>
              );
            })()}
            {['free','p2p','paid'].map(tier => {
              const tm = availableModels.filter(m => m.tier === tier);
              if (!tm.length) return null;
              const label = tierModelLabel(tier, t);
              return <optgroup key={tier} label={label}>{tm.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}</optgroup>;
            })}
          </select>
        </div>
        {/* 接入配置：Key + base_url + 示例（用户自行把应用指向网关）*/}
        {app.api_key && (
          <div>
            <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.accessConfigHint')}</div>
            <KeyConfigPanel apiKey={app.api_key} localBase="http://127.0.0.1:11430/v1"
              model={routeId ? (modelIdFromRoute(routeId, routes) || routeId) : undefined} hideAuto />
          </div>
        )}
      </div>
      <div className="flex gap-2 px-5 py-4 border-t border-zinc-200 dark:border-zinc-800">
        <button onClick={save} disabled={busy}
          className="flex-1 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
          {busy ? t('gateway.common.saving') : t('gateway.common.save')}
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400">
          {t('gateway.common.cancel')}
        </button>
      </div>
    </div>
  );
}

// Trace 顶栏指标 pill（参考 tokentelemetry）
function TraceStatPill({ label, value, tone }) {
  const toneCls = tone === 'blue' ? 'text-blue-600 dark:text-blue-400'
    : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'red' ? 'text-red-600 dark:text-red-400'
    : tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'cyan' ? 'text-cyan-600 dark:text-cyan-400'
    : 'text-zinc-800 dark:text-zinc-100';
  return (
    <div className="inline-flex items-center gap-1 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 h-7">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${toneCls}`}>{value}</span>
    </div>
  );
}

// Session Trace 弹窗（参考 tokentelemetry，简化版）
function SessionTraceModal({ app, sessionId, traceAgentId, onClose }) {
  const { t } = useLang();
  const [trace, setTrace]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [stepIdx, setStepIdx] = useState(0);
  const agentId = traceAgentId || app?.agent_id;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setStepIdx(0);
    window.electronAPI?.apps?.sessionTrace?.(agentId, sessionId)
      .then(t => { if (alive) { setTrace(t); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [app, sessionId, agentId]);

  const steps = trace?.steps || [];
  const cur   = steps[stepIdx] || null;
  const st    = trace?.stats || {};
  const tok   = st.tokens || {};
  const fmtN  = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n ?? 0));
  const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-4xl mx-4 max-h-[92vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0 space-y-2">
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 text-sm">{t('gateway.common.back')}</button>
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">Session Trace</h3>
            <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 uppercase">{agentId || 'agent'}</span>
            <span className="font-mono text-xs text-zinc-400">{sessionId?.slice(0, 8)}…</span>
          </div>
          {!loading && !trace?.error && st.steps != null && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <TraceStatPill label="Steps" value={st.steps} />
              <TraceStatPill label="Tools" value={st.tools ?? 0} tone="blue" />
              {(st.artifacts ?? 0) > 0 && <TraceStatPill label="Arts" value={st.artifacts} tone="emerald" />}
              <TraceStatPill label="Reason" value={st.reasoning ?? 0} tone="amber" />
              <TraceStatPill label="Turns" value={st.turns ?? 0} />
              <TraceStatPill label="Dur" value={st.duration || '—'} />
              <TraceStatPill label="Err" value={st.errors ?? 0} tone={(st.errors ?? 0) > 0 ? 'red' : undefined} />
              <div className="hidden sm:flex items-center gap-2 ml-1 px-2 h-7 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40">
                <span className="text-xs text-zinc-400">INPUT <strong className="text-zinc-700 dark:text-zinc-200">{fmtN(tok.input)}</strong></span>
                <span className="text-zinc-300">|</span>
                <span className="text-xs text-zinc-400">OUTPUT <strong className="text-zinc-700 dark:text-zinc-200">{fmtN(tok.output)}</strong></span>
                <span className="text-zinc-300">|</span>
                <span className="text-xs text-zinc-400">CACHED <strong className="text-cyan-600 dark:text-cyan-400">{fmtN(tok.cached)}</strong></span>
              </div>
            </div>
          )}
        </div>

        {loading ? (
          <div className="py-16 flex justify-center text-xs text-zinc-400">{t('gateway.trace.loading')}</div>
        ) : trace?.error ? (
          <div className="py-16 text-center text-xs text-zinc-400">{t('gateway.trace.notFound')}</div>
        ) : (
          <>
            {/* 会话元信息 */}
            <div className="px-5 py-2 text-xs text-zinc-500 dark:text-zinc-400 border-b border-zinc-100 dark:border-zinc-800 shrink-0 flex flex-wrap gap-x-4 gap-y-1">
              <span>{t('gateway.detail.projectLabel')} <strong className="text-zinc-700 dark:text-zinc-300">{trace.project || '—'}</strong></span>
              {projectPathTooltip(trace) !== '—' && (
                <span className="font-mono truncate max-w-xs" title={projectPathTooltip(trace)}>{projectPathTooltip(trace)}</span>
              )}
            </div>

            <div className="flex flex-1 min-h-0">
              {/* 步骤索引 */}
              <div className="w-44 shrink-0 border-r border-zinc-100 dark:border-zinc-800 overflow-y-auto max-h-[55vh]">
                {steps.map((s, i) => (
                  <button key={i} onClick={() => setStepIdx(i)}
                    className={`w-full text-left px-3 py-1.5 text-xs border-b border-zinc-50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${stepIdx === i ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'text-zinc-600 dark:text-zinc-400'}`}>
                    <span className="text-zinc-400 mr-1">{String(i).padStart(3, '0')}</span>
                    <span className={`px-1 rounded text-xs mr-1 ${s.kind === 'tool' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : s.kind === 'user' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30' : s.reasoning ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800'}`}>
                      {s.kind === 'tool' ? s.tool || s.label : s.kind === 'user' ? 'USER' : s.reasoning ? 'REASON' : 'AI'}
                    </span>
                    <span className="truncate block">{s.label}</span>
                  </button>
                ))}
              </div>

              {/* 步骤详情 */}
              <div className="flex-1 p-4 overflow-y-auto max-h-[55vh]">
                {cur ? (
                  <div className="space-y-2">
                    <div className="text-xs text-zinc-400">{fmtTime(cur.ts)} · {cur.label}</div>
                    {cur.text && (
                      <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 max-h-80 overflow-y-auto">{cur.text}</pre>
                    )}
                    {cur.input != null && (
                      <pre className="text-xs font-mono text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap break-all bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 max-h-60 overflow-y-auto">
                        {typeof cur.input === 'string' ? cur.input : JSON.stringify(cur.input, null, 2)}
                      </pre>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-400">{t('gateway.trace.selectStep')}</div>
                )}
              </div>
            </div>

            {/* 步骤进度条 */}
            {steps.length > 1 && (
              <div className="px-5 py-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0">
                <div className="flex items-center gap-3 text-xs text-zinc-400 mb-1">
                  <span>Step {stepIdx + 1} / {steps.length}</span>
                  <span className="flex-1" />
                  <span>{cur?.label}</span>
                </div>
                <input type="range" min={0} max={steps.length - 1} value={stepIdx}
                  onChange={e => setStepIdx(+e.target.value)}
                  className="w-full h-1 accent-blue-600 cursor-pointer" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 用量明细区块标题（1–5 结构化） */
function DetailSection({ n, title, hint, children }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="w-4 h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-bold text-zinc-500 dark:text-zinc-400 flex items-center justify-center shrink-0">{n}</span>
        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">{title}</h4>
        {hint && <span className="text-xs text-zinc-400 font-normal ml-1">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** Claude Desktop 等：会话 jsonl 补录（无 agent_id 的 api-key 应用） */
function appHasSessionImport(app) {
  if (!app) return false;
  if (app.agent_id || app.link_method === 'direct' || app.link_method === 'shim') return true;
  return app.preset_id === 'claude-desktop' || app.preset_id === 'codex-desktop';
}

/** 可打开 Session Trace 的 agent（Claude Desktop 共用 claude-code jsonl） */
function traceAgentIdForApp(app) {
  if (!app) return null;
  if (['cursor', 'claude-code', 'codex'].includes(app.agent_id)) return app.agent_id;
  if (app.preset_id === 'claude-desktop') return 'claude-code';
  if (app.preset_id === 'codex-desktop') return 'codex';
  return null;
}

/** 数据来源摘要：网关 / 会话补录（或二者皆有） */
function buildDataSourceSummary(app, proxy, session, fmtN, t) {
  const hasGateway = app.link_method === 'api-key' || app.link_method === 'shim';
  const hasSession = appHasSessionImport(app);
  const tags = [];
  if (hasGateway && proxy.calls > 0) {
    tags.push({ icon: '🛰️', label: t('gateway.detail.sourceGateway'), calls: proxy.calls, tokens: proxy.tokens, tone: 'blue' });
  }
  if (hasSession) {
    tags.push({ icon: '📄', label: t('gateway.detail.sourceSession'), calls: session.calls, tokens: session.tokens, tone: 'green' });
  }
  const summary = tags.length === 2
    ? t('gateway.detail.sourceBoth')
    : tags[0]?.label || '—';
  return { summary, tags };
}

/** 悬浮提示用：真实工作区路径（过滤 Agent 内部存储目录） */
function projectPathTooltip(row) {
  const p = row?.project_path;
  if (!p) return row?.project || '—';
  const s = String(p).replace(/\\/g, '/');
  if (!/\/\.claude\/projects\//.test(s) && !/\/\.codex\/sessions\//.test(s)) return p;
  const slug = s.split('/').filter(Boolean).pop() || '';
  if (!slug) return p;
  // githubprojects 仓库名可含连字符
  const gh = slug.match(/^(.*?githubprojects-)(.+)$/i);
  if (gh) {
    const prefixPath = '/' + gh[1].replace(/-$/, '').replace(/^-/, '').replace(/-/g, '/');
    if (/^\/(Users|home|var|opt|Volumes|tmp)\//i.test(prefixPath)) {
      return `${prefixPath}/${gh[2]}`;
    }
  }
  const decoded = '/' + slug.replace(/^-/, '').replace(/-/g, '/');
  if (/^\/(Users|home|var|opt|Volumes|tmp)\//i.test(decoded)) return decoded;
  return p;
}

/** 从会话行提取短项目名（与 session-browser 逻辑一致） */
function shortProjectName(row) {
  if (!row) return '—';
  const p = row.project;
  if (p && !p.includes('/') && !/^-?Users-/i.test(p) && !/^githubprojects-/i.test(p)
      && !/^\d{1,2}$/.test(p) && p.length <= 64
      && !(/^-?[A-Za-z]+-/.test(p) && (p.match(/-/g) || []).length >= 3)) {
    return p;
  }
  const raw = row.project_path || p || '';
  const m = String(raw).match(/githubprojects-(.+)$/i);
  if (m) return m[1];
  const slug = String(raw).replace(/\\/g, '/').split('/').filter(Boolean).pop() || raw;
  const decoded = slug && /^-?[A-Za-z]/.test(slug) && slug.includes('-')
    ? '/' + slug.replace(/^-/, '').replace(/-/g, '/')
    : null;
  if (decoded && /^\/(Users|home|var|opt|Volumes|tmp)\//i.test(decoded)) {
    return decoded.split('/').filter(Boolean).pop() || decoded;
  }
  return p || slug || '—';
}

// 单个应用的用量明细弹窗
function AppDetailModal({ app, onClose }) {
  const { t } = useLang();
  const [days, setDays]           = useState(30);
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [selectedSid, setSelectedSid] = useState(null);
  const [traceSid, setTraceSid]   = useState(null);
  const [modelFilter, setModelFilter] = useState(null);  // 从「按模型」筛选下方调用明细

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSelectedSid(null);
    setTraceSid(null);
    setModelFilter(null);
    window.electronAPI?.apps?.detail?.(app, days)
      .then(d => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [app, days]);

  const fmtN    = n => n >= 1_000_000 ? (n/1e6).toFixed(2)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);
  const fmtCost = n => (n != null && n > 0) ? ('$' + n.toFixed(n < 0.01 ? 4 : 3)) : null;
  const fmtMs   = n => (n != null) ? (n >= 1000 ? (n/1000).toFixed(1)+'s' : n+'ms') : null;
  const fmtTime = ts => ts ? new Date(ts*1000).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  const shortId = id => id ? (String(id).length > 12 ? String(id).slice(0,8)+'…'+String(id).slice(-4) : String(id)) : '—';
  const proxy   = data?.bySource?.find(s => s.source === 'proxy')   || { calls:0, tokens:0 };
  const session = data?.bySource?.find(s => s.source === 'session') || { calls:0, tokens:0 };

  const sourceSummary = buildDataSourceSummary(app, proxy, session, fmtN, t);
  const sessionHistoryRows = (data?.activity?.length ? data.activity : (data?.sessions || []).map(s => ({
    ...s, project: '—', context: shortId(s.session_id),
  }))).map(r => ({
    ...r,
    project: shortProjectName(r),
    project_path: projectPathTooltip(r),
  }));
  const traceAgentId = traceAgentIdForApp(app);
  const canTrace = !!traceAgentId;
  // Cursor 等无真实 model 的应用：不展示「按模型统计」与「调用明细」
  const showModelStats = data?.hasModelStats !== false && (data?.byModel?.length ?? 0) > 0;
  const showCallDetails = data?.hasModelStats !== false;
  const secSession = showModelStats ? 4 : 3;
  const secCalls   = showModelStats ? 5 : 4;

  // 调用明细：时间倒序平铺（可选按「按模型统计」筛选）
  const recentSorted = (() => {
    let rows = [...(data?.recent || [])];
    if (modelFilter) rows = rows.filter(r => r.model === modelFilter);
    return rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  })();

  return (
    <>
      {traceSid && canTrace && (
        <SessionTraceModal app={app} sessionId={traceSid} traceAgentId={traceAgentId} onClose={() => setTraceSid(null)} />
      )}
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl mx-4 max-h-[92vh] overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 bg-white dark:bg-zinc-900 z-10">
          <span className="text-xl">{app.icon}</span>
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">{t('gateway.detail.usageTitle', { name: app.name })}</h3>
          <select value={days} onChange={e => setDays(+e.target.value)}
            className="text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 outline-none text-zinc-600 dark:text-zinc-300">
            <option value={7}>{t('gateway.detail.days7')}</option><option value={30}>{t('gateway.detail.days30')}</option><option value={90}>{t('gateway.detail.days90')}</option>
          </select>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg">✕</button>
        </div>

        {loading ? (
          <div className="py-16 flex flex-col items-center gap-2 text-xs text-zinc-400">
            <div className="w-5 h-5 border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin" />{t('gateway.common.loading')}
          </div>
        ) : !data ? (
          <div className="py-16 text-center text-xs text-zinc-400">{t('gateway.common.noData')}</div>
        ) : (
          <div className="p-5 space-y-6">

            {/* 1. 数据来源 */}
            <DetailSection n="1" title={t('gateway.detail.dataSource')}>
              <div className="text-xs text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-800/40 rounded-lg px-3 py-2.5">
                <span className="text-zinc-700 dark:text-zinc-300">{sourceSummary.summary}</span>
                {sourceSummary.tags.length > 1 && (
                  <span className="text-xs text-zinc-400 ml-2">{t('gateway.detail.deduped')}</span>
                )}
                <div className="flex flex-wrap gap-2 mt-2">
                  {sourceSummary.tags.map(tag => (
                    <span key={tag.label}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                        tag.tone === 'blue'
                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400'
                          : 'bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400'
                      }`}>
                      {tag.icon} {tag.label} {tag.calls} {t('gateway.common.times')} · {fmtN(tag.tokens)} tok
                    </span>
                  ))}
                </div>
              </div>
            </DetailSection>

            {/* 2. 概要总计 */}
            <DetailSection n="2" title={t('gateway.detail.summary')}>
              <div className="grid grid-cols-5 gap-2">
                {[
                  [t('gateway.detail.totalCalls'), fmtN(data.total.calls)],
                  [t('gateway.detail.totalTokens'),  fmtN(data.total.tokens)],
                  [t('gateway.detail.inputTokens'), fmtN(data.total.inTok)],
                  [t('gateway.detail.outputTokens'), fmtN(data.total.outTok)],
                  [t('gateway.detail.estCost'),  fmtCost(data.total.totalCost) || '—'],
                ].map(([l,v]) => (
                  <div key={l} className="bg-zinc-50 dark:bg-zinc-800/50 rounded-xl p-3">
                    <div className="text-xs text-zinc-400 dark:text-zinc-500">{l}</div>
                    <div className="text-lg font-bold text-zinc-800 dark:text-zinc-100 mt-0.5 truncate">{v}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-zinc-400 mt-2">{t('gateway.detail.costHint')}</p>
            </DetailSection>

            {/* 3. 按模型统计（无 model 字段的应用不展示） */}
            {showModelStats && (
            <DetailSection n="3" title={t('gateway.detail.byModel')} hint={modelFilter ? t('gateway.detail.filterActive', { model: modelFilter }) : t('gateway.detail.filterHint')}>
              <div className="border border-zinc-100 dark:border-zinc-800 rounded-lg divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.byModel.map(m => (
                  <div key={m.model}
                    onClick={() => setModelFilter(modelFilter === m.model ? null : m.model)}
                    className={`flex items-center gap-3 px-3 py-1.5 text-xs cursor-pointer select-none hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${modelFilter === m.model ? 'bg-blue-50 dark:bg-blue-900/10' : ''}`}>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300 flex-1 min-w-0 break-all">{m.model}</span>
                    <span className="text-zinc-500 w-16 text-right">{m.calls} {t('gateway.common.times')}</span>
                    <span className="text-zinc-700 dark:text-zinc-300 w-20 text-right font-medium">{fmtN(m.tokens)} tok</span>
                  </div>
                ))}
              </div>
              {modelFilter && (
                <button type="button" onClick={() => setModelFilter(null)}
                  className="text-xs text-blue-600 dark:text-blue-400 mt-1.5">{t('gateway.detail.clearFilter')}</button>
              )}
            </DetailSection>
            )}

            {/* 4. 按会话历史 */}
            <DetailSection n={secSession} title={t('gateway.detail.bySession')} hint={canTrace ? t('gateway.detail.traceHint') : undefined}>
              {sessionHistoryRows.length === 0 ? (
                <div className="text-xs text-zinc-400 px-1">{t('gateway.detail.noSessions')}</div>
              ) : (
                <div className="border border-zinc-100 dark:border-zinc-800 rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[minmax(5.5rem,1.15fr)_minmax(0,2fr)_3.5rem_3.5rem_4.5rem_3.5rem] gap-2 px-3 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-50 dark:bg-zinc-800/40 border-b border-zinc-100 dark:border-zinc-800">
                    <span>{t('gateway.detail.colProject')}</span><span>{t('gateway.detail.colContext')}</span><span className="text-right">{t('gateway.detail.colRequests')}</span><span className="text-right">Token</span><span className="text-right">{t('gateway.detail.colTime')}</span><span className="text-right">{canTrace ? 'Trace' : t('gateway.detail.colDetail')}</span>
                  </div>
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-64 overflow-y-auto">
                    {sessionHistoryRows.map(row => (
                      <div key={row.session_id}>
                        <div
                          className={`grid grid-cols-[minmax(5.5rem,1.15fr)_minmax(0,2fr)_3.5rem_3.5rem_4.5rem_3.5rem] gap-2 px-3 py-2 text-xs items-center hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${selectedSid === row.session_id ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300 truncate min-w-0" title={projectPathTooltip(row)}>{row.project}</span>
                          <span className="text-zinc-600 dark:text-zinc-400 truncate" title={row.context}>{row.context || '—'}</span>
                          <span className="text-zinc-500 text-right">{row.calls || 0}</span>
                          <span className="text-zinc-700 dark:text-zinc-300 text-right font-medium">{fmtN(row.tokens)}</span>
                          <span className="text-zinc-400 text-right text-xs">{fmtTime(row.lastTs)}</span>
                          <span className="text-right">
                            {canTrace ? (
                              <button type="button" onClick={() => setTraceSid(row.session_id)}
                                className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400">
                                Trace
                              </button>
                            ) : (
                              <button type="button" onClick={() => setSelectedSid(selectedSid === row.session_id ? null : row.session_id)}
                                className="text-xs text-zinc-400 hover:text-zinc-600">
                                {selectedSid === row.session_id ? '▾' : '▸'}
                              </button>
                            )}
                          </span>
                        </div>
                        {selectedSid === row.session_id && !canTrace && (
                          <div className="bg-zinc-50 dark:bg-zinc-800/30 divide-y divide-zinc-100 dark:divide-zinc-800/60 pl-4 pb-1">
                            {(data?.recent || []).filter(r => r.session_id === row.session_id).slice(0, 20).map((r, i) => (
                              <div key={i} className="flex items-center gap-2 px-3 py-1 text-xs">
                                <span className="text-zinc-400 w-20 shrink-0">{fmtTime(r.ts)}</span>
                                <span className="text-zinc-600 dark:text-zinc-400 flex-1 truncate">{r.label || r.model || '—'}</span>
                                <span className="text-zinc-500 shrink-0">↑{fmtN(r.inTok)} ↓{fmtN(r.outTok)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </DetailSection>

            {/* 5. 调用明细（无 model 的应用不展示） */}
            {showCallDetails && (
            <DetailSection n={secCalls} title={showModelStats ? t('gateway.detail.byModelCalls') : t('gateway.detail.callDetails')} hint={t('gateway.detail.recentCount', { n: recentSorted.length })}>
              {recentSorted.length === 0 ? (
                <div className="text-xs text-zinc-400 px-1">—</div>
              ) : (
                <div className="border border-zinc-100 dark:border-zinc-800 rounded-lg divide-y divide-zinc-100 dark:divide-zinc-800 max-h-80 overflow-y-auto">
                  {recentSorted.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs flex-wrap">
                      <span className="text-zinc-400 w-24 shrink-0">{fmtTime(r.ts)}</span>
                      <span className={`px-1 rounded text-xs shrink-0 ${r.source === 'proxy' ? 'bg-blue-50 text-blue-500 dark:bg-blue-900/20' : 'bg-green-50 text-green-600 dark:bg-green-900/20'}`}>
                        {r.source === 'proxy' ? t('gateway.detail.sourceProxy') : t('gateway.detail.sourceSess')}
                      </span>
                      {showModelStats && (
                        <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400 shrink-0 break-all" title={r.model}>{r.model || '—'}</span>
                      )}
                      {!showModelStats && (
                        <span className="text-zinc-600 dark:text-zinc-400 flex-1 truncate" title={r.label || r.context}>
                          {r.label || r.context || shortId(r.session_id) || '—'}
                        </span>
                      )}
                      <span className="text-zinc-500 shrink-0 tabular-nums ml-auto">↑{fmtN(r.inTok)} ↓{fmtN(r.outTok)}</span>
                      {fmtMs(r.latency_ms) && <span className="text-zinc-400 shrink-0">{fmtMs(r.latency_ms)}</span>}
                      {fmtCost(r.cost_usd) && <span className="text-emerald-600 dark:text-emerald-400 shrink-0">{fmtCost(r.cost_usd)}</span>}
                      {r.status_code != null && r.status_code >= 400 && <span className="text-red-500 shrink-0">{r.status_code}</span>}
                    </div>
                  ))}
                </div>
              )}
            </DetailSection>
            )}

          </div>
        )}
      </div>
    </div>
    </>
  );
}

function AppManager({ externalRoutes, availableModels = [] }) {
  const { t } = useLang();
  const appsApi = getApps();
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
    try {
      const localCfg = await getLocalConfig().get().catch(() => ({}));
      setRoutes(localCfg?.scene_routes || []);

      const [appList, gw] = await Promise.all([
        appsApi.list().catch(() => []),
        getGateway().status().catch(() => null),
      ]);
      const list = Array.isArray(appList) ? appList : [];
      setApps(list);
      if (gw?.port) {
        const host = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
        setLocalBase(`http://${host}:${gw.port}/v1`);
      }
      if (list.length && appsApi.stats) {
        appsApi.stats(list).then(s => setAppStats(s || {})).catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  }, [appsApi]);

  useEffect(() => { load(); }, [load]);

  // Claude 名（Claude Desktop inferenceModels 的 name 只能用 Anthropic 名）
  useEffect(() => { appsApi.claudeModels?.().then(m => setClaudeModels(Array.isArray(m) ? m : [])).catch(() => {}); }, [appsApi]);

  // 配置下发/变更后，主进程通知 → 重新加载应用列表（新托管/新可配置 api-key 行立即显示）
  useEffect(() => {
    const off = appsApi.onChanged?.(() => load());
    return () => { if (typeof off === 'function') off(); };
  }, [load, appsApi]);

  // 手工添加点击时就先持久化了一条草稿（为了显示 api_key）。若用户没保存/取消就切走 tab
  // （AppManager 卸载），把这条未保存草稿删掉，否则切回来会多出一条「新应用」。
  const manualDraftRef = useRef(null);
  useEffect(() => { manualDraftRef.current = manualDraft; }, [manualDraft]);
  useEffect(() => () => {
    const d = manualDraftRef.current;
    if (d?._isNew && d.id) getApps().delete(d.id).catch(() => {});
  }, []);

  async function handleUpdateApp(data) {
    let id = data.id;
    // 虚拟 shim 应用（仅展示、未落库）：先落库拿到真实 id 再更新
    const app = apps.find(a => a.id === data.id);
    if (app?._virtual && app.link_method === 'shim') {
      const created = await appsApi.ensureShimApp?.({
        agent_id: app.agent_id, name: app.name, icon: app.icon,
      }).catch(() => null);
      if (created?.id) id = created.id;
    }
    // 保存即清除草稿标记（新建面板保存后该应用才在列表显示）；对非草稿应用是无害的 no-op
    const updated = await appsApi.update({ ...data, id, draft: false }).catch(() => null);
    // shim 应用：路由/key 改动后需重写 shim 脚本才生效
    if (app?.link_method === 'shim' && app.agent_id) {
      await window.electronAPI.agents?.apply(app.agent_id).catch(() => {});
    }
    await load();
    // 若设置弹窗仍开着且 id 未变，刷新其数据
    if (updated && settings?.id === updated.id) setSettings(updated);
  }

  async function handleDeleteApp(id) {
    if (!window.confirm(t('gateway.apps.confirmDelete'))) return;
    await appsApi.delete(id).catch(() => {});
    if (settings?.id === id) setSettings(null);
    await load();
  }

  async function handleRegenKey(id) {
    const r = await appsApi.regenKey(id).catch(() => null);
    if (r?.ok) {
      await load();
      // 用最新 key 刷新设置弹窗 / 手工添加面板
      const fresh = (await appsApi.list().catch(() => []) || []).find(a => a.id === id);
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
    return pick ? encodeTierModelRoute(pick.tier, pick.id) : '';
  }

  // 手工添加：未被识别的应用 → 创建 manual 应用，内联展开 ManualAddPanel
  // （已识别的 CLI/桌面应用都在列表里直接托管，不走此入口）
  async function addCustom() {
    // draft:true → 列表不显示这条临时条目（只在内联面板里编辑），保存时清除草稿标记才出现。
    const created = await appsApi.create({
      name: t('gateway.apps.newAppName'), icon: '🔧', link_method: 'manual',
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
    if (d?.id) await appsApi.delete(d.id).catch(() => {});
    await load();
  }

  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState({});   // id → 提示文字
  function showNotice(id, msg, ms = 6000) {
    setNotice(n => ({ ...n, [id]: msg }));
    setTimeout(() => setNotice(n => { const c = { ...n }; delete c[id]; return c; }), ms);
  }

  // 纳管/还原：
  //   纳管 = hosted:true + route_id:null + 官方订阅（还原配置/撤 shim，不走网关）
  //   还原 = hosted:false + route_id:null + 官方订阅（同上，停止纳管统计）
  // 走网关由路由下拉单独选择模型/路由触发。
  async function setTracked(app, on) {
    let appId = app.id;
    if (app._virtual && app.link_method === 'shim') {
      const c = await appsApi.ensureShimApp({ agent_id: app.agent_id, name: app.name, icon: app.icon }).catch(() => null);
      if (c) appId = c.id;
    }
    if (on) {
      setBusyId(appId);
      // 纳管默认官方订阅：清空路由，确保不注入网关
      await appsApi.update({ id: appId, hosted: true, route_id: null }).catch(() => {});
      if (app.host_method === 'config-file') {
        await appsApi.revertConfigFile({ app_id: appId, config_file: app.config_file }).catch(() => {});
        showNotice(appId, t('gateway.apps.managedOfficial'));
      } else if (app.link_method === 'shim' && app.agent_id) {
        await window.electronAPI.agents?.revert(app.agent_id).catch(() => {});
        showNotice(appId, t('gateway.apps.managedOfficialShell'));
      } else if (app.link_method === 'direct') {
        showNotice(appId, t('gateway.apps.managedSession'));
      } else {
        showNotice(appId, t('gateway.apps.managedOfficialShort'));
      }
    } else {
      const msg = app.link_method === 'direct'
        ? t('gateway.apps.confirmUntrackDirect')
        : t('gateway.apps.confirmRevert');
      if (!window.confirm(msg)) return;
      setBusyId(appId);
      if (app.link_method === 'shim' && app.agent_id) {
        await window.electronAPI.agents?.revert(app.agent_id).catch(() => {});
        showNotice(appId, t('gateway.apps.revertedShell'));
      } else if (app.host_method === 'config-file') {
        await appsApi.revertConfigFile({ app_id: appId, config_file: app.config_file }).catch(() => {});
        showNotice(appId, t('gateway.apps.revertedApp'));
      } else if (app.link_method === 'direct') {
        showNotice(appId, t('gateway.apps.untracked'));
      }
      await appsApi.update({ id: appId, hosted: false, route_id: null }).catch(() => {});
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
    const model = app.route_id
      ? (routes.some(r => r.model_key === app.route_id || r.id === app.route_id)
          ? app.route_id
          : (modelIdFromRoute(app.route_id, routes) || app.route_id))
      : (availableModels[0]?.id || 'gpt-4o');
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
      const msg = e?.name === 'AbortError' ? t('gateway.common.timeout30s') : (e?.message || t('gateway.common.connectFailed'));
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
    else if (app.route_id) label = modelIdFromRoute(app.route_id, routes) || app.route_id;
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
      if (isCodexConfig && app.route_id) patch.model = modelIdFromRoute(app.route_id, routes) || app.route_id;
      const r = await appsApi.writeConfigFile({
        app_id: app.id, config_file: app.config_file, patch, env, force,
      }).catch(e => ({ ok: false, error: e.message }));
      // 冲突：目标配置项已有不同的值 → 确认后强制覆盖；取消则回滚
      if (r && !r.ok && Array.isArray(r.conflicts) && r.conflicts.length) {
        const lines = r.conflicts.map(c => `· ${c.key}\n${t('gateway.app.conflictCurrent', { val: c.current })}\n${t('gateway.app.conflictWanted', { val: c.wanted })}`).join('\n');
        if (window.confirm(t('gateway.app.conflictConfirm', { lines }))) return run(true);
        await onAbort?.();
        return false;
      }
      if (!r?.ok) { await onAbort?.(); window.alert(t('gateway.apps.hostFailed', { msg: r?.error || t('gateway.common.writeFailed') })); return false; }
      return true;
    };
    return run(false);
  }

  // API Key 应用（虚拟行）「纳管」：建条目 + 标记 hosted（默认直连，不写配置）。要走网关在路由下拉选模型。
  async function addApiKeyApp(d) {
    setBusyId(d.id);
    const created = await appsApi.create({
      name: d.name, icon: d.icon, link_method: 'api-key',
      preset_id: d.preset_id, route_id: null,
      inject: 'config-file', config_file: d.config_file, patch: d.patch, env: d.env || null,
    }).catch(() => null);
    if (created?.id) await appsApi.update({ id: created.id, hosted: true }).catch(() => {});
    setBusyId(null);
    if (created?.id) showNotice(created.id, t('gateway.apps.managedDefault'));
    await load();
  }

  // 已保存但已取消纳管的 api-key 应用「重新纳管」→ 默认官方订阅（与列表纳管一致）
  async function rehostApiKeyApp(app) {
    await setTracked(app, true);
  }

  // 还原：与 setTracked(off) 一致，路由恢复官方订阅
  async function handleCancelManage(app) {
    await setTracked(app, false);
  }

  // 保存设置（已在面板内 onUpdate 持久化）→ 仅关闭并刷新
  function closeSettings() { setSettings(null); load(); }
  // 取消/关闭：若是未保存的新应用则删除（必须等删除完成再刷新，否则列表读到删除前的旧状态）
  async function cancelSettings() {
    const s = settings;
    setSettings(null);
    if (s?._isNew && s.id) {
      await appsApi.delete(s.id).catch(() => {});
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
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white transition-colors font-medium">
                {t('gateway.apps.new')}
              </button>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('gateway.apps.newHint')}</span>
              <div className="ml-auto"><ImportConfigButton onImported={load} /></div>
            </div>

            {/* 提醒：纳管后若未生效需重启应用 */}
            <div className="mb-3 text-xs text-zinc-400 dark:text-zinc-500 px-1">
              {t('gateway.apps.restartHint')}
            </div>

            {/* 手工添加 → 内联面板（ManualAddPanel，独立组件）*/}
            {manualDraft && (
              <ManualAddPanel app={manualDraft} routes={routes} availableModels={availableModels}
                onUpdate={handleUpdateApp} onRegenKey={handleRegenKey}
                onSave={closeManualDraft} onCancel={cancelManualDraft} />
            )}

            {/* 应用列表 */}
            {loading ? (
              <div className="py-10 flex flex-col items-center justify-center gap-2 text-xs text-zinc-400">
                <div className="w-5 h-5 border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
                {t('gateway.apps.loading')}
              </div>
            ) : visibleApps.length === 0 ? (
              <div className="py-6 text-center text-xs text-zinc-400">
                {t('gateway.apps.empty')}
              </div>
            ) : (
              <div className={`flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800/60 border border-zinc-200 dark:border-zinc-700/60 rounded-xl overflow-hidden ${visibleApps.length > 20 ? 'max-h-[min(75vh,900px)] overflow-y-auto' : ''}`}>
                {/* 表头（超过 20 个时列表滚动，表头吸顶）*/}
                <div className={`${APPS_TABLE_GRID} py-1.5 bg-zinc-50 dark:bg-zinc-800/50 text-xs font-medium text-zinc-400 dark:text-zinc-500 sticky top-0 z-10 border-b border-zinc-100 dark:border-zinc-800`}>
                  <span className="text-base text-center shrink-0 invisible">🔧</span>
                  <div className="min-w-0">{t('gateway.apps.colApp')}</div>
                  <div className="min-w-0">{t('gateway.apps.colStatus')}</div>
                  <div className="min-w-0">{t('gateway.apps.colLink')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colCalls')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colTokens')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colLastUsed')}</div>
                  <div className="min-w-0">{t('gateway.apps.colRoute')}</div>
                  <div className="min-w-0" />
                  <div className="min-w-0">{t('gateway.apps.colActions')}</div>
                </div>
                {visibleApps.map(app => {
                  const st = appStats[app.id] || { calls: 0, tokens: 0, lastTs: null };
                  const fmtTokens = n => n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M'
                    : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);
                  const fmtTime = ts => {
                    if (!ts) return '—';
                    const diff = Math.floor((Date.now() - ts*1000)/1000);
                    if (diff < 60) return t('gateway.common.justNow');
                    if (diff < 3600) return t('gateway.common.minutesAgo', { n: Math.floor(diff/60) });
                    if (diff < 86400) return t('gateway.common.hoursAgo', { n: Math.floor(diff/3600) });
                    if (diff < 7*86400) return t('gateway.common.daysAgo', { n: Math.floor(diff/86400) });
                    return new Date(ts*1000).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
                  };
                  // 状态列：在线(已纳管) / 未纳管；经网关与否由路由下拉区分
                  const keyApp = isKeyApp(app.link_method);
                  const isCfgApp = keyApp && app.host_method === 'config-file';
                  const isManual = app.link_method === 'manual';
                  const isDirectOnly = app.link_method === 'direct';        // 仅官方订阅（cursor 等）
                  const hostable = app.link_method === 'shim' || isCfgApp || isDirectOnly;
                  const tracked  = app.hosted === true;
                  const isManaged = hostable ? tracked : (keyApp && !app._virtual_apikey);
                  const isGatewayRouted = hostable ? !!(tracked && app.route_id) : !!(keyApp && app.route_id);
                  // 路由下拉当前值：tier:id 区分同模型跨层；api-key/manual 有 route_id 即展示
                  const currentRouteValue = (() => {
                    if (!app.route_id) return '';
                    const val = routeSelectValue(app.route_id, availableModels, routes);
                    const known = isKnownRouteSelectValue(val, availableModels, routes);
                    if (keyApp && !isDirectOnly) return known ? val : '';
                    if (!tracked) return '';
                    return known ? val : '';
                  })();
                  const isActive = isManaged;
                  const statusDot = isManaged
                    ? 'bg-green-400 shadow-[0_0_6px] shadow-green-400/60'
                    : 'bg-zinc-300 dark:bg-zinc-600';
                  const rowBg = isManaged
                    ? 'bg-white dark:bg-zinc-900/60 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/30'
                    : 'bg-zinc-50/40 dark:bg-zinc-800/10 hover:bg-zinc-50 dark:hover:bg-zinc-800/20';
                  const isApiLink = app.link_method === 'manual';
                  const statusLabel = !isManaged
                    ? t('gateway.apps.statusUntracked')
                    : isApiLink
                      ? t('gateway.apps.statusApiOnline')
                      : t('gateway.apps.statusOnline');
                  const statusText = isManaged ? 'text-green-600 dark:text-green-400' : 'text-zinc-400';
                  return (
                    // 离线不整行压暗（否则操作按钮看着像禁用）；离线感由灰底/灰点/「离线」标签/
                    // 图标灰度/灰名体现，操作按钮保持全亮可点（含「测试」）。
                    <div key={app.id} className={`${APPS_TABLE_GRID} py-2.5 transition-colors ${rowBg}`}>
                      {/* 图标 + 名称 */}
                      <span className={`text-base text-center shrink-0 ${isActive ? '' : 'grayscale opacity-60'}`}>{app.icon}</span>
                      <div
                        className={`text-xs font-medium truncate min-w-0 ${isActive ? 'text-zinc-800 dark:text-zinc-100' : 'text-zinc-400 dark:text-zinc-500'}`}
                        title={app.name}
                      >{app.name}</div>

                      {/* 状态列：应用=已纳管/未纳管，API=在线 */}
                      <div className="min-w-0 flex items-center gap-1.5 overflow-hidden">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
                        <span className={`text-xs font-medium truncate ${statusText}`}>{statusLabel}</span>
                      </div>

                      {/* 接入方式列 */}
                      <div className="min-w-0 text-xs text-zinc-400 truncate">
                        {linkMethodLabel(app.link_method, t)}
                      </div>

                      {/* 统计：请求数 / token / 最后使用（点击打开用量明细）*/}
                      <div className="contents cursor-pointer" title={t('gateway.apps.statsTitle')} onClick={() => setDetailApp(app)}>
                        <div className="text-center min-w-0 overflow-hidden tabular-nums text-xs font-semibold text-zinc-700 dark:text-zinc-200 rounded hover:bg-zinc-100/60 dark:hover:bg-zinc-700/30">{st.calls > 0 ? st.calls.toLocaleString() : '—'}</div>
                        <div className="text-center min-w-0 overflow-hidden tabular-nums text-xs font-semibold text-zinc-700 dark:text-zinc-200 rounded hover:bg-zinc-100/60 dark:hover:bg-zinc-700/30">{st.tokens > 0 ? fmtTokens(st.tokens) : '—'}</div>
                        <div className="text-center min-w-0 overflow-hidden text-xs font-medium text-zinc-600 dark:text-zinc-300 rounded hover:bg-zinc-100/60 dark:hover:bg-zinc-700/30">{fmtTime(st.lastTs)}</div>
                      </div>

                      {/* 路由下拉槽 */}
                      <div className="min-w-0">
                      {(((keyApp || app.link_method === 'shim') && app.route_bindable !== false) || isDirectOnly) && !app._virtual_apikey && (
                      <select
                        value={currentRouteValue}
                        disabled={isDirectOnly || (hostable && !tracked)}
                        onChange={async e => {
                          if (isDirectOnly) return;   // 仅直连应用：不可改路由
                          const val = e.target.value || null;
                          // 直连官方(空) = 还原配置/撤 shim → 应用直连官方、不走网关；
                          // 选模型/路由 = 写配置纳管/注入 shim → 走网关并按 keyScene 路由。
                          setBusyId(app.id);
                          // 选模型/路由 = 纳管 + 走网关（hosted:true）；直连官方(空) = 还原配置/撤 shim，保持纳管
                          if (app.host_method === 'config-file') {        // Claude Desktop 等 config-file 应用
                            await appsApi.update({ id: app.id, route_id: val, ...(val ? { hosted: true } : {}) }).catch(() => {});
                            if (val) { await writeApiKeyConfig({ ...app, route_id: val }); showNotice(app.id, t('gateway.apps.routeSwitchedApp')); }   // 写配置→网关
                            else     { await appsApi.revertConfigFile({ app_id: app.id, config_file: app.config_file }).catch(() => {}); showNotice(app.id, t('gateway.apps.routeOfficialApp')); }
                          } else if (app.link_method === 'shim' && app.agent_id) {  // CLI 透明托管
                            let appId = app.id;
                            if (app._virtual) {
                              const created = await appsApi.ensureShimApp({ agent_id: app.agent_id, name: app.name, icon: app.icon }).catch(() => null);
                              if (created) appId = created.id;
                            }
                            await appsApi.update({ id: appId, route_id: val, ...(val ? { hosted: true } : {}) }).catch(() => {});
                            if (val) { await window.electronAPI.agents?.apply(app.agent_id).catch(() => {}); showNotice(appId, t('gateway.apps.routeSwitchedShell')); }   // 注入 shim → 网关
                            else     { await window.electronAPI.agents?.revert(app.agent_id).catch(() => {}); showNotice(appId, t('gateway.apps.routeOfficialShell')); }
                          } else {                                          // 纯 api-key / manual
                            await appsApi.update({
                              id: app.id,
                              route_id: val,
                              ...(val ? { hosted: true } : {}),
                            }).catch(() => {});
                          }
                          setBusyId(null);
                          await load();
                        }}
                        className="w-full text-[11px] bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-1 outline-none text-zinc-600 dark:text-zinc-400 disabled:opacity-40 disabled:cursor-not-allowed">
                        {/* Cursor 等仅官方订阅应用：固定一项；manual 必须绑路由；其余可选官方订阅或走网关 */}
                        {isManual
                          ? <option value="" disabled>{t('gateway.app.routeRequired')}</option>
                          : <option value="">{t('gateway.app.routeOfficial')}</option>}
                        {!isDirectOnly && (() => {
                          const avail = new Set(availableModels.map(m => m.id));
                          const usable = routes.filter(r => (r.steps || []).some(s => avail.has(s.model || s.label)));
                          return (
                            <>
                              {usable.length > 0 && (
                                <optgroup label={t('gateway.app.sceneRoutes')}>
                                  {usable.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon} {r.scene_name}</option>)}
                                </optgroup>
                              )}
                              {['free','p2p','paid'].map(tier => {
                                const tm = availableModels.filter(m => m.tier === tier);
                                if (!tm.length) return null;
                                const label = tierModelLabel(tier, t);
                                return <optgroup key={tier} label={label}>{tm.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}</optgroup>;
                              })}
                            </>
                          );
                        })()}
                      </select>
                      )}
                      </div>

                      {/* 转发测试槽 */}
                      <div className="min-w-0 flex items-center justify-end gap-1.5">
                      {(app.api_key || isDirectOnly) && (() => {
                        const ts = testState[app.id];
                        return (
                          <>
                            {ts && !ts.busy && (
                              <span title={ts.ok ? `${ts.latency}ms` : ts.error}
                                className={`text-xs font-mono shrink-0 max-w-[120px] truncate ${ts.ok ? 'text-green-500 dark:text-green-400' : 'text-red-400'}`}>
                                {ts.ok ? `✓ ${ts.latency}ms` : `✗ ${ts.error}`}
                              </span>
                            )}
                            <button onClick={() => runAppTest(app)} disabled={ts?.busy || !isGatewayRouted}
                              className={`text-xs px-2 py-1 rounded-lg border transition-colors shrink-0 ${ts?.busy
                                ? 'border-zinc-300 dark:border-zinc-600 text-zinc-400 opacity-60 cursor-wait'
                                : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-500'} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-zinc-200 disabled:hover:text-zinc-500`}>
                              {ts?.busy ? t('gateway.common.testing') : t('gateway.common.test')}
                            </button>
                          </>
                        );
                      })()}
                      </div>

                      {/* 操作按钮 */}
                      <div className="flex items-center gap-2 shrink-0 flex-nowrap justify-end">
                      {isDirectOnly ? (
                        /* 仅官方订阅（cursor 等）：只读会话统计，设置/测试在走网关时可用，还原=取消纳管停统计 */
                        <>
                          <button onClick={() => setSettings(app)}
                            className="text-xs px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0">
                            {t('gateway.common.settings')}
                          </button>
                          {tracked ? (
                            <button onClick={() => setTracked(app, false)} disabled={busyId === app.id}
                              title={t('gateway.apps.revertTitle')}
                              className="text-xs px-2 py-1 rounded-md border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 shrink-0">
                              {busyId === app.id ? '…' : t('gateway.common.revert')}
                            </button>
                          ) : (
                            <button onClick={() => setTracked(app, true)} disabled={busyId === app.id}
                              className="text-xs px-2.5 py-1 rounded-md bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white disabled:opacity-40 shrink-0 font-medium transition-colors">
                              {busyId === app.id ? '…' : t('gateway.common.manage')}
                            </button>
                          )}
                        </>
                      ) : app.link_method === 'shim' ? (
                        /* 透明托管：设置 + 纳管/还原 开关（按 tracked）*/
                        <>
                          <button onClick={() => setSettings(app)}
                            className="text-xs px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0">
                            {t('gateway.common.settings')}
                          </button>
                          {tracked ? (
                            <button onClick={() => setTracked(app, false)} disabled={busyId === app.agent_id || busyId === app.id}
                              className="text-xs px-2 py-1 rounded-md border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 shrink-0">
                              {(busyId === app.agent_id || busyId === app.id) ? '…' : t('gateway.common.revert')}
                            </button>
                          ) : (
                            <button onClick={() => setTracked(app, true)} disabled={busyId === app.agent_id || busyId === app.id}
                              className="text-xs px-2.5 py-1 rounded-md bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white disabled:opacity-40 shrink-0 font-medium transition-colors">
                              {(busyId === app.agent_id || busyId === app.id) ? '…' : t('gateway.common.manage')}
                            </button>
                          )}
                        </>
                      ) : app._virtual_apikey ? (
                        /* API Key 应用（未纳管虚拟行）：一键纳管（写配置文件指向网关），与透明托管一致 */
                        <button onClick={() => addApiKeyApp(app)} disabled={busyId === app.id}
                          className="text-xs px-2.5 py-1 rounded-md bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white disabled:opacity-40 shrink-0 font-medium transition-colors">
                          {busyId === app.id ? '…' : t('gateway.common.manage')}
                        </button>
                      ) : app.host_method === 'config-file' ? (
                        /* config-file api-key 应用：设置 + 纳管/还原；纳管/还原默认官方订阅 */
                        <>
                          <button onClick={() => setSettings(app)}
                            className="text-xs px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0">
                            {t('gateway.common.settings')}
                          </button>
                          {tracked ? (
                            <button onClick={() => setTracked(app, false)} disabled={busyId === app.id}
                              className="text-xs px-2 py-1 rounded-md border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 shrink-0">
                              {busyId === app.id ? '…' : t('gateway.common.revert')}
                            </button>
                          ) : (
                            <button onClick={() => setTracked(app, true)} disabled={busyId === app.id}
                              className="text-xs px-2.5 py-1 rounded-md bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white disabled:opacity-40 shrink-0 font-medium transition-colors">
                              {busyId === app.id ? '…' : t('gateway.common.manage')}
                            </button>
                          )}
                        </>
                      ) : (
                        /* 普通 api-key 应用：设置 + 删除 */
                        <>
                          <button onClick={() => setSettings(app)}
                            className="text-xs px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0">
                            {t('gateway.common.settings')}
                          </button>
                          <button onClick={() => handleDeleteApp(app.id)}
                            className="text-xs px-2 py-1 rounded-md border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0">
                            {t('gateway.common.delete')}
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
                          <span className={`text-xs shrink-0 font-medium ${isWarn ? 'text-amber-500 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                            {msg}
                          </span>
                        );
                      })()}
                      </div>
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
  const { t } = useLang();
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
        let msg = r.needsRestartShell ? t('gateway.agent.appliedShell') : t('gateway.agent.applied');
        if (r.enabledProvider) msg += t('gateway.agent.enabledProvider', { name: r.enabledProvider });
        setNotice(n => ({ ...n, [id]: msg }));
        await refresh();
      } else {
        setNotice(n => ({ ...n, [id]: '✗ ' + (r.error || t('gateway.common.failed')) }));
      }
    } catch (e) { setNotice(n => ({ ...n, [id]: '✗ ' + e.message })); }
    setBusy(b => ({ ...b, [id]: false }));
  }

  async function handleRevert(id) {
    setBusy(b => ({ ...b, [id]: true }));
    setNotice(n => ({ ...n, [id]: '' }));
    try {
      const r = await revertAgent(id);
      if (r.ok) { setNotice(n => ({ ...n, [id]: t('gateway.agent.reverted') })); await refresh(); }
      else       { setNotice(n => ({ ...n, [id]: '✗ ' + (r.error || t('gateway.common.failed')) })); }
    } catch (e) { setNotice(n => ({ ...n, [id]: '✗ ' + e.message })); }
    setBusy(b => ({ ...b, [id]: false }));
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">🔌</span>
        <h2 className="font-semibold text-zinc-800 dark:text-zinc-100 text-sm">{t('gateway.agent.title')}</h2>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('gateway.agent.subtitle')}</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={refresh} className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">{t('gateway.common.refresh')}</button>
          <ImportConfigButton onImported={refresh} />
        </div>
      </div>
      {loading ? (
        <div className="text-xs text-zinc-400 py-2">{t('gateway.agent.detecting')}</div>
      ) : agents.length === 0 ? (
        <div className="text-xs text-zinc-400 py-2">{t('gateway.agent.empty')}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {agents.map(a => (
            <div key={a.id}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-sm transition-colors
                ${!a.installed ? 'opacity-40 border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/30' :
                  a.linked ? 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30' :
                             'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40'}`}
            >
              {/* 状态点 */}
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                !a.installed ? 'bg-zinc-300 dark:bg-zinc-600' :
                a.linked     ? 'bg-green-400' : 'bg-zinc-400 dark:bg-zinc-500'}`} />

              {/* 名称 + 策略 */}
              <div className="flex-1 min-w-0">
                <span className="font-medium text-zinc-800 dark:text-zinc-100">{a.name}</span>
                <span className="ml-2 text-xs text-zinc-400">
                  {a.installed ? (strategyLabel(a.strategy, t) || a.strategy) : t('gateway.agent.notInstalled')}
                </span>
              </div>

              {/* 接入状态标签 */}
              {a.installed && (
                <span className={`text-xs px-2 py-0.5 rounded-full shrink-0
                  ${a.linked ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
                              : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'}`}>
                  {a.linked ? t('gateway.agent.linked') : t('gateway.agent.notLinked')}
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
                  {busy[a.id] ? t('gateway.agent.applying') : t('gateway.agent.apply')}
                </button>
              )}
              {a.installed && a.linked && (
                <button
                  disabled={busy[a.id]}
                  onClick={() => handleRevert(a.id)}
                  className="shrink-0 text-xs px-3 py-1 rounded-lg bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300 disabled:opacity-50 transition-colors">
                  {busy[a.id] ? t('gateway.agent.reverting') : t('gateway.common.revert')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        {t('gateway.agent.hint')}
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
// Short tier label for inline display, e.g. "glm-5.1(p2p)"
const TIER_SHORT = { p2p: 'p2p', free: 'free', paid: 'paid' };

// Resolve step tier: 优先 step 上记录的 tier（同 id 跨层时），再查 availableModels
function resolveStepTier(stepModel, step, availableModels) {
  if (step?.tier) return step.tier;
  const m = availableModels.find(x => x.id === stepModel);
  return m ? m.tier : 'free';
}

// ── CopyButton ────────────────────────────────────────────────────────────────

function CopyButton({ text, label: labelProp, className = '' }) {
  const { t } = useLang();
  const label = labelProp ?? t('gateway.common.copy');
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button onClick={copy}
      className={`text-xs px-2.5 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors min-w-[48px] ${className}`}>
      {copied ? t('gateway.common.copiedSpace') : label}
    </button>
  );
}

// ── ModelSelect ───────────────────────────────────────────────────────────────

function ModelSelect({ availableModels, value, onChange }) {
  const { t } = useLang();
  const freeModels = availableModels.filter(m => m.tier === 'free');
  const p2pModels  = availableModels.filter(m => m.tier === 'p2p');
  const paidModels = availableModels.filter(m => m.tier === 'paid');
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-zinc-200 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded-lg px-2.5 py-2 text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500">
      {freeModels.length > 0 && (
        <optgroup label={t('gateway.app.tier.freeLayer')}>
          {freeModels.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}
        </optgroup>
      )}
      {p2pModels.length > 0 && (
        <optgroup label={t('gateway.app.tier.p2pLayer')}>
          {p2pModels.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}
        </optgroup>
      )}
      {paidModels.length > 0 && (
        <optgroup label={t('gateway.app.tier.paidLayer')}>
          {paidModels.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}
        </optgroup>
      )}
    </select>
  );
}

// ── SceneRouteEditor ──────────────────────────────────────────────────────────

// 条件路由：条件类型元数据（与网关 evalWhen 的 type/op 一致）
function ruleCondTypes(t) {
  return [
    { type: 'request_type', label: t('gateway.rule.type.requestType'), ops: ['is', 'not'], values: ['chat', 'image', 'video', 'embedding', 'audio'] },
    { type: 'input_tokens', label: t('gateway.rule.type.inputTokens'), ops: ['gt', 'lt', 'gte', 'lte'], value: 'number' },
    { type: 'keyword',      label: t('gateway.rule.type.keyword'),     ops: ['match', 'contains'], value: 'text', placeholder: t('gateway.rule.keywordPlaceholder') },
    { type: 'model',        label: t('gateway.rule.type.model'),       ops: ['is', 'contains'], value: 'text', placeholder: t('gateway.rule.modelPlaceholder') },
    { type: 'caller',       label: t('gateway.rule.type.caller'),      ops: ['is'], value: 'text', placeholder: t('gateway.rule.callerPlaceholder') },
    { type: 'classifier',   label: t('gateway.rule.type.classifier'),  ops: ['is', 'not'], value: 'category' },
  ];
}
function ruleOpLabel(t) {
  return { is: t('gateway.rule.op.is'), not: t('gateway.rule.op.not'), gt: '>', lt: '<', gte: '≥', lte: '≤', match: t('gateway.rule.op.match'), contains: t('gateway.rule.op.contains') };
}
const RULE_SEL = 'bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded px-1.5 py-1 text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500';

// 单条 when 条件编辑器：条件类型 + 算子 + 值（值控件随类型变化）。
// categories：智能分类的类别集合（来自分类器配置），用于「智能分类」条件的值下拉。
function RuleConditionEditor({ when, onChange, categories = [] }) {
  const { t } = useLang();
  const RULE_COND_TYPES = ruleCondTypes(t);
  const RULE_OP_LABEL = ruleOpLabel(t);
  const meta = RULE_COND_TYPES.find(c => c.type === when.type) || RULE_COND_TYPES[0];
  const setType = (t) => {
    const m = RULE_COND_TYPES.find(c => c.type === t);
    const v = m.values ? m.values[0] : (m.value === 'number' ? 0 : (m.value === 'category' ? (categories[0] || '') : ''));
    onChange({ type: t, op: m.ops[0], value: v });
  };
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-zinc-500 shrink-0">{t('gateway.rule.when')}</span>
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
          : <input value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} placeholder={t('gateway.rule.categoryPlaceholder')} className={RULE_SEL + ' w-44'} />
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
  const { t } = useLang();
  const free = availableModels.filter(m => m.tier === 'free');
  const p2p  = availableModels.filter(m => m.tier === 'p2p');
  const paid = availableModels.filter(m => m.tier === 'paid');
  const list = steps || [];
  const add    = () => setSteps([...list, { label: '', model: '', tier: 'free' }]);
  const remove = (i) => setSteps(list.filter((_, idx) => idx !== i));
  const update = (i, val) => {
    const m = availableModels.find(x => modelTierKey(x) === val)
           || availableModels.find(x => x.id === val);
    const modelId = m?.id ?? val;
    const tier = m?.tier ?? 'free';
    setSteps(list.map((s, idx) => idx === i ? { label: modelId, model: modelId, tier } : s));
  };
  return (
    <div className="space-y-1.5">
      {list.map((step, i) => (
        <div key={i} className="flex items-center gap-2 group">
          <span className="text-xs text-zinc-400 w-4 text-right shrink-0">{i + 1}</span>
          <select value={step.model && step.tier ? modelTierKey({ id: step.model, tier: step.tier }) : (step.model || '')} onChange={e => update(i, e.target.value)}
            className="flex-1 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded-lg px-2.5 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500">
            <option value="">{t('gateway.route.selectModel')}</option>
            {free.length > 0 && <optgroup label={t('gateway.app.tier.freeLayer')}>{free.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}</optgroup>}
            {p2p.length  > 0 && <optgroup label={t('gateway.app.tier.p2pLayer')}>{p2p.map(m =>  <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}</optgroup>}
            {paid.length > 0 && <optgroup label={t('gateway.app.tier.paidLayer')}>{paid.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}</optgroup>}
          </select>
          <button onClick={() => remove(i)}
            className="text-xs text-zinc-400 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-1">✕</button>
        </div>
      ))}
      <button onClick={add} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{t('gateway.route.addStep')}</button>
    </div>
  );
}

function SceneRouteEditor({ route, availableModels, onSave, onCancel }) {
  const { t } = useLang();
  const [name, setName]   = useState(route.scene_name || '');
  const [icon, setIcon]   = useState(route.icon || '🔀');
  const [steps, setSteps] = useState(route.steps || []);
  const [rules, setRules] = useState(route.rules || []);
  const [clsModel, setClsModel] = useState(route.classifier?.model || '');
  const [clsCats,  setClsCats]  = useState((route.classifier?.categories || t('gateway.rule.defaultCategories').split(/[,、]/).map(s => s.trim()).filter(Boolean)).join('、'));

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
    <div className="border-t border-zinc-200/60 dark:border-zinc-800/60 bg-zinc-50/50 dark:bg-zinc-800/20 px-5 py-4 space-y-3">
      <div className="flex gap-2">
        <input value={icon} onChange={e => setIcon(e.target.value)}
          className="w-10 bg-zinc-200 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none"
          maxLength={2} />
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder={t('gateway.route.namePlaceholder')}
          className="flex-1 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded-lg px-2.5 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500" />
      </div>

      {/* 条件规则（可选）：从上到下匹配，命中即用 */}
      <div className="text-xs text-zinc-500 font-medium">
        {t('gateway.route.conditionalRules')} <span className="text-zinc-400 dark:text-zinc-500">{t('gateway.route.conditionalHint')}</span>
      </div>
      <div className="space-y-2">
        {rules.map((rule, ri) => (
          <div key={ri} className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 space-y-1.5 bg-white/60 dark:bg-zinc-900/30">
            <div className="flex items-start justify-between gap-2">
              <RuleConditionEditor when={rule.when} onChange={w => setRuleAt(ri, { when: w })} categories={categories} />
              <button onClick={() => removeRule(ri)} className="text-xs text-zinc-400 hover:text-red-500 shrink-0 px-1">{t('gateway.common.delete')}</button>
            </div>
            <div className="pl-3 border-l-2 border-zinc-200 dark:border-zinc-700">
              <div className="text-xs text-zinc-400 mb-1">{t('gateway.route.routeTo')}</div>
              <ChainEditor steps={rule.steps} setSteps={s => setRuleAt(ri, { steps: s })} availableModels={availableModels} />
            </div>
          </div>
        ))}
        <button onClick={addRule} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{t('gateway.route.addRule')}</button>
      </div>

      {/* 分类器配置（用到「智能分类」条件时显示）：先用便宜模型把输入归类，再按类别路由 */}
      {usesClassifier && (
        <div className="border border-indigo-200 dark:border-indigo-800/40 rounded-lg p-2.5 space-y-2 bg-indigo-50/40 dark:bg-indigo-900/10">
          <div className="text-xs font-medium text-indigo-600 dark:text-indigo-400">{t('gateway.route.classifier')}</div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-500 w-12 shrink-0">{t('gateway.route.clsModel')}</label>
            <select value={clsModel} onChange={e => setClsModel(e.target.value)} className={RULE_SEL + ' flex-1'}>
              <option value="">{t('gateway.route.clsModelPlaceholder')}</option>
              {availableModels.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-500 w-12 shrink-0">{t('gateway.route.clsCategories')}</label>
            <input value={clsCats} onChange={e => setClsCats(e.target.value)} placeholder={t('gateway.route.clsCategoriesPlaceholder')}
              className={RULE_SEL + ' flex-1'} />
          </div>
          <div className="text-xs text-zinc-400">{t('gateway.route.clsHint')}</div>
        </div>
      )}

      {/* 默认链（else）：规则都不命中时用 */}
      <div className="text-xs text-zinc-500 font-medium pt-1">
        {t('gateway.route.defaultChain')}{rules.length > 0 && <span className="text-zinc-400 dark:text-zinc-500">{t('gateway.route.defaultElse')}</span>}
        <span className="text-zinc-400 dark:text-zinc-500">{t('gateway.route.fallbackHint')}</span>
      </div>
      <ChainEditor steps={steps} setSteps={setSteps} availableModels={availableModels} />
      {steps.length === 0 && rules.length === 0 && <p className="text-xs text-zinc-500">{t('gateway.route.noSteps')}</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={save}
          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium transition-colors">
          {t('gateway.common.save')}
        </button>
        <button onClick={onCancel}
          className="text-xs bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors">
          {t('gateway.common.cancel')}
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
  { id: 'auto',     labelKey: 'gateway.key.autoConfig' },
];

function KeyConfigPanel({ apiKey, localBase, model, hideAuto = false }) {
  const { t } = useLang();
  const TOOLS = autoConfigTools(t);
  const [tab,     setTab]     = useState('curl');
  const [tool,    setTool]    = useState('claude-code');
  const [writeOk, setWriteOk] = useState(false);
  const tabs = hideAuto ? CONFIG_TABS.filter(tabItem => tabItem.id !== 'auto') : CONFIG_TABS;

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
      alert(t('gateway.common.writeFailed') + ': ' + e.message);
    }
  }

  const isCodeTab = tab !== 'auto';
  const code = isCodeTab ? codeSnippet(tab, localBase, apiKey, model) : '';

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-700">
        {tabs.map(tabItem => (
          <button key={tabItem.id} onClick={() => { setTab(tabItem.id); setWriteOk(false); }}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === tabItem.id
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}>
            {tabItem.labelKey ? t(tabItem.labelKey) : tabItem.label}
          </button>
        ))}
        {isCodeTab && (
          <>
            <div className="flex-1" />
            <CopyButton text={code} label={t('gateway.common.copy')} className="mx-2 py-1 text-xs" />
          </>
        )}
      </div>

      {/* Code snippet */}
      {isCodeTab && (
        <pre className="px-4 py-3 text-xs font-mono leading-relaxed text-zinc-700 dark:text-zinc-300 overflow-x-auto bg-zinc-50/30 dark:bg-zinc-900/30 whitespace-pre">
          {code}
        </pre>
      )}

      {/* Auto-configure tab */}
      {tab === 'auto' && (
        <div className="p-4 space-y-4">
          {/* Model name badge */}
          {model && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">{t('gateway.key.modelName')}</span>
              <code className={`text-xs font-mono px-2 py-0.5 rounded border ${
                isRouter
                  ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800/40 text-purple-600 dark:text-purple-400'
                  : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
              }`}>{model}</code>
              <CopyButton text={model} label={t('gateway.common.copy')} className="py-0.5 text-xs" />
            </div>
          )}
          <div className="grid grid-cols-4 gap-2">
            {TOOLS.map(t => (
              <button key={t.id} onClick={() => { setTool(t.id); setWriteOk(false); }}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-colors ${
                  tool === t.id
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 hover:border-zinc-400 dark:hover:border-zinc-600'
                }`}>
                <span className="text-xl">{t.icon}</span>
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{t.label}</span>
                <span className={`text-xs ${tool === t.id ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400'}`}>{t.hint}</span>
              </button>
            ))}
          </div>
          <div className="bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
              <span className="text-xs text-zinc-500 font-medium">{t('gateway.key.envVars')}</span>
              <CopyButton text={envText} label={t('gateway.common.copyAll')} className="py-0.5 text-xs" />
            </div>
            <pre className="px-3 py-2.5 text-xs font-mono text-zinc-700 dark:text-zinc-300 leading-relaxed">
              {envText}
            </pre>
          </div>
          {tool === 'claude-code' && window.electronAPI?.claude && (
            <button onClick={handleWrite} disabled={writeOk}
              className="w-full py-2 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-green-700 text-white">
              {writeOk ? t('gateway.key.writtenClaude') : t('gateway.key.writeClaude')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── InstanceList ──────────────────────────────────────────────────────────────

function InstanceList({ keysScene, onDelete, localBase, newKeyId, routeHealth }) {
  const { t } = useLang();
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
      setTestState(s => ({ ...s, [k.id]: { ok: false, error: e.message || t('gateway.common.connectFailed'), latency } }));
    }
    setTimeout(() => setTestState(s => ({ ...s, [k.id]: null })), 6000);
  }

  if (keysScene.length === 0) return null;
  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800">
      <div className="px-5 py-3 flex items-center justify-between">
        <span className="text-xs text-zinc-500 font-medium">{t('gateway.key.appList')}</span>
        <span className="text-xs text-zinc-400">{t('gateway.key.appCount', { n: keysScene.length })}</span>
      </div>
      <div className="max-h-96 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {sorted.map(k => {
          const ts = testState[k.id];
          const rh = k.model_key ? (routeHealth?.[k.model_key] ?? null) : null;
          const rhFt = rh?.first_token_ms ?? null;
          const rhFtLabel = rhFt != null ? t('gateway.route.firstToken', { s: (rhFt / 1000).toFixed(1) }) : null;
          // test result overrides health dot (temporary, 6s)
          const dotColor = ts && !ts.busy
            ? ts.ok ? 'bg-green-500' : 'bg-red-500'
            : rh
              ? rh.status === 'error' ? 'bg-red-500'
                : rh.status === 'ok'
                  ? (rhFt != null && rhFt > 3000 ? 'bg-amber-400' : 'bg-green-500')
                  : 'bg-zinc-400'
              : k.is_active ? 'bg-green-500' : 'bg-zinc-400';
          const dotTitle = ts && !ts.busy
            ? ts.ok
              ? t('gateway.key.testPassed', { latency: ts.latency ? t('gateway.key.testPassedLatency', { ms: ts.latency }) : '' })
              : t('gateway.key.testFailed', { error: ts.error || t('gateway.common.connectError') })
            : rh
              ? rh.status === 'error' ? t('gateway.key.routeRecentFailed')
                : rh.status === 'ok'
                  ? [rh.degraded ? t('gateway.route.degradedTo', { step: rh.activeStep }) : t('gateway.route.hitStep', { step: rh.activeStep }), rhFtLabel].filter(Boolean).join(' · ')
                  : t('gateway.key.routeNoRequests')
              : k.is_active ? t('gateway.key.appEnabled') : t('gateway.key.appDisabled');
          return (
            <div key={k.id}>
              <div
                className="flex items-center gap-3 px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/20 transition-colors cursor-pointer"
                onClick={() => setExpandedId(expandedId === k.id ? null : k.id)}
              >
                <div title={dotTitle} className={`w-1.5 h-1.5 rounded-full shrink-0 cursor-help ${dotColor}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{k.app_name || k.note || t('gateway.common.unnamed')}</span>
                    {k.scene_name && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40 shrink-0">
                        {k.icon} {k.scene_name}
                      </span>
                    )}
                  </div>
                  <code className="text-xs font-mono text-zinc-400 mt-0.5 block">{k.key?.slice(0, 20)}…</code>
                </div>

                <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                  {/* Test result badge */}
                  {ts && !ts.busy && (
                    <span className={`text-xs font-mono shrink-0 max-w-[120px] truncate ${ts.ok ? 'text-green-500 dark:text-green-400' : 'text-red-400'}`}
                      title={ts.ok ? `${ts.latency}ms` : ts.error}>
                      {ts.ok ? `✓ ${ts.latency}ms` : `✗ ${ts.error}`}
                    </span>
                  )}
                  <button
                    onClick={() => runTest(k)}
                    disabled={ts?.busy}
                    className={`text-xs px-2 py-1 rounded border transition-colors shrink-0 ${
                      ts?.busy
                        ? 'border-zinc-300 dark:border-zinc-600 text-zinc-400 opacity-60 cursor-wait'
                        : 'border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-500 dark:hover:text-blue-400'
                    }`}>
                    {ts?.busy ? t('gateway.common.testing') : t('gateway.common.test')}
                  </button>
                  <CopyButton text={k.key} label={t('gateway.common.copy')} className="text-xs py-1 px-2 min-w-0" />
                  <button onClick={() => onDelete(k.id)}
                    className="text-xs text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors">{t('gateway.common.delete')}</button>
                </div>
                <span className="text-zinc-400 text-xs shrink-0">{expandedId === k.id ? '▲' : '▼'}</span>
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

function autoConfigTools(t) {
  return [
    { id: 'claude-code', icon: '🤖', label: t('gateway.tool.claudeCode'), hint: t('gateway.tool.autoWrite') },
    { id: 'cursor',      icon: '🔮', label: t('gateway.tool.cursor'),     hint: t('gateway.tool.manualConfig') },
    { id: 'continue',    icon: '🪟', label: t('gateway.tool.continue'),   hint: t('gateway.tool.manualConfig') },
    { id: 'other',       icon: '📋', label: t('gateway.tool.other'),      hint: t('gateway.tool.generic') },
  ];
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Gateway() {
  const { t } = useLang();
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
    try {
      setAvailableModels(await loadGatewayAvailableModels());
    } catch (e) {
      console.error('loadAvailableModels', e);
    }
  }, []);

  useEffect(() => {
    refresh();
    loadSceneData();
    loadAvailableModels();
    const id = setInterval(() => {
      refresh();
      loadAvailableModels();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh, loadSceneData, loadAvailableModels]);

  // ── Computed stats ──────────────────────────────────────────────────────────

  const totalCalls   = stats?.total_calls ?? 0;
  const totalTokens  = stats?.total_tokens ?? 0;
  const totalCost    = stats?.total_cost ?? 0;
  const proxyCalls   = (stats?.agent_sources ?? []).find(s => s.source === 'proxy')?.calls ?? 0;
  const gatewayRatio = totalCalls > 0 ? Math.round((proxyCalls / totalCalls) * 100) : null;
  const fmtTokens    = n => n >= 1_000_000 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0);
  const fmtCost      = n => n > 0 ? '$' + n.toFixed(n < 0.01 ? 4 : 3) : '—';
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
      alert(t('gateway.common.saveFailed', { msg: e.message }));
    }
  };

  const removeRoute = async (id) => {
    if (!confirm(t('gateway.route.confirmDelete'))) return;
    try { await getLocalConfig().deleteSceneRoute(id); await loadSceneData(); }
    catch (e) { alert(t('gateway.common.deleteFailed')); }
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
      alert(t('gateway.common.createFailed', { msg: e.message }));
    } finally {
      setAppBusy(false);
    }
  }

  async function handleDeleteKey(keyId) {
    if (!confirm(t('gateway.route.confirmDeleteKey'))) return;
    try { await getLocalConfig().deleteKey(keyId); await loadSceneData(); }
    catch (e) { alert(t('gateway.common.deleteFailed')); }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="px-5 py-5 space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status?.running ? 'bg-green-400' : 'bg-zinc-400'}`} />
          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${status?.running ? 'bg-green-500' : 'bg-zinc-400'}`} />
        </span>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('gateway.title')}</h1>
        {status && (
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            status.running
              ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 border-green-300 dark:border-green-800/50'
              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border-zinc-300 dark:border-zinc-700'
          }`}>
            {status.running ? t('gateway.running', { port: status.port }) : t('gateway.stopped')}
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
          title={t('gateway.restartTitle')}
          className="ml-auto flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"
            className={`w-3.5 h-3.5 ${restarting ? 'animate-spin' : ''}`}>
            <path fillRule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08 1.01.75.75 0 1 1-1.3-.75 6 6 0 0 1 9.44-1.344l.842.841V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.344l-.84-.841v1.371a.75.75 0 0 1-1.5 0V9.691a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-1.01.75.75 0 0 1 1.025-.295Z" clipRule="evenodd" />
          </svg>
          {restarting ? t('gateway.restarting') : t('gateway.restart')}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-2.5">
        {[
          { label: t('gateway.stat.todayCalls'), value: totalCalls > 0 ? totalCalls.toLocaleString() : '—', color: 'text-zinc-900 dark:text-zinc-100' },
          { label: t('gateway.stat.todayTokens'), value: fmtTokens(totalTokens), color: 'text-blue-600 dark:text-blue-400' },
          { label: t('gateway.stat.gatewayRatio'), value: gatewayRatio !== null ? `${gatewayRatio}%` : '—', color: 'text-violet-600 dark:text-violet-400' },
          { label: t('gateway.stat.avgLatency'), value: avgLatency > 0 ? `${avgLatency}ms` : '—', color: 'text-zinc-500 dark:text-zinc-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800/80 rounded-xl px-4 py-3.5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1.5">{label}</div>
            <div className={`text-[22px] font-bold leading-none tabular-nums tracking-tight ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* 应用列表 / 场景路由 Tab */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800/80 rounded-2xl overflow-hidden shadow-sm">
        {/* Tab bar + Endpoint 合并一行 */}
        <div className="flex items-center border-b border-zinc-100 dark:border-zinc-800">
          {[t('gateway.tab.apps'), t('gateway.tab.routes')].map((tabLabel, i) => (
            <button key={i} onClick={() => setMainTab(i)}
              className={`px-4 py-2.5 text-xs font-semibold transition-colors ${mainTab === i
                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-500'
                : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'}`}>
              {tabLabel}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 px-3">
            <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">{localBase}</span>
            <CopyButton text={localBase} label={t('gateway.common.copy')} />
          </div>
        </div>

        {/* Tab0: 应用列表 & 托管 */}
        {mainTab === 0 && (
          <AppManager externalRoutes={routes} availableModels={availableModels} />
        )}

        {/* Tab1: 场景路由 */}
        {mainTab === 1 && (
        <div>
        {/* 操作栏：新建（蓝色，最左）｜说明｜在线同步（最右）——布局与应用列表一致 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex-wrap">
          <button
            onClick={() => { if (newRoute) { setNewRoute(null); } else { setExpandedRoute(null); setNewRoute({ scene_name: '', icon: '🔀', steps: [] }); } }}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
          >{t('gateway.route.new')}</button>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('gateway.route.hint')}</span>
          <div className="ml-auto">
            <ImportConfigButton onImported={() => { refresh(); loadSceneData(); loadAvailableModels(); }} endpoint="/api/config/scenes" />
          </div>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
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
                : 'bg-zinc-300 dark:bg-zinc-600';
            const ftLabel = ftMs != null ? t('gateway.route.firstToken', { s: (ftMs / 1000).toFixed(1) }) : null;
            const healthTitle =
              routeMissing ? t('gateway.route.missingModels') :
              health.status === 'error' ? t('gateway.route.recentFailed') :
              health.status === 'ok'
                ? [health.degraded ? t('gateway.route.degradedShort') : t('gateway.route.runningOk'), ftLabel].filter(Boolean).join(' · ')
                : t('gateway.route.noRequests');
            return (
            <div key={route.id}>
              <div
                className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors"
                onClick={() => setExpandedRoute(expandedRoute === route.id ? null : route.id)}
              >
                <span className="text-base shrink-0">{route.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span title={healthTitle} className={`w-2 h-2 rounded-full shrink-0 ${healthDot}`} />
                    <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{route.scene_name}</span>
                    {route.model_key && (
                      <>
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 shrink-0">
                          {route.model_key}
                        </span>
                        <span onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(route.model_key); }}
                          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer transition-colors shrink-0">{t('gateway.common.copy')}</span>
                      </>
                    )}
                    {health.degraded && (
                      <span className="text-xs px-1 py-0.5 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/40 text-rose-600 dark:text-rose-400 shrink-0">
                        {t('gateway.route.degraded')}
                      </span>
                    )}
                    {route.rules?.length > 0 && (
                      <span title={t('gateway.route.rulesTitle')} className="text-xs px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 text-indigo-600 dark:text-indigo-400 shrink-0">
                        {t('gateway.route.rulesCount', { n: route.rules.length })}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {(() => {
                      const steps = route.steps || [];
                      return (<>
                        {steps.map((step, i) => {
                          const stepTier = resolveStepTier(step.model || step.label, step, availableModels);
                          const stepName = step.model || step.label;
                          const isActive = health.activeStep === stepName;
                          const isFailed = health.triedSteps?.includes(stepName);
                          const missing = !availSet.has(stepName);
                          return (
                            <React.Fragment key={i}>
                              {i > 0 && <span className="text-zinc-300 dark:text-zinc-600 text-xs">→</span>}
                              <span title={missing ? t('gateway.route.missingModelTitle') : undefined}
                                className={`inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-md border transition-all ${
                                  isActive
                                    ? 'bg-green-100 dark:bg-green-900/40 border-green-400 dark:border-green-600 text-green-800 dark:text-green-200'
                                    : missing
                                      ? 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700 text-red-600 dark:text-red-300'
                                      : tierStyle(stepTier)
                                }`}>
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  isActive ? 'bg-green-500' : (missing || isFailed) ? 'bg-red-500' : tierDot(stepTier)
                                }`} />
                                {step.label || step.model}
                                <span className="opacity-40">({TIER_SHORT[stepTier] || stepTier})</span>
                              </span>
                            </React.Fragment>
                          );
                        })}
                        {!steps.length && <span className="text-xs text-zinc-400">{t('gateway.route.noStepsShort')}</span>}
                        {routeMissing && (
                          <span className="text-xs text-red-500 dark:text-red-400 ml-1 shrink-0">{t('gateway.route.missingModelsWarn')}</span>
                        )}
                      </>);
                    })()}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                  <button onClick={() => setExpandedRoute(expandedRoute === route.id ? null : route.id)}
                    className="text-xs px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                    {expandedRoute === route.id ? t('gateway.common.collapse') : t('gateway.common.edit')}
                  </button>
                  <button onClick={() => removeRoute(route.id)}
                    className="text-xs px-2 py-1 rounded-md border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                    {t('gateway.common.delete')}
                  </button>
                </div>
              </div>
              {expandedRoute === route.id && (
                <SceneRouteEditor key={'editor-' + route.id} route={route} availableModels={availableModels} onSave={saveRoute} onCancel={() => setExpandedRoute(null)} />
              )}
            </div>
            );
          })}
          {routes.length === 0 && !newRoute && (
            <div className="px-5 py-8 text-xs text-zinc-400 text-center">{t('gateway.route.empty')}</div>
          )}
        </div>
        </div>
        )}
      </div>

      {/* 路由明细 — 仅在「场景路由」Tab 显示，应用列表 Tab 不显示 */}
      {mainTab === 1 && (
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-3">{t('gateway.log.title')}</h2>
        {logEntries.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {t('gateway.log.empty')}{' '}
            <code className="font-mono text-green-600 dark:text-green-400">{localBase}</code>{t('gateway.log.emptySuffix')}
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1.5 pr-1">
            {logEntries.map((e, i) => {
              const isRouter = e.requested_model?.startsWith('llm-router-');
              return (
                <div key={`${e.ts}-${e.via}-${i}`}
                  className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/60">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                  <span className="font-mono text-zinc-400 shrink-0 w-12">
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
                        <span title={t('gateway.log.claudeMap')} className="font-mono text-xs px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 text-indigo-600 dark:text-indigo-400 shrink-0">
                          🎭 {e.claude_from}
                        </span>
                        <span className="text-zinc-300 dark:text-zinc-600">→</span>
                      </>
                    )}
                    {/* Failed models in degradation chain */}
                    {e.tried?.map((m, j) => (
                      <React.Fragment key={j}>
                        {(isRouter || j > 0) && <span className="text-zinc-300 dark:text-zinc-600">→</span>}
                        <span className="font-mono text-red-400 line-through opacity-60 shrink-0">{m}</span>
                      </React.Fragment>
                    ))}
                    {/* Actual model used */}
                    {(isRouter || e.tried?.length > 0) && <span className="text-zinc-300 dark:text-zinc-600">→</span>}
                    <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate">
                      {e.model || '—'}
                      {e.tier && (
                        <span className={`ml-0.5 text-xs not-italic ${
                          e.tier === 'p2p'  ? 'text-blue-500 dark:text-blue-400' :
                          e.tier === 'paid' ? 'text-amber-500 dark:text-amber-400' :
                                              'text-green-600 dark:text-green-500'
                        }`}>({e.tier})</span>
                      )}
                      {!e.claude_from && !isRouter && (
                        <span title={t('gateway.log.directTitle')} className="ml-1 text-xs text-zinc-400">{t('gateway.log.direct')}</span>
                      )}
                    </span>
                  </div>

                  <span className="text-zinc-400 shrink-0">→</span>
                  <span className={`shrink-0 font-medium ${e.status === 'ok' ? 'text-blue-600 dark:text-blue-400' : 'text-red-500'}`}>
                    {e.status === 'ok' ? (e.via_label || e.via || '—') : t('gateway.log.failed')}
                  </span>
                  <span className="text-zinc-400 shrink-0">{e.latency_ms}ms</span>
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
