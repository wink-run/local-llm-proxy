/**
 * 网关 Tab 3 · 💳 订阅与余额
 *
 * 预警 banner + 订阅卡片列表 + 新建/编辑 modal
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
  try { return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null }; }
  catch { return { ok: res.ok, status: res.status, body: text }; }
}

const PROVIDER_PRESETS = [
  { provider_id: 'anthropic-official', display_name: 'Anthropic 官方 (Claude)', icon: '🟠' },
  { provider_id: 'openai-official',    display_name: 'OpenAI 官方',              icon: '🟢' },
  { provider_id: 'deepseek-official',  display_name: 'DeepSeek 官方',            icon: '🔵' },
  { provider_id: 'zhipu-glm',          display_name: '智谱 GLM',                 icon: '🔵' },
  { provider_id: 'moonshot-kimi',      display_name: '月之暗面 Kimi',            icon: '🟣' },
  { provider_id: 'xai-grok',           display_name: 'xAI Grok',                 icon: '⚫' },
  { provider_id: 'siliconflow',        display_name: 'SiliconFlow',              icon: '🟢' },
  { provider_id: 'openrouter-paid',    display_name: 'OpenRouter',               icon: '🔷' },
];

const PLAN_KINDS = [
  { value: 'plan', label: '订阅 Plan（每月固定费用 / 配额）' },
  { value: 'payg', label: 'Pay-as-you-go（按用量计费 / 充值余额）' },
  { value: 'prepaid', label: '预付充值（额度用完为止）' },
];

// ── SubscriptionForm Modal ─────────────────────────────────────────────

function SubForm({ initial, onSubmit, onClose }) {
  const isEdit = !!initial?.id;
  const preset = PROVIDER_PRESETS.find((p) => p.provider_id === initial?.provider_id);
  const [form, setForm] = useState({
    provider_id:       initial?.provider_id || PROVIDER_PRESETS[0].provider_id,
    display_name:      initial?.display_name || preset?.display_name || '',
    plan_kind:         initial?.plan_kind || 'payg',
    plan_name:         initial?.plan_name || '',
    monthly_cost:      initial?.monthly_cost || 0,
    quota_total:       initial?.quota_total || 0,
    balance_remaining: initial?.balance_remaining ?? '',
    renews_at:         initial?.renews_at || '',
    auto_renew:        initial?.auto_renew || false,
    alert_balance_pct: initial?.alert_balance_pct || 20,
    alert_days_before: initial?.alert_days_before || 1,
    alert_enabled:     initial?.alert_enabled !== 0 && initial?.alert_enabled !== false,
    notes:             initial?.notes || '',
  });

  const updateField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    const payload = { ...form };
    if (payload.balance_remaining === '') payload.balance_remaining = null;
    else payload.balance_remaining = parseFloat(payload.balance_remaining);
    payload.monthly_cost = parseFloat(payload.monthly_cost) || 0;
    payload.quota_total = parseFloat(payload.quota_total) || 0;
    payload.alert_balance_pct = parseFloat(payload.alert_balance_pct) || 0;
    payload.alert_days_before = parseInt(payload.alert_days_before) || 0;
    if (!payload.renews_at) delete payload.renews_at;
    await onSubmit(payload);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-lg max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900">
          <h2 className="text-lg font-semibold">{isEdit ? '编辑订阅' : '添加订阅'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-gray-500">Provider</label>
            <select value={form.provider_id} onChange={(e) => {
              const pid = e.target.value;
              const p = PROVIDER_PRESETS.find((x) => x.provider_id === pid);
              updateField('provider_id', pid);
              if (p && !form.display_name) updateField('display_name', p.display_name);
            }} disabled={isEdit}
                    className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-60">
              {PROVIDER_PRESETS.map((p) => <option key={p.provider_id} value={p.provider_id}>{p.icon} {p.display_name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">显示名（可自定义）</label>
            <input value={form.display_name} onChange={(e) => updateField('display_name', e.target.value)}
                   className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">计费类型</label>
            <select value={form.plan_kind} onChange={(e) => updateField('plan_kind', e.target.value)}
                    className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm">
              {PLAN_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
          {form.plan_kind === 'plan' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500">Plan 名</label>
                <input value={form.plan_name} onChange={(e) => updateField('plan_name', e.target.value)} placeholder="Pro / Team"
                       className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500">月费</label>
                <input type="number" value={form.monthly_cost} onChange={(e) => updateField('monthly_cost', e.target.value)}
                       className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500">{form.plan_kind === 'plan' ? '月配额（数值）' : '充值总额'}</label>
              <input type="number" value={form.quota_total} onChange={(e) => updateField('quota_total', e.target.value)}
                     className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500">当前余额（可选）</label>
              <input type="number" value={form.balance_remaining} onChange={(e) => updateField('balance_remaining', e.target.value)}
                     placeholder="留空 = 不预警"
                     className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500">续费日（YYYY-MM-DD）</label>
              <input type="date" value={form.renews_at?.slice(0, 10) || ''} onChange={(e) => updateField('renews_at', e.target.value)}
                     className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.auto_renew} onChange={(e) => updateField('auto_renew', e.target.checked)} />
                自动续期
              </label>
            </div>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-gray-500 select-none">高级：预警阈值</summary>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <label className="text-xs text-gray-500">余额 % 阈值</label>
                <input type="number" value={form.alert_balance_pct} onChange={(e) => updateField('alert_balance_pct', e.target.value)}
                       className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500">续费前 N 天</label>
                <input type="number" value={form.alert_days_before} onChange={(e) => updateField('alert_days_before', e.target.value)}
                       className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm mt-2">
              <input type="checkbox" checked={form.alert_enabled} onChange={(e) => updateField('alert_enabled', e.target.checked)} />
              启用预警
            </label>
          </details>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-gray-100 dark:border-gray-800">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700">取消</button>
          <button onClick={submit} className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700">保存</button>
        </div>
      </div>
    </div>
  );
}

// ── SubscriptionCard ─────────────────────────────────────────────────────

function SubCard({ sub, onEdit, onDelete, onRecharge }) {
  const preset = PROVIDER_PRESETS.find((p) => p.provider_id === sub.provider_id);
  const icon = preset?.icon || '📡';

  const balance = sub.balance_remaining;
  const quota = sub.quota_total || 0;
  const usedPct = quota > 0 && balance !== null ? Math.max(0, Math.min(100, ((quota - balance) / quota) * 100)) : 0;

  const daysDep = sub.days_until_depletion;
  const daysRen = sub.days_until_renewal;

  const balanceColor = balance == null ? 'text-gray-400' : (usedPct > 80 ? 'text-red-600 dark:text-red-400' : usedPct > 60 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400');

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
      <div className="flex items-start gap-3">
        <div className="text-2xl">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h3 className="font-semibold text-sm">{sub.display_name}</h3>
              <p className="text-xs text-gray-500">
                {sub.plan_kind === 'plan' && `Plan: ${sub.plan_name || '—'} · $${sub.monthly_cost}/月`}
                {sub.plan_kind === 'payg' && `Pay-as-you-go${balance != null ? ` · 余额 ${sub.currency || 'USD'} ${balance.toFixed(2)}` : ''}`}
                {sub.plan_kind === 'prepaid' && `充值 ${sub.currency || 'USD'} ${quota.toFixed(2)}`}
                {sub.auto_renew ? ' · 自动续期 ✓' : sub.plan_kind === 'plan' ? ' · 自动续期 ✗' : ''}
              </p>
            </div>
            <div className="flex gap-1.5 items-center">
              <button onClick={() => onEdit?.(sub)} className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">设置</button>
              <button onClick={() => onRecharge?.(sub)} className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">立即充值</button>
              <button onClick={() => onDelete?.(sub)} className="text-xs px-2 py-1 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">删除</button>
            </div>
          </div>

          {/* 进度条 */}
          {quota > 0 && balance != null && (
            <div className="mt-3">
              <div className="flex items-center gap-2 text-xs">
                <div className="flex-1 h-2 bg-gray-100 dark:bg-gray-950 rounded overflow-hidden">
                  <div className={`h-2 ${usedPct > 80 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${usedPct}%` }} />
                </div>
                <span className={`font-mono ${balanceColor}`}>{usedPct.toFixed(0)}% used</span>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">已用 {(quota - balance).toFixed(2)} / {quota.toFixed(2)} {sub.currency || 'USD'}</p>
            </div>
          )}

          {/* burn / 续费 */}
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {sub.burn?.daily_avg_usd > 0 && (
              <span>
                <span className="text-gray-500">7 日均：</span>
                <span className="font-mono">${sub.burn.daily_avg_usd.toFixed(2)}/天</span>
              </span>
            )}
            {daysDep != null && (
              <span className={daysDep < 3 ? 'text-red-600 dark:text-red-400 font-medium' : daysDep < 7 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-600'}>
                预计 {daysDep} 天后耗尽
              </span>
            )}
            {sub.renews_at && (
              <span className={daysRen != null && daysRen <= (sub.alert_days_before || 1) ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-600'}>
                续费日 {sub.renews_at?.slice(0, 10)}{daysRen != null && `（${daysRen} 天后）`}
              </span>
            )}
          </div>

          {/* 关联 scenarios */}
          {(sub.related_scenarios || []).length > 0 && (
            <p className="mt-2 text-[11px] text-gray-500">
              关联场景：{sub.related_scenarios.map((s) => s.name).join(' · ')}
            </p>
          )}
          {sub.notes && <p className="mt-1 text-[11px] text-gray-400 italic">{sub.notes}</p>}
        </div>
      </div>
    </div>
  );
}

// ── 主 ─────────────────────────────────────────────────────────────────

export default function Subscriptions() {
  const [subs, setSubs] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingSub, setEditingSub] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const [s, a] = await Promise.all([
        api('/__local__/subscriptions'),
        api('/__local__/alerts'),
      ]);
      if (s.ok) setSubs(s.body.subscriptions || []);
      if (a.ok) setAlerts(a.body.alerts || []);
    })();
  }, [refreshKey]);

  const handleSubmit = async (payload) => {
    if (editingSub?.id) {
      await api(`/__local__/subscriptions/${editingSub.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      await api('/__local__/subscriptions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    setShowForm(false);
    setEditingSub(null);
    setRefreshKey((k) => k + 1);
  };

  const handleEdit = (sub) => { setEditingSub(sub); setShowForm(true); };
  const handleDelete = async (sub) => {
    if (!confirm(`删除订阅「${sub.display_name}」？`)) return;
    await api(`/__local__/subscriptions/${sub.id}`, { method: 'DELETE' });
    setRefreshKey((k) => k + 1);
  };
  const handleRecharge = (sub) => {
    const URLS = {
      'anthropic-official': 'https://console.anthropic.com/settings/billing',
      'openai-official':    'https://platform.openai.com/account/billing',
      'deepseek-official':  'https://platform.deepseek.com/usage',
      'zhipu-glm':          'https://open.bigmodel.cn/usercenter/center',
      'moonshot-kimi':      'https://platform.moonshot.cn/console/info',
      'xai-grok':           'https://console.x.ai',
      'siliconflow':        'https://cloud.siliconflow.cn/billing',
    };
    window.open(URLS[sub.provider_id] || '#', '_blank');
  };

  return (
    <div className="space-y-4">
      {/* 预警 */}
      {alerts.length > 0 && (
        <section className="border border-amber-200 dark:border-amber-900 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-3">
          <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-200 mb-2">⚠ 预警 ({alerts.length})</h4>
          <ul className="text-xs space-y-1">
            {alerts.map((a, i) => (
              <li key={i} className={a.severity === 'high' ? 'text-red-700 dark:text-red-300 font-medium' : 'text-amber-800 dark:text-amber-200'}>
                · {a.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 顶部行：标题 + 添加 */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          手动录入订阅元数据，本机按 7 日均用量预测耗尽天数。<span className="text-amber-500">实时余额需手动刷新或后续接入上游 API。</span>
        </p>
        <button onClick={() => { setEditingSub(null); setShowForm(true); }} className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700">
          + 添加订阅
        </button>
      </div>

      {/* 订阅列表 */}
      {subs.length === 0 ? (
        <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center text-sm text-gray-400">
          还没有订阅。点上方「+ 添加订阅」录入第一条。
        </div>
      ) : (
        <div className="space-y-2.5">
          {subs.map((sub) => (
            <SubCard key={sub.id} sub={sub} onEdit={handleEdit} onDelete={handleDelete} onRecharge={handleRecharge} />
          ))}
        </div>
      )}

      {showForm && (
        <SubForm initial={editingSub} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingSub(null); }} />
      )}
    </div>
  );
}
