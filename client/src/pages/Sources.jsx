/**
 * Sources（供给源）—— v2.1 redesign。
 *
 * 设计：单列大卡片，左侧 icon + 名称 + 状态徽章 + 描述，右侧 toggle 开关；
 *   未配置的展开内联引导 wizard（如 GitHub Models 的 3 步）。
 *
 * 状态：
 *   - 已连接（auth.type = 'none' 且已添加，比如 Ollama）
 *   - 已启用（有 key 且 enabled = true）
 *   - 配置中（用户正在填 wizard 还没完成）
 *   - 未启用（catalog 里有但 user 没添加）
 */
import React, { useEffect, useState } from 'react';

const LOCAL_GATEWAY_URL =
  typeof window !== 'undefined' && window.localStorage?.getItem('llp.gatewayUrl')
    ? window.localStorage.getItem('llp.gatewayUrl')
    : 'http://127.0.0.1:11435';

async function api(path, opts = {}) {
  const res = await fetch(LOCAL_GATEWAY_URL + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// ── icons ──────────────────────────────────────────────────────────────

const ICON_BY_ID = {
  ollama:             { emoji: '🦙', bg: 'bg-gray-100 dark:bg-gray-800', tone: 'text-gray-700 dark:text-gray-200' },
  groq:               { emoji: '⚡', bg: 'bg-orange-100 dark:bg-orange-900/30', tone: 'text-orange-700 dark:text-orange-300' },
  cerebras:           { emoji: '🌀', bg: 'bg-rose-100 dark:bg-rose-900/30', tone: 'text-rose-700 dark:text-rose-300' },
  'gemini-ai-studio': { emoji: '✨', bg: 'bg-blue-100 dark:bg-blue-900/30', tone: 'text-blue-700 dark:text-blue-300' },
  'gemini-native':    { emoji: '✨', bg: 'bg-red-100 dark:bg-red-900/30', tone: 'text-red-700 dark:text-red-300' },
  'openrouter-free':  { emoji: '🛣', bg: 'bg-cyan-100 dark:bg-cyan-900/30', tone: 'text-cyan-700 dark:text-cyan-300' },
  'github-models':    { emoji: '🐙', bg: 'bg-slate-100 dark:bg-slate-800', tone: 'text-slate-700 dark:text-slate-200' },
  siliconflow:        { emoji: '🧪', bg: 'bg-emerald-100 dark:bg-emerald-900/30', tone: 'text-emerald-700 dark:text-emerald-300' },
  'nvidia-nim':       { emoji: '🟢', bg: 'bg-green-100 dark:bg-green-900/30', tone: 'text-green-700 dark:text-green-300' },
  sambanova:          { emoji: '🟪', bg: 'bg-violet-100 dark:bg-violet-900/30', tone: 'text-violet-700 dark:text-violet-300' },
  cohere:             { emoji: '🐬', bg: 'bg-sky-100 dark:bg-sky-900/30', tone: 'text-sky-700 dark:text-sky-300' },
  'cloudflare-workers-ai': { emoji: '☁', bg: 'bg-amber-100 dark:bg-amber-900/30', tone: 'text-amber-700 dark:text-amber-300' },
  mistral:            { emoji: '🌪', bg: 'bg-yellow-100 dark:bg-yellow-900/30', tone: 'text-yellow-700 dark:text-yellow-300' },
};

function statusBadge(status) {
  const map = {
    connected: { label: '已连接', cls: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' },
    enabled:   { label: '已启用', cls: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' },
    configuring: { label: '配置中', cls: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' },
    inactive:  { label: '未启用', cls: 'bg-gray-100 dark:bg-gray-800 text-gray-500' },
    cooldown:  { label: '配额耗尽', cls: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  };
  const m = map[status] || map.inactive;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

function formatCooldown(seconds) {
  if (seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.ceil(seconds / 3600)} h`;
}

function protocolBadge(protocol) {
  const map = {
    openai:        { label: 'openai 兼容',    cls: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' },
    anthropic:     { label: 'anthropic 原生', cls: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' },
    gemini_native: { label: 'gemini 原生',    cls: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  };
  const m = map[protocol || 'openai'] || map.openai;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

// ── Toggle ─────────────────────────────────────────────────────────────

function Toggle({ on, disabled, onChange }) {
  return (
    <button onClick={() => !disabled && onChange?.(!on)} disabled={disabled}
            className={`relative inline-flex h-6 w-10 items-center rounded-full transition-colors ${disabled ? 'opacity-30 cursor-not-allowed' : ''} ${on ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

// ── ProviderCard ───────────────────────────────────────────────────────

function ProviderCard({ entry, installed, onChanged }) {
  const installedRow = installed.find((p) => p.provider_id === entry.id);
  const isPublic = (entry.auth?.type || 'bearer') === 'none';
  const enabled = !!(installedRow && installedRow.enabled);
  const cooldownLeft = installedRow?.cooldown_remaining_sec || 0;
  const inCooldown = cooldownLeft > 0;

  // 状态判定
  let status = 'inactive';
  if (inCooldown)                                                 status = 'cooldown';
  else if (installedRow && installedRow.enabled && installedRow.key_present) status = isPublic ? 'connected' : 'enabled';
  else if (installedRow && !installedRow.enabled)                  status = 'inactive';

  const [wizardOpen, setWizardOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // 配置中状态
  if (wizardOpen) status = 'configuring';

  const icon = ICON_BY_ID[entry.id] || { emoji: '📡', bg: 'bg-gray-100 dark:bg-gray-800', tone: 'text-gray-700' };

  const toggleEnabled = async (target) => {
    if (target) {
      // 启用：如果 isPublic 直接 add；否则展开 wizard
      if (isPublic) {
        await api('/__local__/providers/from-catalog', {
          method: 'POST',
          body: JSON.stringify({ provider_id: entry.id, api_key: '' }),
        });
        onChanged?.();
      } else if (installedRow) {
        // 已添加，仅 toggle enable
        // 当前后端没有独立的 enable/disable，先用 add/delete 简化
        onChanged?.();
      } else {
        setWizardOpen(true);
      }
    } else {
      // 关闭：删除该 provider 实例
      if (installedRow) {
        if (!confirm(`关闭并移除 ${entry.display}？已存储的 API key 将一并删除。`)) return;
        await api(`/__local__/providers/${installedRow.id}`, { method: 'DELETE' });
        onChanged?.();
      }
    }
  };

  const handleTest = async () => {
    setBusy(true); setTestResult(null);
    const { body } = await api('/__local__/test-connection', {
      method: 'POST',
      body: JSON.stringify({ provider_id: entry.id, api_key: apiKey }),
    });
    setTestResult(body);
    setBusy(false);
  };

  const handleEnable = async () => {
    if (entry.requires_account_id && !accountId.trim()) {
      setTestResult({ ok: false, error: 'account_id 是必填项' });
      return;
    }
    setBusy(true);
    const payload = { provider_id: entry.id, api_key: apiKey };
    if (entry.requires_account_id) payload.account_id = accountId.trim();
    const { ok, body } = await api('/__local__/providers/from-catalog', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (ok) {
      setApiKey(''); setAccountId(''); setTestResult(null); setWizardOpen(false);
      onChanged?.();
    } else {
      setTestResult({ ok: false, error: body?.detail || JSON.stringify(body) });
    }
  };

  const clearCooldown = async () => {
    if (!installedRow) return;
    await api(`/__local__/providers/${installedRow.id}/clear-cooldown`, { method: 'POST' });
    onChanged?.();
  };

  const steps = entry.setup_steps || (isPublic ? [] : [
    { id: 'key',  label: `获取 ${entry.display} API Key`, action: 'open_url', url: entry.signup_url },
    { id: 'test', label: '验证并启用',                       action: 'test_and_enable' },
  ]);

  return (
    <div className={`border rounded-lg bg-white dark:bg-gray-900 transition ${wizardOpen ? 'border-blue-300 dark:border-blue-700' : 'border-gray-200 dark:border-gray-800'}`}>
      {/* 上半：icon + 名称 + 状态 + toggle */}
      <div className="p-4 flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0 ${icon.bg} ${icon.tone}`}>{icon.emoji}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm">{entry.display}</h3>
            {statusBadge(status)}
            {protocolBadge(entry.protocol)}
          </div>
          {(entry.protocol === 'anthropic' || entry.protocol === 'gemini_native') && (
            <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
              ℹ 客户端用 OpenAI Chat 调用时，网关自动转 {entry.protocol === 'anthropic' ? 'Anthropic Messages' : 'Gemini Native'} 格式
            </p>
          )}
          {entry.new_user_bonus && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
              🎁 {entry.bonus_value || '新用户福利'}
            </p>
          )}
          {installedRow && installedRow.key_present && !isPublic && !wizardOpen ? (
            <div className="flex items-center gap-1.5 mt-0.5 text-xs">
              <code className="font-mono text-gray-500">{installedRow.key_masked || '••••••'}</code>
              <button onClick={() => setWizardOpen(true)} className="text-blue-600 dark:text-blue-400 hover:underline">修改</button>
            </div>
          ) : (
            <p className="text-xs text-gray-500 mt-0.5">{entry.quota_hint}</p>
          )}
        </div>
        {!installedRow && !isPublic ? (
          <button onClick={() => setWizardOpen(true)} className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700">
            立即启用
          </button>
        ) : (
          <Toggle on={enabled} onChange={toggleEnabled} />
        )}
      </div>

      {/* Cooldown 红条 */}
      {inCooldown && (
        <div className="px-4 pb-3 -mt-1">
          <div className="flex items-center justify-between text-xs px-3 py-1.5 rounded bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300">
            <span>⏳ Cooling down · 剩余 {formatCooldown(cooldownLeft)} · 已触发 {installedRow.cooldown_count_429 || 1} 次 429</span>
            <button onClick={clearCooldown} className="text-[11px] underline hover:text-red-900 dark:hover:text-red-100">手动清除</button>
          </div>
        </div>
      )}

      {/* 下半：内联 wizard */}
      {wizardOpen && (
        <div className="border-t border-gray-100 dark:border-gray-800 p-4 bg-gray-50 dark:bg-gray-950">
          {entry.notes && <p className="text-xs text-gray-600 mb-3">{entry.notes}</p>}
          <ol className="space-y-3">
            {steps.map((step, i) => {
              const isCurrent = i === stepIdx;
              const isDone = i < stepIdx;
              return (
                <li key={step.id} className="flex items-start gap-3">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${isDone ? 'bg-green-500 text-white' : isCurrent ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'}`}>
                    {isDone ? '✓' : i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${isCurrent ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500'}`}>{step.label}</p>
                    {isCurrent && step.action === 'open_url' && (
                      <div className="mt-2">
                        <button onClick={() => { window.open(step.url || entry.signup_url, '_blank'); setStepIdx(i + 1); }}
                                className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-white dark:hover:bg-gray-800">
                          ↗ 打开 {step.id === 'key' ? '注册' : 'GitHub Token'} 页面
                        </button>
                      </div>
                    )}
                    {isCurrent && step.action === 'test_and_enable' && (
                      <div className="mt-2 space-y-2">
                        {entry.requires_account_id && (
                          <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Account ID（必填，dash.cloudflare.com 右下角）</label>
                            <input type="text" value={accountId} onChange={(e) => setAccountId(e.target.value)}
                                   placeholder="32 位 hex，例如 ab12cd34..."
                                   className="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm font-mono" />
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <input type={showKey ? 'text' : 'password'} value={apiKey}
                                 onChange={(e) => setApiKey(e.target.value)}
                                 placeholder={entry.id === 'github-models' ? 'github_pat_...' : 'sk-...'}
                                 className="flex-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm font-mono" />
                          <button onClick={() => setShowKey((s) => !s)} className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700">
                            {showKey ? '隐藏' : '显示'}
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={handleTest} disabled={busy || !apiKey} className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-white dark:hover:bg-gray-800 disabled:opacity-40">
                            {busy && !testResult ? '测试中…' : '测试'}
                          </button>
                          <button onClick={handleEnable} disabled={busy || !apiKey} className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
                            {busy ? '处理中…' : '测试并启用'}
                          </button>
                          <button onClick={() => setWizardOpen(false)} className="text-xs px-2 py-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">取消</button>
                        </div>
                        {testResult && (
                          <div className={`text-xs rounded px-3 py-2 ${testResult.ok ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300' : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'}`}>
                            {testResult.ok ? <>✓ 连接成功 · {testResult.via} · {testResult.latency_ms}ms</> : <>✗ {testResult.status ? `HTTP ${testResult.status} · ` : ''}{(testResult.error || '').slice(0, 200)}</>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

// ── 主页 ───────────────────────────────────────────────────────────────

const SECTIONS = [
  { tier: 'bonus', title: '🎁 新用户福利', subtitle: '注册即送 / 限时免费配额；用完再换其它 free 源' },
  { tier: 'free',  title: '免费层',        subtitle: '不消耗额度，优先选择' },
  { tier: 'paid',  title: '订阅 / 付费层', subtitle: '自有 API key 余额（按 token 计费）' },
  { tier: 'shared', title: '🤝 P2P 共享池', subtitle: 'Token Bank 共享网络：可消费别人贡献的 / 也可贡献自己的' },
];

// ── SharedPoolSection ─────────────────────────────────────────────────

function SharedPoolSection() {
  const [data, setData] = useState(null);
  const [showConnect, setShowConnect] = useState(false);
  const [vpsUrl, setVpsUrl] = useState('http://81.70.249.144:8000');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    (async () => {
      const r = await api('/__local__/share-pool');
      if (r.ok) setData(r.body);
    })();
  }, [refresh]);

  const handleConnect = async () => {
    if (!vpsUrl || !apiKey) return;
    setBusy(true); setError(null);
    const { ok, body } = await api('/__local__/share-pool/connect', {
      method: 'POST',
      body: JSON.stringify({ vps_url: vpsUrl, api_key: apiKey }),
    });
    setBusy(false);
    if (ok) {
      setShowConnect(false); setApiKey('');
      setRefresh((k) => k + 1);
    } else {
      setError(body?.detail || JSON.stringify(body));
    }
  };

  const handleDisconnect = async (id) => {
    if (!confirm('断开 P2P 共享池连接？已存的 API key 会一并删除。')) return;
    await api(`/__local__/share-pool/disconnect/${id}`, { method: 'POST' });
    setRefresh((k) => k + 1);
  };

  const handleRefresh = async () => {
    await api('/__local__/share-pool/refresh', { method: 'POST' });
    setRefresh((k) => k + 1);
  };

  if (!data) return <p className="text-xs text-gray-400">加载中…</p>;

  const connected = data.connected || [];

  return (
    <div className="space-y-3">
      {/* 顶部说明 banner */}
      <div className="border border-purple-200 dark:border-purple-900 bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 text-xs text-purple-900 dark:text-purple-200">
        <p className="font-semibold">P2P 共享池 = 旧 DESIGN.md 的板块③ 接通到新架构</p>
        <p className="mt-1 opacity-90">
          消费者：填 VPS URL + sk-* 用户 key 即可路由到分享池<br />
          贡献者：去 <a href="#" onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', '/agent'); window.dispatchEvent(new Event('popstate')); }} className="underline text-purple-600 dark:text-purple-300">⚙ Agent 页</a> 配 worker_key 启动，把本地 Ollama 暴露给社区
        </p>
      </div>

      {/* 已连接的 VPS 们 */}
      {connected.map((conn) => (
        <div key={conn.id} className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
          <div className="flex items-start gap-3">
            <div className="text-2xl">🤝</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-sm">{conn.display_name}</h3>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${conn.online ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'}`}>
                  {conn.online ? '✓ 在线' : '✗ 离线'}
                </span>
                <code className="text-[10px] text-gray-500 font-mono">{conn.vps_url}</code>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div className="bg-gray-50 dark:bg-gray-950 rounded p-2">
                  <p className="text-gray-500 text-[10px]">在线 Worker</p>
                  <p className="text-lg font-semibold">{conn.summary?.online_workers || 0}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-950 rounded p-2">
                  <p className="text-gray-500 text-[10px]">活跃用户</p>
                  <p className="text-lg font-semibold">{conn.summary?.active_users || 0}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-950 rounded p-2">
                  <p className="text-gray-500 text-[10px]">可用模型</p>
                  <p className="text-lg font-semibold">{(conn.models || []).length}</p>
                </div>
              </div>
              {/* 在线 worker 卡片 */}
              {(conn.workers || []).length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-gray-500 cursor-pointer select-none">展开 {conn.workers.length} 个在线节点</summary>
                  <div className="mt-2 space-y-1">
                    {conn.workers.slice(0, 10).map((w) => (
                      <div key={w.worker_id} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-gray-50 dark:bg-gray-950">
                        <span>{'★'.repeat(w.stars || 1)} <span className="text-gray-700 dark:text-gray-300">{w.name}</span></span>
                        <span className="text-gray-500 font-mono text-[10px]">{(w.models || []).join(', ')}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <button onClick={handleRefresh} className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">刷新</button>
              <button onClick={() => handleDisconnect(conn.id)} className="text-xs px-2 py-1 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">断开</button>
            </div>
          </div>
        </div>
      ))}

      {/* 连接表单 / 入口 */}
      {!showConnect ? (
        <button onClick={() => setShowConnect(true)} className="w-full text-sm py-3 rounded border border-dashed border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20">
          + 连接到 {connected.length > 0 ? '另一个' : ''} P2P 共享池
        </button>
      ) : (
        <div className="border border-purple-200 dark:border-purple-900 rounded-lg bg-white dark:bg-gray-900 p-4 space-y-3">
          <h3 className="font-semibold text-sm">连接到 Token Bank VPS</h3>
          <div>
            <label className="text-xs text-gray-500">VPS URL</label>
            <input value={vpsUrl} onChange={(e) => setVpsUrl(e.target.value)} placeholder="http://81.70.249.144:8000"
                   className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm font-mono" />
            <p className="text-[10px] text-gray-400 mt-0.5">默认 demo VPS；可换自己部署的</p>
          </div>
          <div>
            <label className="text-xs text-gray-500">用户 API Key（sk-...）</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..."
                   className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm font-mono" />
            <p className="text-[10px] text-gray-400 mt-0.5">
              没有？在 <a href={`${vpsUrl}/app`} target="_blank" rel="noreferrer" className="underline text-blue-600">{vpsUrl}/app</a> 注册并在「我的 API Keys」创建
            </p>
          </div>
          {error && (
            <div className="text-xs bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded px-3 py-2">✗ {error}</div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowConnect(false); setError(null); }} className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700">取消</button>
            <button onClick={handleConnect} disabled={busy || !vpsUrl || !apiKey} className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white disabled:opacity-40">
              {busy ? '验证中…' : '验证并启用'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Sources() {
  const [freeCatalog, setFreeCatalog] = useState([]);
  const [paidCatalog, setPaidCatalog] = useState([]);
  const [installed, setInstalled] = useState([]);
  const [health, setHealth] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const h = await api('/__local__/health');
      if (!h.ok) { setHealth(false); return; }
      setHealth(h.body);
      const [f, p, i] = await Promise.all([
        api('/__local__/free-catalog'),
        api('/__local__/paid-catalog'),
        api('/__local__/providers'),
      ]);
      if (f.ok) setFreeCatalog(f.body.providers || []);
      if (p.ok) setPaidCatalog(p.body.providers || []);
      if (i.ok) setInstalled(i.body.providers || []);
    })();
  }, [refreshKey]);

  if (health === false) {
    return <div className="p-8 max-w-2xl mx-auto text-sm">本地网关未启动</div>;
  }

  // 提取 bonus 类（free + paid 中含 new_user_bonus 的）到独立 section，但仍在原 section 显示
  const bonusEntries = [
    ...freeCatalog.filter((p) => p.new_user_bonus),
    ...paidCatalog.filter((p) => p.new_user_bonus && !p.requires_p1),
  ];
  const sectionEntries = {
    bonus:  bonusEntries,
    free:   freeCatalog,
    paid:   paidCatalog.filter((p) => !p.requires_p1),
    shared: [],  // 分享层走 SharedPoolSection 独立组件渲染
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">供给源</h1>
        <p className="text-xs text-gray-500 mt-1">启用供给源后，网关可按场景路由请求</p>
      </header>

      {SECTIONS.map((sec) => {
        const items = sectionEntries[sec.tier];
        if (sec.tier === 'bonus' && items.length === 0) return null;  // 没福利就不显示
        if (sec.tier === 'shared') {
          return (
            <section key={sec.tier} className="mb-6">
              <div className="flex items-baseline gap-2 mb-3">
                <span className="w-2 h-2 rounded-full bg-purple-500"></span>
                <h2 className="font-semibold text-sm">{sec.title}</h2>
                <span className="text-xs text-gray-500">— {sec.subtitle}</span>
              </div>
              <SharedPoolSection />
            </section>
          );
        }
        return (
          <section key={sec.tier} className="mb-6">
            <div className="flex items-baseline gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              <h2 className="font-semibold text-sm">{sec.title}</h2>
              <span className="text-xs text-gray-500">— {sec.subtitle}</span>
            </div>
            <div className="space-y-2.5">
              {items.length === 0 ? (
                <p className="text-xs text-gray-400 italic">暂无条目</p>
              ) : items.map((entry) => (
                <ProviderCard key={entry.id} entry={entry} installed={installed} onChanged={() => setRefreshKey((k) => k + 1)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
