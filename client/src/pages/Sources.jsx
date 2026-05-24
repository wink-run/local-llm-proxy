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
  { tier: 'shared', title: '分享层',       subtitle: 'P2P 算力（板块③ 接通后启用）' },
];

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
    shared: [],
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">供给源</h1>
        <p className="text-xs text-gray-500 mt-1">启用供给源后，网关可按场景路由请求</p>
      </header>

      {SECTIONS.map((sec) => {
        const items = sectionEntries[sec.tier];
        if (sec.tier === 'shared') return null;  // 暂隐
        if (sec.tier === 'bonus' && items.length === 0) return null;  // 没福利就不显示
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
