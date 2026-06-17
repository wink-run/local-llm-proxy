import React, { useCallback, useEffect, useState } from 'react';

const TX_LABEL = {
  contribute: '贡献', consume: '消耗', referral: '推荐', purchase: '充值', adjust: '调整', spin: '转盘',
};

const CUSTOM_APP = '__custom_app__';
const CUSTOM_PLAN = '__custom_plan__';
const CUSTOM_PAYG = '__custom_payg__';

function uid() {
  return `ua-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 合并某 provider 下各模型的刊例价（yaml 默认 + 用户覆盖） */
function pricingRowsForProvider(providerId, models, merged, overrides) {
  const base = merged[providerId] || {};
  const ovr = overrides[providerId] || {};
  const names = new Set([...(models || []), ...Object.keys(base), ...Object.keys(ovr)]);
  return [...names].sort().map(model => ({
    model,
    ...base[model],
    ...ovr[model],
    _override: !!(ovr[model] && Object.keys(ovr[model]).length),
  }));
}

/** 个人页：积分 / 订阅 / 按量付费 三类账户 */
export default function UserAccountsPanel({
  user,
  txs = [],
  creditsOpen,
  onCreditsToggle,
  onRefreshUser,
  CheckinCard,
  SpinCard,
  purchaseForm,
}) {
  const [tab, setTab] = useState('p2p');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // 订阅：添加表单
  const [addSubSource, setAddSubSource] = useState('');
  const [addSubPlan, setAddSubPlan] = useState('');
  const [customAppName, setCustomAppName] = useState('');
  const [customPlanLabel, setCustomPlanLabel] = useState('');
  const [customPlanUsd, setCustomPlanUsd] = useState('');

  function resetSubForm() {
    setAddSubSource('');
    setAddSubPlan('');
    setCustomAppName('');
    setCustomPlanLabel('');
    setCustomPlanUsd('');
  }

  function onSubSourceChange(value) {
    setAddSubSource(value);
    setAddSubPlan('');
    setCustomPlanLabel('');
    setCustomPlanUsd('');
    if (value !== CUSTOM_APP) setCustomAppName('');
  }

  // 按量：添加 provider
  const [addPaygId, setAddPaygId] = useState('');
  const [customPaygLabel, setCustomPaygLabel] = useState('');
  const [paygExpanded, setPaygExpanded] = useState(null);
  const [pricingFilter, setPricingFilter] = useState('');
  const [overrides, setOverrides] = useState({});
  const [providerPricing, setProviderPricing] = useState({});
  const [subMsg, setSubMsg] = useState('');
  const [paygMsg, setPaygMsg] = useState('');

  function onPaygSelectChange(value) {
    setAddPaygId(value);
    if (value !== CUSTOM_PAYG) setCustomPaygLabel('');
  }

  const load = useCallback(() => {
    if (!window.electronAPI?.localConfig?.getUserAccounts) {
      setLoading(false);
      return;
    }
    setLoading(true);
    window.electronAPI.localConfig.getUserAccounts()
      .then(r => {
        setData(r);
        setOverrides(JSON.parse(JSON.stringify(r.provider_pricing_overrides || {})));
        setProviderPricing(r.provider_pricing || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // 服务端下发新报价后自动刷新
  useEffect(() => {
    const unsub = window.electronAPI?.localConfig?.onBillingChanged?.(load);
    return () => unsub?.();
  }, [load]);

  async function saveAccounts(patch) {
    if (!window.electronAPI?.localConfig?.setUserAccounts) {
      setMsg('当前环境无法保存（请使用桌面版）');
      setSubMsg('当前环境无法保存（请使用桌面版）');
      setPaygMsg('当前环境无法保存（请使用桌面版）');
      return false;
    }
    setSaving(true);
    setMsg('');
    setSubMsg('');
    setPaygMsg('');
    try {
      const r = await window.electronAPI.localConfig.setUserAccounts({
        user_subscriptions: data?.user_subscriptions,
        user_payg_providers: data?.user_payg_providers,
        provider_pricing_overrides: overrides,
        ...patch,
      });
      setData(r);
      setMsg('已保存');
      setSubMsg('已添加');
      setPaygMsg('已添加');
      setTimeout(() => { setMsg(''); setSubMsg(''); setPaygMsg(''); }, 2000);
      return true;
    } catch (e) {
      const tip = '保存失败，请确认已登录且服务器可达';
      setMsg(tip);
      setSubMsg(tip);
      setPaygMsg(tip);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const catalog = data?.subscription_catalog || [];
  const subs = data?.user_subscriptions || [];
  const payg = data?.user_payg_providers || [];
  const paygOptions = data?.payg_provider_catalog || [];

  const isCustomApp = addSubSource === CUSTOM_APP;
  const isCustomPlan = addSubPlan === CUSTOM_PLAN;
  const catalogItem = !isCustomApp ? catalog.find(c => c.source_id === addSubSource) : null;
  const planOptions = catalogItem?.plans?.length
    ? catalogItem.plans
    : (catalogItem ? [{ id: 'other', label: '其他套餐', monthly_usd: null }] : []);

  async function addSubscription() {
    setSubMsg('');
    if (isCustomApp) {
      const name = customAppName.trim();
      const planLabel = customPlanLabel.trim();
      if (!name || !planLabel) {
        setSubMsg('请填写应用名称和套餐名称');
        return;
      }
      if (subs.some(s => s.app_name.toLowerCase() === name.toLowerCase())) {
        setSubMsg(`已存在应用「${name}」`);
        return;
      }
      const sourceId = `custom-${name.toLowerCase().replace(/\s+/g, '-').slice(0, 32)}-${Date.now().toString(36)}`;
      const monthly = customPlanUsd === '' ? null : Number(customPlanUsd);
      const next = [...subs, {
        id: uid(),
        source_id: sourceId,
        agent_id: null,
        app_name: name,
        app_icon: '🔧',
        plan_id: 'custom',
        plan_label: planLabel,
        monthly_usd: Number.isFinite(monthly) ? monthly : null,
        custom: true,
      }];
      setData(d => ({ ...(d || {}), user_subscriptions: next }));
      const ok = await saveAccounts({ user_subscriptions: next });
      if (ok) resetSubForm();
      return;
    }

    if (!addSubSource || !catalogItem) {
      setSubMsg('请选择应用');
      return;
    }
    if (subs.some(s => s.source_id === addSubSource)) {
      setSubMsg('该应用已添加');
      return;
    }

    let plan_id, plan_label, monthly_usd;
    if (isCustomPlan) {
      const planLabel = customPlanLabel.trim();
      if (!planLabel) {
        setSubMsg('请填写套餐名称');
        return;
      }
      plan_id = 'custom';
      plan_label = planLabel;
      monthly_usd = customPlanUsd === '' ? null : Number(customPlanUsd);
      if (monthly_usd != null && !Number.isFinite(monthly_usd)) monthly_usd = null;
    } else {
      if (!addSubPlan) {
        setSubMsg('请选择套餐');
        return;
      }
      const plan = planOptions.find(p => p.id === addSubPlan);
      if (!plan) {
        setSubMsg('请选择有效套餐');
        return;
      }
      plan_id = plan.id;
      plan_label = plan.label || plan.id;
      monthly_usd = plan.monthly_usd ?? null;
    }

    const next = [...subs, {
      id: uid(),
      source_id: addSubSource,
      agent_id: catalogItem.agent_id,
      app_name: catalogItem.app_name,
      app_icon: catalogItem.app_icon,
      plan_id,
      plan_label,
      monthly_usd,
    }];
    setData(d => ({ ...(d || {}), user_subscriptions: next }));
    const ok = await saveAccounts({ user_subscriptions: next });
    if (ok) resetSubForm();
  }

  const canAddSubscription = isCustomApp
    ? customAppName.trim() && customPlanLabel.trim()
    : addSubSource && (isCustomPlan ? customPlanLabel.trim() : addSubPlan);

  function removeSubscription(id) {
    const next = subs.filter(s => s.id !== id);
    setData(d => ({ ...d, user_subscriptions: next }));
    saveAccounts({ user_subscriptions: next });
  }

  async function addPaygProvider() {
    setPaygMsg('');
    const isCustomPayg = addPaygId === CUSTOM_PAYG;

    if (isCustomPayg) {
      const label = customPaygLabel.trim();
      if (!label) {
        setPaygMsg('请填写供给源名称');
        return;
      }
      if (payg.some(p => p.label.toLowerCase() === label.toLowerCase())) {
        setPaygMsg(`已存在供给源「${label}」`);
        return;
      }
      const slug = label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'provider';
      const providerId = `custom-${slug}-${Date.now().toString(36)}`;
      const next = [...payg, {
        id: uid(),
        provider_id: providerId,
        label,
        icon: '🔧',
        models: [],
        enabled: true,
        custom: true,
      }];
      setData(d => ({ ...(d || {}), user_payg_providers: next }));
      const ok = await saveAccounts({ user_payg_providers: next });
      if (ok) {
        setAddPaygId('');
        setCustomPaygLabel('');
        setPaygExpanded(next[next.length - 1].id);
      }
      return;
    }

    if (!addPaygId) {
      setPaygMsg('请选择供给源');
      return;
    }
    if (payg.some(p => p.provider_id === addPaygId)) {
      setPaygMsg('该供给源已添加');
      return;
    }
    const meta = paygOptions.find(p => p.id === addPaygId || p.provider_id === addPaygId)
      || { label: addPaygId, icon: '🔧', models: [] };
    const next = [...payg, {
      id: uid(),
      provider_id: addPaygId,
      label: meta.label,
      icon: meta.icon,
      models: [...(meta.models || [])],
      enabled: true,
    }];
    setData(d => ({ ...(d || {}), user_payg_providers: next }));
    const ok = await saveAccounts({ user_payg_providers: next });
    if (ok) setAddPaygId('');
  }

  const isCustomPayg = addPaygId === CUSTOM_PAYG;
  const canAddPayg = isCustomPayg ? !!customPaygLabel.trim() : !!addPaygId;

  function removePayg(id) {
    const next = payg.filter(p => p.id !== id);
    setData(d => ({ ...d, user_payg_providers: next }));
    saveAccounts({ user_payg_providers: next });
  }

  function addModelToPayg(paygId, modelName) {
    const name = (modelName || '').trim();
    if (!name) return;
    const next = payg.map(p => {
      if (p.id !== paygId) return p;
      if ((p.models || []).includes(name)) return p;
      return { ...p, models: [...(p.models || []), name] };
    });
    setData(d => ({ ...d, user_payg_providers: next }));
    saveAccounts({ user_payg_providers: next });
  }

  function updatePricing(providerId, model, field, value) {
    const num = value === '' ? null : Number(value);
    setOverrides(prev => ({
      ...prev,
      [providerId]: { ...(prev[providerId] || {}), [model]: { ...(prev[providerId]?.[model] || {}), [field]: num } },
    }));
  }

  function savePricing() {
    saveAccounts({ provider_pricing_overrides: overrides });
  }

  const tabs = [
    { id: 'p2p', label: '积分账户', sub: 'P2P', color: 'blue' },
    { id: 'subscription', label: '订阅账户', sub: `${subs.length} 个`, color: 'amber' },
    { id: 'payg', label: '按量付费', sub: `${payg.length} 个`, color: 'emerald' },
  ];

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl overflow-hidden">
      {/* 账户类型切换 */}
      <div className="flex border-b border-gray-100 dark:border-gray-700">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`flex-1 px-4 py-3 text-left transition-colors ${
              tab === t.id
                ? 'bg-gray-50 dark:bg-gray-700/50 border-b-2 border-blue-500'
                : 'hover:bg-gray-50/50 dark:hover:bg-gray-700/30'
            }`}>
            <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t.label}</div>
            <div className="text-[10px] text-gray-400 mt-0.5">{t.sub}</div>
          </button>
        ))}
      </div>

      <div className="p-5 space-y-4">
        {msg && <p className="text-xs text-green-600 dark:text-green-400">{msg}</p>}

        {/* ── 积分账户 P2P ── */}
        {tab === 'p2p' && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                  💎 {Math.floor(user?.credits_balance ?? 0).toLocaleString()}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  累计 <span className="text-green-600">+{Math.floor(user?.credits_earned ?? 0).toLocaleString()}</span>
                  {' / '}
                  <span className="text-red-500">-{Math.floor(user?.credits_spent ?? 0).toLocaleString()}</span>
                </p>
              </div>
              <button type="button" onClick={onCreditsToggle}
                className="text-xs text-gray-400 hover:text-gray-600">
                {creditsOpen ? '收起明细 ▲' : '展开明细 ▼'}
              </button>
            </div>

            {creditsOpen && (
              <div className="space-y-3 pt-2 border-t border-gray-100 dark:border-gray-700">
                <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300">积分流水</h3>
                {txs.length === 0 ? (
                  <p className="text-sm text-gray-400">暂无记录</p>
                ) : txs.slice(0, 10).map(tx => (
                  <div key={tx.id} className="flex items-center justify-between text-sm">
                    <div>
                      <span className="text-gray-700 dark:text-gray-300">
                        {TX_LABEL[tx.type] || tx.type}{tx.model_name ? ` · ${tx.model_name}` : ''}
                      </span>
                      <span className="text-xs text-gray-400 ml-2">{tx.created_at?.slice(0, 16)}</span>
                    </div>
                    <span className={`font-medium ${(tx.delta ?? 0) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {(tx.delta ?? 0) >= 0 ? '+' : ''}{(tx.delta ?? 0).toFixed(1)}
                    </span>
                  </div>
                ))}
                {purchaseForm}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-2">
              {CheckinCard && <CheckinCard onSuccess={onRefreshUser} />}
              {SpinCard && <SpinCard onSuccess={onRefreshUser} />}
            </div>
            <p className="text-[11px] text-gray-400">P2P 网络消耗积分调用社区共享算力，可在「贡献」页赚取积分。</p>
          </>
        )}

        {/* ── 订阅账户 ── */}
        {tab === 'subscription' && (
          <>
            {loading ? (
              <p className="text-sm text-gray-400">加载中…</p>
            ) : (
              <>
                <p className="text-xs text-gray-500">应用目录来自服务端下发；也可添加自定义应用与自定义套餐（月费仅供等效价参考）。</p>

                {/* 已添加 */}
                {subs.length === 0 ? (
                  <p className="text-sm text-gray-400 py-4 text-center">尚未添加应用订阅</p>
                ) : (
                  <div className="space-y-2">
                    {subs.map(s => (
                      <div key={s.id}
                        className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50/60 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-800/30">
                        <span className="text-lg">{s.app_icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{s.app_name}</div>
                          <div className="text-xs text-gray-500">
                            {s.plan_label || s.plan_id}
                            {s.monthly_usd != null ? ` · $${s.monthly_usd}/月` : ''}
                            {s.custom || s.plan_id === 'custom' ? (
                              <span className="ml-1 text-amber-600/80">自定义</span>
                            ) : null}
                          </div>
                        </div>
                        <button type="button" onClick={() => removeSubscription(s.id)}
                          className="text-xs text-red-400 hover:text-red-500 shrink-0">移除</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* 添加 */}
                <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                  {subMsg && (
                    <p className={`text-xs ${subMsg.includes('已添加') || subMsg.includes('已保存') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                      {subMsg}
                    </p>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 min-w-[140px]">
                      <label className="text-[10px] text-gray-400 block mb-1">应用</label>
                      <select value={addSubSource} onChange={e => onSubSourceChange(e.target.value)}
                        className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2">
                        <option value="">选择应用…</option>
                        {catalog.filter(c => !subs.some(s => s.source_id === c.source_id)).map(c => (
                          <option key={c.source_id} value={c.source_id}>{c.app_icon} {c.app_name}</option>
                        ))}
                        <option value={CUSTOM_APP}>➕ 自定义应用…</option>
                      </select>
                    </div>

                    {!isCustomApp && (
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-[10px] text-gray-400 block mb-1">套餐</label>
                        <select value={addSubPlan} onChange={e => setAddSubPlan(e.target.value)} disabled={!addSubSource}
                          className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2 disabled:opacity-50">
                          <option value="">选择套餐…</option>
                          {planOptions.map(p => (
                            <option key={p.id} value={p.id}>
                              {p.label}{p.monthly_usd != null ? ` ($${p.monthly_usd}/月)` : ''}
                            </option>
                          ))}
                          <option value={CUSTOM_PLAN}>➕ 自定义套餐…</option>
                        </select>
                      </div>
                    )}

                    <button type="button" onClick={addSubscription} disabled={!canAddSubscription || saving}
                      className="text-xs px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50">
                      {saving ? '保存中…' : '添加订阅'}
                    </button>
                  </div>

                  {/* 自定义应用：名称 + 套餐 + 月费 */}
                  {isCustomApp && (
                    <div className="flex flex-wrap items-end gap-2 pl-1">
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-[10px] text-gray-400 block mb-1">应用名称</label>
                        <input value={customAppName} onChange={e => setCustomAppName(e.target.value)}
                          placeholder="如 Cursor、Warp…"
                          className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2" />
                      </div>
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-[10px] text-gray-400 block mb-1">套餐名称</label>
                        <input value={customPlanLabel} onChange={e => setCustomPlanLabel(e.target.value)}
                          placeholder="如 Pro、Business…"
                          className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2" />
                      </div>
                      <div className="w-24">
                        <label className="text-[10px] text-gray-400 block mb-1">月费 USD</label>
                        <input type="number" min="0" step="0.01" value={customPlanUsd}
                          onChange={e => setCustomPlanUsd(e.target.value)} placeholder="选填"
                          className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2 text-right" />
                      </div>
                    </div>
                  )}

                  {/* 目录应用 + 自定义套餐 */}
                  {!isCustomApp && isCustomPlan && (
                    <div className="flex flex-wrap items-end gap-2 pl-1">
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-[10px] text-gray-400 block mb-1">套餐名称</label>
                        <input value={customPlanLabel} onChange={e => setCustomPlanLabel(e.target.value)}
                          placeholder="输入套餐名…"
                          className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2" />
                      </div>
                      <div className="w-24">
                        <label className="text-[10px] text-gray-400 block mb-1">月费 USD</label>
                        <input type="number" min="0" step="0.01" value={customPlanUsd}
                          onChange={e => setCustomPlanUsd(e.target.value)} placeholder="选填"
                          className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2 text-right" />
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* ── 按量付费账户 ── */}
        {tab === 'payg' && (
          <>
            {loading ? (
              <p className="text-sm text-gray-400">加载中…</p>
            ) : (
              <>
                <p className="text-xs text-gray-500">供给源目录来自服务端下发；也可添加自定义 provider，再配置模型刊例价（USD / 百万 Token）。</p>

                {/* 已添加 provider */}
                {payg.length === 0 ? (
                  <p className="text-sm text-gray-400 py-4 text-center">尚未添加按量付费供给源</p>
                ) : (
                  <div className="space-y-2">
                    {payg.map(p => (
                      <div key={p.id} className="rounded-xl border border-gray-100 dark:border-gray-700 overflow-hidden">
                        <button type="button" onClick={() => setPaygExpanded(paygExpanded === p.id ? null : p.id)}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30">
                          <span>{p.icon}</span>
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-200 flex-1">
                            {p.label}
                            {p.custom && <span className="ml-1 text-[10px] text-emerald-600/80">自定义</span>}
                          </span>
                          <span className="text-xs text-gray-400">{(p.models || []).length} 模型</span>
                          <span className="text-gray-400">{paygExpanded === p.id ? '▲' : '▼'}</span>
                        </button>
                        {paygExpanded === p.id && (
                          <div className="px-4 pb-4 space-y-3 border-t border-gray-100 dark:border-gray-700">
                            <div className="flex gap-2 pt-2">
                              <input id={`model-add-${p.id}`} placeholder="模型名，如 gpt-4o"
                                className="flex-1 text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 font-mono"
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    addModelToPayg(p.id, e.target.value);
                                    e.target.value = '';
                                  }
                                }} />
                              <button type="button"
                                onClick={() => {
                                  const el = document.getElementById(`model-add-${p.id}`);
                                  addModelToPayg(p.id, el?.value);
                                  if (el) el.value = '';
                                }}
                                className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white">添加模型</button>
                            </div>

                            {/* 该 provider 下的模型报价 */}
                            <div className="rounded-lg border border-gray-100 dark:border-gray-700 overflow-hidden">
                              <table className="w-full text-xs">
                                <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-500">
                                  <tr>
                                    <th className="text-left px-2 py-1.5">模型</th>
                                    <th className="text-right px-1 py-1.5">输入</th>
                                    <th className="text-right px-1 py-1.5">输出</th>
                                    <th className="text-right px-2 py-1.5">缓存读</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                                  {pricingRowsForProvider(p.provider_id, p.models, providerPricing, overrides)
                                    .filter(r => !pricingFilter || r.model.toLowerCase().includes(pricingFilter.toLowerCase()))
                                    .map(r => (
                                    <tr key={r.model} className={r._override ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}>
                                      <td className="px-2 py-1 font-mono text-gray-700 dark:text-gray-300 truncate max-w-[8rem]" title={r.model}>{r.model}</td>
                                      {['in', 'out', 'cacheRead'].map(f => (
                                        <td key={f} className="px-1 py-1">
                                          <input type="number" min="0" step="0.001" value={r[f] ?? ''}
                                            onChange={e => updatePricing(p.provider_id, r.model, f, e.target.value)}
                                            className="w-12 ml-auto block text-right tabular-nums bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-600 focus:border-blue-400 rounded px-0.5" />
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>

                            <button type="button" onClick={() => removePayg(p.id)}
                              className="text-xs text-red-400 hover:text-red-500">移除此供给源</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 添加 provider */}
                <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                  {paygMsg && (
                    <p className={`text-xs ${paygMsg.includes('已添加') || paygMsg.includes('已保存') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                      {paygMsg}
                    </p>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 min-w-[140px]">
                      <label className="text-[10px] text-gray-400 block mb-1">供给源</label>
                      <select value={addPaygId} onChange={e => onPaygSelectChange(e.target.value)}
                        className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2">
                        <option value="">选择供给源…</option>
                        {paygOptions.filter(o => !payg.some(p => p.provider_id === (o.id || o.provider_id))).map(o => (
                          <option key={o.id || o.provider_id} value={o.id || o.provider_id}>{o.icon} {o.label}</option>
                        ))}
                        <option value={CUSTOM_PAYG}>➕ 自定义供给源…</option>
                      </select>
                    </div>
                    {!isCustomPayg && (
                      <button type="button" onClick={addPaygProvider} disabled={!canAddPayg || saving}
                        className="text-xs px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                        {saving ? '保存中…' : '添加'}
                      </button>
                    )}
                  </div>
                  {isCustomPayg && (
                    <div className="flex flex-wrap items-end gap-2 pl-1">
                      <div className="flex-1 min-w-[160px]">
                        <label className="text-[10px] text-gray-400 block mb-1">供给源名称</label>
                        <input value={customPaygLabel} onChange={e => setCustomPaygLabel(e.target.value)}
                          placeholder="如 MiniMax、Moonshot…"
                          className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-2"
                          onKeyDown={e => { if (e.key === 'Enter') addPaygProvider(); }} />
                      </div>
                      <button type="button" onClick={addPaygProvider} disabled={!canAddPayg || saving}
                        className="text-xs px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                        {saving ? '保存中…' : '添加'}
                      </button>
                    </div>
                  )}
                </div>

                {payg.length > 0 && (
                  <div className="flex justify-end gap-2 pt-2">
                    <input value={pricingFilter} onChange={e => setPricingFilter(e.target.value)}
                      placeholder="搜索模型…"
                      className="text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 w-32" />
                    <button type="button" onClick={savePricing} disabled={saving}
                      className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white disabled:opacity-50">
                      {saving ? '保存中…' : '保存报价'}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
