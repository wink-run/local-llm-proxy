import React, { useEffect, useState } from 'react';

/** 个人页：订阅套餐 + 模型刊例价配置 */
export default function BillingConfigSection() {
  const [data, setData] = useState(null);
  const [plans, setPlans] = useState({});
  const [overrides, setOverrides] = useState({});
  const [providerPricing, setProviderPricing] = useState({});
  const [pricingExpanded, setPricingExpanded] = useState(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => {
    if (!window.electronAPI?.localConfig?.getBilling) {
      setLoading(false);
      return;
    }
    setLoading(true);
    window.electronAPI.localConfig.getBilling()
      .then(r => {
        setData(r);
        setPlans(JSON.parse(JSON.stringify(r.subscription_plans || {})));
        setOverrides(JSON.parse(JSON.stringify(r.provider_pricing_overrides || {})));
        setProviderPricing(r.provider_pricing || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // 服务端下发新报价后自动刷新
  useEffect(() => {
    const unsub = window.electronAPI?.localConfig?.onBillingChanged?.(load);
    return () => unsub?.();
  }, []);

  async function handleSave() {
    if (!window.electronAPI?.localConfig?.setBilling) return;
    setSaving(true);
    setMsg('');
    try {
      const r = await window.electronAPI.localConfig.setBilling({
        subscription_plans: plans,
        provider_pricing_overrides: overrides,
      });
      setData(r);
      setMsg('已保存');
      setTimeout(() => setMsg(''), 2000);
    } catch {
      setMsg('保存失败，请确认已登录且服务器可达');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(scope) {
    if (!window.electronAPI?.localConfig?.resetBilling) return;
    if (!confirm(scope === 'all' ? '恢复全部默认订阅与刊例价？' : scope === 'plans' ? '恢复默认订阅套餐？' : '恢复默认模型刊例价？')) return;
    setSaving(true);
    try {
      const r = await window.electronAPI.localConfig.resetBilling({ scope });
      setData(r);
      setPlans(JSON.parse(JSON.stringify(r.subscription_plans || {})));
      setOverrides({});
      setProviderPricing(r.provider_pricing || {});
      setMsg('已恢复默认');
      setTimeout(() => setMsg(''), 2000);
    } catch {
      setMsg('恢复失败');
    } finally {
      setSaving(false);
    }
  }

  function updatePlan(providerId, idx, field, value) {
    setPlans(prev => {
      const list = [...(prev[providerId] || [])];
      list[idx] = { ...list[idx], [field]: field === 'monthly_usd' ? (value === '' ? null : Number(value)) : value };
      return { ...prev, [providerId]: list };
    });
  }

  function addPlan(providerId) {
    setPlans(prev => ({
      ...prev,
      [providerId]: [...(prev[providerId] || []), { id: '', label: '', monthly_usd: null }],
    }));
    setExpanded(providerId);
  }

  function removePlan(providerId, idx) {
    setPlans(prev => ({
      ...prev,
      [providerId]: (prev[providerId] || []).filter((_, i) => i !== idx),
    }));
  }

  function updatePricing(providerId, model, field, value) {
    const num = value === '' ? null : Number(value);
    setOverrides(prev => ({
      ...prev,
      [providerId]: { ...(prev[providerId] || {}), [model]: { ...(prev[providerId]?.[model] || {}), [field]: num } },
    }));
  }

  if (!window.electronAPI?.localConfig?.getBilling) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">订阅与刊例价</h2>
        <p className="text-sm text-gray-400">桌面版可用，用于配置订阅套餐与 Token 刊例价估算。</p>
      </section>
    );
  }

  const labels = data?.provider_labels || {};
  const providerIds = Object.keys(plans);
  const pricingProviderIds = Object.keys(providerPricing);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">订阅与刊例价</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            配置各供给源订阅套餐与模型 API 刊例价（USD / 百万 Token），用于用量费用估算。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-green-600 dark:text-green-400">{msg}</span>}
          <button type="button" onClick={() => handleReset('plans')} disabled={saving}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            恢复订阅默认
          </button>
          <button type="button" onClick={() => handleReset('pricing')} disabled={saving}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            恢复刊例价默认
          </button>
          <button type="button" onClick={handleSave} disabled={saving || loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white disabled:opacity-50">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">加载中…</p>
      ) : (
        <>
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">订阅套餐</h3>
              <p className="text-xs text-gray-400 mt-0.5">供给源页选择「订阅」时使用的套餐列表；月费仅供展示与等效价参考。</p>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {providerIds.map(pid => (
                <div key={pid}>
                  <button type="button" onClick={() => setExpanded(expanded === pid ? null : pid)}
                    className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{labels[pid] || pid}</span>
                    <span className="text-xs text-gray-400">{(plans[pid] || []).length} 个套餐 {expanded === pid ? '▲' : '▼'}</span>
                  </button>
                  {expanded === pid && (
                    <div className="px-5 pb-4 space-y-2">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-400">
                            <th className="text-left py-1 font-medium">ID</th>
                            <th className="text-left py-1 font-medium">名称</th>
                            <th className="text-right py-1 font-medium">月费 USD</th>
                            <th className="w-10" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                          {(plans[pid] || []).map((p, idx) => (
                            <tr key={idx}>
                              <td className="py-1.5 pr-2">
                                <input value={p.id} onChange={e => updatePlan(pid, idx, 'id', e.target.value)}
                                  className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 font-mono" />
                              </td>
                              <td className="py-1.5 pr-2">
                                <input value={p.label} onChange={e => updatePlan(pid, idx, 'label', e.target.value)}
                                  className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded px-2 py-1" />
                              </td>
                              <td className="py-1.5 pl-2">
                                <input type="number" min="0" step="0.01" value={p.monthly_usd ?? ''}
                                  onChange={e => updatePlan(pid, idx, 'monthly_usd', e.target.value)}
                                  placeholder="—"
                                  className="w-20 ml-auto block bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-right" />
                              </td>
                              <td className="py-1.5 text-right">
                                <button type="button" onClick={() => removePlan(pid, idx)} className="text-red-400 hover:text-red-500">删</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <button type="button" onClick={() => addPlan(pid)}
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ 添加套餐</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">按 provider 模型刊例价</h3>
                <p className="text-xs text-gray-400 mt-0.5">各供给源独立定价；同模型在不同 provider 可不同价（USD · 百万 Token）。</p>
              </div>
              <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜索模型…"
                className="text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 w-40" />
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {pricingProviderIds.map(pid => {
                const models = Object.keys({ ...providerPricing[pid], ...(overrides[pid] || {}) }).sort();
                const rows = models.map(model => ({
                  model,
                  ...providerPricing[pid]?.[model],
                  ...overrides[pid]?.[model],
                  _override: !!(overrides[pid]?.[model]),
                })).filter(r => !filter || r.model.toLowerCase().includes(filter.toLowerCase()));
                if (!rows.length && filter) return null;
                return (
                  <div key={pid}>
                    <button type="button" onClick={() => setPricingExpanded(pricingExpanded === pid ? null : pid)}
                      className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{labels[pid] || pid}</span>
                      <span className="text-xs text-gray-400">{models.length} 模型 {pricingExpanded === pid ? '▲' : '▼'}</span>
                    </button>
                    {pricingExpanded === pid && (
                      <div className="px-5 pb-4 max-h-64 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="text-gray-400">
                            <tr>
                              <th className="text-left py-1">模型</th>
                              <th className="text-right py-1">输入</th>
                              <th className="text-right py-1">输出</th>
                              <th className="text-right py-1">缓存读</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                            {rows.map(r => (
                              <tr key={r.model} className={r._override ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}>
                                <td className="py-1 font-mono truncate max-w-[10rem]" title={r.model}>{r.model}</td>
                                {['in', 'out', 'cacheRead'].map(f => (
                                  <td key={f} className="py-1">
                                    <input type="number" min="0" step="0.001" value={r[f] ?? ''}
                                      onChange={e => updatePricing(pid, r.model, f, e.target.value)}
                                      className="w-14 ml-auto block text-right tabular-nums bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-600 focus:border-blue-400 rounded px-1" />
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
