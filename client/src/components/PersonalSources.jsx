// 个人源体系 UI 组件集（账户统计 / 源模板库 / 个人源双视图 / 同步差异）。
// 数据来自 IPC getUserAccounts（billing-config）：account_stats / source_templates /
// direct_source_instances / sync_diff / user_subscriptions / user_payg_providers。
// 保存统一走父级传入的 onSave(patch)（= saveAccounts），写 source_template_overrides /
// direct_source_billing / user_payg_providers 等字段。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../store/lang';
import { useCurrency } from '../store/currency';
import ServiceIcon from './ServiceIcon';

const PRICE_FIELDS = ['in', 'out', 'cacheRead'];

/** 计费表格（模型 → in/out/cacheRead）。价格框编辑中用本地草稿字符串（允许 "2." 这类小数中间态），
 *  失焦(onBlur)才把字符串交给 onCell 提交，避免「输一个字就被 Number() 吃掉/被 reload 刷回」。 */
function PricingTable({ rows, onCell, onAddModel, onRemoveModel, t }) {
  const [newModel, setNewModel] = useState('');
  const [draft, setDraft] = useState({});   // 'model:field' → 编辑中的原始字符串
  const keyOf = (m, f) => `${m}:${f}`;
  const cellVal = (m, f, num) => {
    const k = keyOf(m, f);
    return draft[k] !== undefined ? draft[k] : (num ?? '');
  };
  const onInput = (m, f, str) => setDraft(d => ({ ...d, [keyOf(m, f)]: str }));
  const onCommit = (m, f, str) => {
    setDraft(d => { const n = { ...d }; delete n[keyOf(m, f)]; return n; });
    onCell(m, f, str);
  };
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[1fr_repeat(3,minmax(0,4rem))_auto] gap-1 text-[10px] text-zinc-400 px-1">
        <span>{t('psrc.model')}</span>
        {PRICE_FIELDS.map(f => <span key={f} className="text-right">{f}</span>)}
        <span />
      </div>
      {rows.length === 0 && (
        <p className="text-xs text-zinc-400 py-1.5 text-center">{t('psrc.noModels')}</p>
      )}
      {rows.map(r => (
        <div key={r.model} className={`grid grid-cols-[1fr_repeat(3,minmax(0,4rem))_auto] gap-1 items-center ${r._override ? 'bg-amber-50/50 dark:bg-amber-900/10 rounded' : ''}`}>
          <span className="text-xs font-mono text-zinc-700 dark:text-zinc-300 truncate px-1" title={r.model}>{r.model}</span>
          {PRICE_FIELDS.map(f => (
            <input key={f} type="text" inputMode="decimal" value={cellVal(r.model, f, r[f])} placeholder="—"
              onChange={e => onInput(r.model, f, e.target.value)}
              onBlur={e => onCommit(r.model, f, e.target.value)}
              className="text-xs text-right bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1 py-1 w-full tabular-nums" />
          ))}
          {onRemoveModel
            ? <button type="button" onClick={() => onRemoveModel(r.model)} className="text-xs text-red-400 hover:text-red-500 px-1">×</button>
            : <span />}
        </div>
      ))}
      {onAddModel && (
        <div className="flex gap-1 pt-1">
          <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder={t('psrc.addModelPh')}
            className="flex-1 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 font-mono" />
          <button type="button" disabled={!newModel.trim()}
            onClick={() => { if (newModel.trim()) { onAddModel(newModel.trim()); setNewModel(''); } }}
            className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-700 disabled:opacity-50">+ {t('psrc.add')}</button>
        </div>
      )}
    </div>
  );
}

// ── 第1块：账户统计 ────────────────────────────────────────────────────────────
export function AccountStatsView({ data, t, filter = 'all', onFilter }) {
  const stats = data?.account_stats || { subscription: 0, api: 0, total: 0 };
  const subs = data?.user_subscriptions || [];
  const payg = data?.user_payg_providers || [];
  const direct = data?.direct_source_instances || [];
  // 直连源按各自计费类型并入订阅 / API 两类（与 accountStats 统计一致）
  const directSubs = direct.filter(d => d.mode !== 'api');
  const directApi = direct.filter(d => d.mode === 'api');
  // 点统计方块 = 按订阅/API 粗筛；再点已选的取消回「全部」
  const card = (key, label, n, color, ring, hint) => {
    const active = filter === key;
    const clickable = !!onFilter;
    return (
      <div
        role={clickable ? 'button' : undefined}
        onClick={clickable ? () => onFilter(active ? 'all' : key) : undefined}
        className={`flex-1 rounded-2xl border p-4 transition ${color} ${clickable ? 'cursor-pointer hover:opacity-90' : ''} ${active ? ring : ''}`}>
        <div className="text-3xl font-bold tabular-nums">{n}</div>
        <div className="text-sm font-medium mt-1">{label}</div>
        {hint && <div className="text-xs opacity-70 mt-0.5">{hint}</div>}
      </div>
    );
  };
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        {card('subscription', t('psrc.stat.subscription'), stats.subscription,
          'border-amber-200 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10 text-amber-700 dark:text-amber-300',
          'ring-2 ring-amber-400',
          t('psrc.stat.hintCount', { added: subs.length, direct: directSubs.length }))}
        {card('api', t('psrc.stat.api'), stats.api,
          'border-emerald-200 dark:border-emerald-800/40 bg-emerald-50/50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-300',
          'ring-2 ring-emerald-400',
          t('psrc.stat.hintCount', { added: payg.length, direct: directApi.length }))}
      </div>
    </div>
  );
}

// ── 第3块：直连源卡（设计费 + 没设红警告）────────────────────────────────────────
export function DirectSourceCard({ instance, onSave, t }) {
  // 直连源计费类型与上面账户一致：订阅(月费) / API(按模型)。二选一，点「保存」才提交。
  const baseMonthly = instance.monthly_usd != null ? String(instance.monthly_usd) : '';
  const basePricing = instance.pricing || {};
  const baseApi = instance.mode === 'api';
  const [monthly, setMonthly] = useState(baseMonthly);
  const [pricing, setPricing] = useState(basePricing);
  const [isApi, setIsApi] = useState(baseApi);   // false=订阅(月费)  true=API(按模型)
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // reload 后（无未保存改动时）跟随最新 props；有未保存改动则保留用户输入不被冲掉
  const sig = `${baseMonthly}|${JSON.stringify(basePricing)}|${baseApi}`;
  const sigRef = useRef(sig);
  useEffect(() => {
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    if (!dirty) { setMonthly(baseMonthly); setPricing(basePricing); setIsApi(baseApi); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const rows = Object.keys(pricing).map(m => ({ model: m, ...pricing[m] }));
  // 草稿是否真的偏离基线（切回原状、改了又改回都不算改动）
  const dirtyOf = (m, p, a) =>
    m !== baseMonthly || a !== baseApi || JSON.stringify(p) !== JSON.stringify(basePricing);
  const onCell = (model, field, val) => {
    const next = { ...pricing, [model]: { ...(pricing[model] || {}) } };
    if (val === '' || val == null) delete next[model][field];
    else { const num = Number(val); if (Number.isFinite(num)) next[model][field] = num; }
    setPricing(next);
    setDirty(dirtyOf(monthly, next, isApi));
  };
  const onAddModel = (m) => { if (pricing[m]) return; const next = { ...pricing, [m]: {} }; setPricing(next); setDirty(dirtyOf(monthly, next, isApi)); };
  const onRemoveModel = (m) => { const next = { ...pricing }; delete next[m]; setPricing(next); setDirty(dirtyOf(monthly, next, isApi)); };

  const doSave = async () => {
    setSaving(true);
    const num = monthly.trim() === '' ? null : Number(monthly);
    const billing = { ...(instance._allBilling || {}) };
    billing[instance.agent_id] = {
      ...(billing[instance.agent_id] || {}),
      mode: isApi ? 'api' : 'subscription',
      monthly_usd: (num != null && Number.isFinite(num)) ? num : null,
      pricing,
    };
    try { await onSave({ direct_source_billing: billing }); setDirty(false); }
    finally { setSaving(false); }
  };
  const reset = () => { setMonthly(baseMonthly); setPricing(basePricing); setIsApi(baseApi); setDirty(false); };
  const toggleMode = () => { const nv = !isApi; setIsApi(nv); setDirty(dirtyOf(monthly, pricing, nv)); };

  const hasPricing = !!instance.has_pricing;
  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${hasPricing ? 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800/40' : 'border-red-300 dark:border-red-800/50 bg-red-50/40 dark:bg-red-900/10'}`}>
      <div className="flex items-center gap-2">
        <ServiceIcon id={instance.source_id} name={instance.label} icon={instance.icon} />
        <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{instance.name}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">{t('psrc.directTag')}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${isApi ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' : 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'}`}>
          {isApi ? t('psrc.direct.apiTag') : t('psrc.direct.subTag')}
        </span>
        {!hasPricing && (
          <span className="ml-auto text-xs text-red-500 font-medium">⚠ {t('psrc.direct.noPricing')}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {isApi ? (
          <label className="text-xs text-zinc-500 dark:text-zinc-400">{t('psrc.direct.apiTitle')}</label>
        ) : (
          <>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">{t('psrc.direct.subTitle')}</label>
            <span className="text-xs text-zinc-400">$</span>
            <input type="text" inputMode="decimal" value={monthly} placeholder="0"
              onChange={e => { const v = e.target.value; setMonthly(v); setDirty(dirtyOf(v, pricing, isApi)); }}
              className="w-24 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 tabular-nums" />
            <span className="text-xs text-zinc-400">{t('psrc.direct.monthlyUnit')}</span>
          </>
        )}
        <button type="button" onClick={toggleMode} className="ml-auto text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          {isApi ? t('psrc.direct.switchSub') : t('psrc.direct.switchApi')}
        </button>
      </div>
      {isApi && (
        <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
          <PricingTable rows={rows} onCell={onCell} onAddModel={onAddModel} onRemoveModel={onRemoveModel} t={t} />
        </div>
      )}
      <div className="flex items-center gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
        {dirty && <span className="text-xs text-amber-500">{t('psrc.direct.unsaved')}</span>}
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <button type="button" onClick={reset} disabled={saving}
              className="text-xs px-3 py-1 rounded-lg text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 disabled:opacity-50">
              {t('psrc.direct.cancel')}
            </button>
          )}
          <button type="button" onClick={doSave} disabled={!dirty || saving}
            className="text-xs px-3 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">
            {saving ? t('psrc.direct.saving') : t('psrc.direct.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 第3块：供给源实例卡（图标/名称与统计一致，可删除）────────────────────────────
export function UnenrolledInstanceCard({ instance, onRemove, t }) {
  const i = instance;
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/40">
      <ServiceIcon id={i.source_id} name={i.label} icon={i.icon} />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">{i.name}</div>
        <div className="text-[10px] text-zinc-400 truncate">
          {i.billing_type === 'api'
            ? `${t('psrc.stat.api')}${i.models?.length ? ` · ${i.models.length} ${t('psrc.unenrolled.models')}` : ''}`
            : `${t('psrc.stat.subscription')}${i.plan_label ? ` · ${i.plan_label}` : ''}${i.monthly_usd != null ? ` · $${i.monthly_usd}/mo` : ''}`}
        </div>
      </div>
      {onRemove && (
        <button type="button" onClick={() => onRemove(i)} title={t('psrc.tpl.removeInstance')}
          className="shrink-0 text-zinc-400 hover:text-red-500 text-lg leading-none px-1">×</button>
      )}
    </div>
  );
}

// ── 第3块：按模型视图（仿社区源，一实例多模型多行，一模型多源聚组）────────────────
export function PersonalSourceModelView({ instances, t }) {
  const byModel = useMemo(() => {
    const m = {};
    for (const inst of instances) {
      for (const model of (inst.models || [])) {
        (m[model] = m[model] || []).push(inst);
      }
    }
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [instances]);
  if (byModel.length === 0) return <p className="text-xs text-zinc-400 py-4 text-center">{t('psrc.model.empty')}</p>;
  return (
    <div className="space-y-2">
      {byModel.map(([model, srcs]) => (
        <div key={model} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-100 dark:border-zinc-800">
          <span className="text-sm font-mono text-zinc-700 dark:text-zinc-300 flex-1 truncate">{model}</span>
          <div className="flex flex-wrap gap-1 justify-end">
            {srcs.map((s, i) => (
              <span key={(s.id || s.agent_id) + ':' + i} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">
                <ServiceIcon id={s.source_id || s.provider_id} name={s.name || s.label} icon={s.icon} />
                {s.name || s.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 第2块：源模板库网格（彩/灰均可点编辑）────────────────────────────────────────
function templateKindLabel(tpl, t) {
  const base = tpl.kind === 'payg' ? t('psrc.kind.payg') : tpl.kind === 'api_sub' ? t('psrc.kind.apiSub') : t('psrc.kind.appSub');
  return tpl.custom ? `${base} · ${t('psrc.tpl.customTag')}` : base;
}

export function SourceTemplateGrid({ templates, addedKeys, onEdit, onAdd, t }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">{t('psrc.tpl.hint')}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {templates.map(tpl => {
          const added = addedKeys.has(tpl.key);
          return (
            <button key={tpl.key} type="button" onClick={() => onEdit(tpl)}
              title={`${tpl.label} · ${templateKindLabel(tpl, t)}${tpl._override ? ' · ' + t('psrc.tpl.edited') : ''}`}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition
                ${added ? 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/60'
                        : 'border-dashed border-zinc-200 dark:border-zinc-700 bg-zinc-50/40 dark:bg-zinc-800/20'}`}>
              <span className={added ? '' : 'grayscale opacity-50'}>
                <ServiceIcon id={tpl.key} name={tpl.label} icon={tpl.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-xs font-medium truncate ${added ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-400'}`}>{tpl.label}</span>
                <span className="block text-[10px] text-zinc-400">{templateKindLabel(tpl, t)}{tpl._override ? ' · ' + t('psrc.tpl.edited') : ''}</span>
              </span>
            </button>
          );
        })}
      </div>
      {/* 唯一的添加入口：选已有源加实例 / 或新建自定义源 */}
      <button type="button" onClick={onAdd}
        className="w-full text-xs py-2 rounded-xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
        + {t('psrc.tpl.addSource2')}
      </button>
    </div>
  );
}

// 添加源弹窗：选一个已有源 → 打开该源的编辑弹窗加实例；或点「新建自定义源」走向导
export function SourcePickerModal({ templates, onPick, onNewSource, onClose, t }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-3 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('psrc.tpl.pickSource')}</h3>
        <div className="grid grid-cols-2 gap-2">
          {templates.map(tpl => (
            <button key={tpl.key} type="button" onClick={() => onPick(tpl)}
              className="flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/60 text-left hover:border-blue-300 dark:hover:border-blue-700">
              <ServiceIcon id={tpl.key} name={tpl.label} icon={tpl.icon} />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium truncate text-zinc-800 dark:text-zinc-200">{tpl.label}</span>
                <span className="block text-[10px] text-zinc-400">{templateKindLabel(tpl, t)}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="flex justify-between items-center pt-1">
          <button type="button" onClick={onNewSource}
            className="text-xs px-3 py-1.5 rounded-lg border border-dashed border-blue-300 dark:border-blue-700 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30">
            + {t('psrc.tpl.newCustom')}
          </button>
          <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800">{t('psrc.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

// 基于模板建一个实例（字段与 add* 一致）。供模板编辑弹窗 + 选源弹窗（直接添加）共用。
export function buildInstancePatch(tpl, { payg = [], subs = [], planId } = {}) {
  const key = tpl.key;
  const isPayg = tpl.kind === 'payg';
  const isApiSub = tpl.kind === 'api_sub';
  const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const nextName = (list, kf) => {
    const n = (list || []).filter(x => x[kf] === key).length;
    return n > 0 ? `${tpl.label}_${n + 1}` : tpl.label;
  };
  const tplModels = Object.keys(tpl.pricing || {}).length ? Object.keys(tpl.pricing) : (tpl.models || []);
  if (isPayg) {
    const inst = { id: uid(), provider_id: key, label: tpl.label, name: nextName(payg, 'provider_id'),
      icon: tpl.icon, models: [...tplModels], enabled: true };
    return { user_payg_providers: [...payg, inst] };
  }
  const tplPlans = tpl.plans || [];
  const plan = tplPlans.find(p => p.id === planId) || tplPlans[0] || {};
  const inst = {
    id: uid(), subscription_kind: isApiSub ? 'api' : 'app', source_id: key,
    name: nextName(subs, 'source_id'), agent_id: isApiSub ? null : (tpl.agent_id || null),
    app_name: tpl.label, app_icon: tpl.icon,
    plan_id: plan.id || 'custom', plan_label: plan.label || plan.id || tpl.label,
    monthly_usd: plan.monthly_usd ?? null,
    subscription_to_api: isApiSub ? true : (tpl.subscription_to_api === true),
    ...(isApiSub ? { plan_provider_id: tpl.plan_provider_id || key } : {}),
  };
  return { user_subscriptions: [...subs, inst] };
}

/** 模板是否已配好「支持的模型」（可直接加实例）：payg 看 pricing，订阅看 pricing 或 plan_provider_id */
export function templateReadyForInstance(tpl) {
  if (Object.keys(tpl.pricing || {}).length > 0) return true;
  if (tpl.kind !== 'payg' && tpl.plan_provider_id) return true;
  return (tpl.models || []).length > 0;
}

// ── 第2块：模板编辑弹窗（写 source_template_overrides）──────────────────────────
export function TemplateEditModal({ template, overrides, payg = [], subs = [], customTemplates = {}, paygCatalog = [], onSave, onClose, onInstanceAdded, t }) {
  const key = template.key;
  const cur = overrides[key] || {};
  const isPayg = template.kind === 'payg';
  const isAppSub = template.kind === 'app_sub';
  const isApiSub = template.kind === 'api_sub';
  const isSub = isAppSub || isApiSub;
  const isCustomTpl = template.custom === true;

  const [subToApi, setSubToApi] = useState(template.subscription_to_api === true);
  // 模型+计费：所有模板（含订阅）都配。订阅模板若指向官方 payg，预填其模型作为「支持的模型」。
  const [pricing, setPricing] = useState(() => {
    const base = { ...(template.pricing || {}) };
    if (isSub && template.plan_provider_id && !Object.keys(base).length) {
      const cat = (paygCatalog || []).find(x => (x.provider_id || x.id) === template.plan_provider_id);
      for (const m of (cat?.models || [])) base[m] = (cat?.pricing && cat.pricing[m]) || {};
    }
    return base;
  });

  // 「添加为我的源」：基于模板实例化（字段与 UserAccountsPanel 的 add* 保持一致）
  const tplPlans = template.plans || [];
  const [planId, setPlanId] = useState(tplPlans[0]?.id || '');
  // 所有模板（含订阅）都必须有支持的模型，才能添加实例
  const tplReady = Object.keys(pricing).length > 0;
  const myInstances = isPayg ? payg.filter(p => p.provider_id === key) : subs.filter(s => s.source_id === key);
  function addInstance() {
    // 用编辑中的 pricing / subToApi 作为「有效模板」，复用统一的建实例逻辑
    const effectiveTpl = { ...template, pricing, subscription_to_api: subToApi };
    onSave(buildInstancePatch(effectiveTpl, { payg, subs, planId }));
    onInstanceAdded?.(key);   // 通知父级弹出凭证配置（API key / OAuth）
  }
  function removeInstance(id) {
    if (isPayg) onSave({ user_payg_providers: payg.filter(p => p.id !== id) });
    else onSave({ user_subscriptions: subs.filter(s => s.id !== id) });
  }

  const rows = Object.keys(pricing).map(m => ({ model: m, ...pricing[m] }));
  const onCell = (model, field, val) => setPricing(p => {
    const next = { ...p, [model]: { ...(p[model] || {}) } };
    if (val === '') delete next[model][field]; else next[model][field] = Number(val);
    return next;
  });
  const onAddModel = (m) => setPricing(p => (p[m] ? p : { ...p, [m]: {} }));
  const onRemoveModel = (m) => setPricing(p => { const n = { ...p }; delete n[m]; return n; });

  function save() {
    if (isCustomTpl) {
      // 自定义模板：直接更新模板本身（custom_source_templates）
      const ct = { ...(customTemplates || {}) };
      ct[key] = {
        ...(ct[key] || {}), kind: template.kind, label: template.label, icon: template.icon,
        pricing, models: Object.keys(pricing), plans: tplPlans,
        subscription_to_api: isAppSub ? subToApi : (ct[key]?.subscription_to_api === true),
      };
      onSave({ custom_source_templates: ct });
    } else {
      // 官方模板：写本地覆盖
      const next = { ...overrides };
      const ov = { ...(cur || {}) };
      ov.pricing = pricing;
      if (isAppSub) ov.subscription_to_api = subToApi;
      ov._baseHash = template._serverHash;   // 记录基于哪个服务端模板版本改的（供 diff）
      next[key] = ov;
      onSave({ source_template_overrides: next });
    }
    onClose();
  }
  function reset() {
    if (isCustomTpl) {
      // 自定义模板没有服务端默认 → 删除整个自定义源（模板 + 其实例），删前确认
      const n = payg.filter(p => p.provider_id === key).length + subs.filter(s => s.source_id === key).length;
      if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('psrc.tpl.deleteConfirm', { n }))) return;
      const ct = { ...(customTemplates || {}) };
      delete ct[key];
      onSave({
        custom_source_templates: ct,
        user_payg_providers: payg.filter(p => p.provider_id !== key),
        user_subscriptions: subs.filter(s => s.source_id !== key),
      });
    } else {
      const next = { ...overrides };
      delete next[key];
      onSave({ source_template_overrides: next });
    }
    onClose();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <ServiceIcon id={template.key} name={template.label} icon={template.icon} />
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('psrc.tpl.editTitle', { name: template.label })}</h3>
        </div>
        {isAppSub && (
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" checked={subToApi} onChange={e => setSubToApi(e.target.checked)} />
            {t('psrc.tpl.subToApi')}
          </label>
        )}
        {/* 模型 + 计费：所有模板都配（订阅模板也要有支持的模型才能加实例）*/}
        <div className="space-y-1">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{isSub ? t('psrc.tpl.subModels') : t('psrc.tpl.pricing')}</p>
          <PricingTable rows={rows} onCell={onCell} onAddModel={onAddModel} onRemoveModel={onRemoveModel} t={t} />
        </div>

        {/* 添加为我的源（实例化此模板）*/}
        <div className="space-y-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{t('psrc.tpl.instances')}</p>
          {myInstances.length === 0 && <p className="text-[11px] text-zinc-400">{t('psrc.tpl.noInstance')}</p>}
          {myInstances.map(inst => (
            <div key={inst.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded-lg bg-zinc-50 dark:bg-zinc-800">
              <span className="flex-1 truncate">
                {inst.name || inst.label || inst.app_name}
                {inst.plan_label ? <span className="text-zinc-400"> · {inst.plan_label}</span> : null}
              </span>
              <button type="button" onClick={() => removeInstance(inst.id)} className="text-red-400 hover:text-red-500 px-1">×</button>
            </div>
          ))}
          {!tplReady && <p className="text-[11px] text-amber-500">{t('psrc.tpl.needConfig')}</p>}
          <div className="flex items-center gap-2">
            {isSub && tplPlans.length > 0 && (
              <select value={planId} onChange={e => setPlanId(e.target.value)}
                className="flex-1 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5">
                {tplPlans.map(p => (
                  <option key={p.id} value={p.id}>{p.label}{p.monthly_usd != null ? ` · $${p.monthly_usd}/mo` : ''}</option>
                ))}
              </select>
            )}
            <button type="button" onClick={addInstance} disabled={!tplReady}
              className="text-xs px-3 py-1.5 rounded-lg border border-dashed border-blue-300 dark:border-blue-700 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40 disabled:cursor-not-allowed">
              + {t('psrc.tpl.addInstance')}
            </button>
          </div>
        </div>

        <div className="flex justify-between gap-2 pt-1">
          <button type="button" onClick={reset} className="text-xs text-zinc-400 hover:text-red-500">{isCustomTpl ? t('psrc.tpl.deleteCustom') : t('psrc.tpl.reset')}</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800">{t('psrc.cancel')}</button>
            <button type="button" onClick={save} className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 text-white">{t('psrc.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 第2块：自定义源向导（服务端不支持的源，分步填写）──────────────────────────────
export function CustomSourceWizard({ payg, subs, customTemplates = {}, onSave, onClose, t }) {
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState('payg');     // payg | app_sub | api_sub
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🔧');
  const [subToApi, setSubToApi] = useState(false);
  const [models, setModels] = useState([]);     // 模型名数组（按量）
  const [newModel, setNewModel] = useState('');

  const slug = (name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)) || 'source';
  const canNext = step === 1 ? !!name.trim() : true;

  function finish() {
    const ts = Date.now().toString(36);
    const sid = `custom-${slug}-${ts}`;
    // 1) 建自定义源模板（纯本地，独立于实例）
    const tpl = { kind, label: name.trim(), icon, custom: true };
    if (kind === 'payg') { tpl.models = models.filter(Boolean); tpl.pricing = {}; }
    else { tpl.plans = []; tpl.subscription_to_api = kind === 'api_sub' ? true : subToApi; }
    const patch = { custom_source_templates: { ...(customTemplates || {}), [sid]: tpl } };
    // 2) 同时建第一个实例（引用该模板 key）
    if (kind === 'payg') {
      patch.user_payg_providers = [...(payg || []), {
        id: `ua-${ts}`, provider_id: sid, label: name.trim(), name: name.trim(),
        icon, models: models.filter(Boolean), enabled: true, custom: true,
      }];
    } else {
      patch.user_subscriptions = [...(subs || []), {
        id: `ua-${ts}`, subscription_kind: kind === 'api_sub' ? 'api' : 'app',
        source_id: sid, name: name.trim(), app_name: name.trim(), app_icon: icon,
        plan_id: 'custom', plan_label: name.trim(), monthly_usd: null,
        subscription_to_api: kind === 'api_sub' ? true : subToApi, custom: true,
      }];
    }
    onSave(patch);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('psrc.wiz.title')} · {step}/2</h3>
        {step === 1 && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-zinc-400 block mb-1">{t('psrc.wiz.kind')}</label>
              <select value={kind} onChange={e => setKind(e.target.value)}
                className="w-full text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2">
                <option value="payg">{t('psrc.kind.payg')}</option>
                <option value="app_sub">{t('psrc.kind.appSub')}</option>
                <option value="api_sub">{t('psrc.kind.apiSub')}</option>
              </select>
            </div>
            <div className="flex gap-2">
              <input value={icon} onChange={e => setIcon(e.target.value)} className="w-14 text-center text-base bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2" />
              <input value={name} onChange={e => setName(e.target.value)} placeholder={t('psrc.wiz.namePh')}
                className="flex-1 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2" />
            </div>
          </div>
        )}
        {step === 2 && kind === 'payg' && (
          <div className="space-y-2">
            <p className="text-xs text-zinc-500">{t('psrc.wiz.models')}</p>
            <div className="flex flex-wrap gap-1">
              {models.map((m, i) => (
                <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 font-mono">
                  {m}<button type="button" onClick={() => setModels(models.filter((_, j) => j !== i))} className="text-red-400">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder={t('psrc.addModelPh')}
                className="flex-1 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 font-mono" />
              <button type="button" disabled={!newModel.trim()} onClick={() => { setModels([...models, newModel.trim()]); setNewModel(''); }}
                className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-700 disabled:opacity-50">+ {t('psrc.add')}</button>
            </div>
            <p className="text-[10px] text-zinc-400">{t('psrc.wiz.priceNote')}</p>
          </div>
        )}
        {step === 2 && kind === 'app_sub' && (
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" checked={subToApi} onChange={e => setSubToApi(e.target.checked)} />
            {t('psrc.tpl.subToApi')}
          </label>
        )}
        {step === 2 && kind === 'api_sub' && <p className="text-xs text-zinc-400">{t('psrc.wiz.apiSubNote')}</p>}
        <div className="flex justify-between gap-2 pt-1">
          <button type="button" onClick={() => step === 1 ? onClose() : setStep(1)} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800">
            {step === 1 ? t('psrc.cancel') : t('psrc.wiz.back')}
          </button>
          {step === 1
            ? <button type="button" disabled={!canNext} onClick={() => setStep(2)} className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 text-white disabled:opacity-50">{t('psrc.wiz.next')}</button>
            : <button type="button" onClick={finish} className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 text-white">{t('psrc.wiz.create')}</button>}
        </div>
      </div>
    </div>
  );
}

// ── 同步差异 Banner ────────────────────────────────────────────────────────────
export function SyncDiffBanner({ syncDiff, onAdoptServer, onDismissDrift, t }) {
  const migrations = syncDiff?.migrations || [];
  const drifts = syncDiff?.overrideDrifts || [];
  if (!migrations.length && !drifts.length) return null;
  return (
    <div className="space-y-2">
      {migrations.map(m => (
        <div key={m.instanceId} className="text-xs px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/40">
          {t('psrc.diff.migrate', { name: m.label })}
        </div>
      ))}
      {drifts.map(d => (
        <div key={d.templateKey} className="text-xs px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40 space-y-1">
          <div className="font-medium">{t('psrc.diff.drift', { name: d.label })}{d.serverChanged ? ' · ' + t('psrc.diff.serverChanged') : ''}</div>
          <ul className="ml-3 list-disc space-y-0.5">
            {d.changedFields.map((f, i) => (
              <li key={i}>{f.field}{f.model ? `(${f.model})` : ''}: {t('psrc.diff.mine')} {JSON.stringify(f.mine)} / {t('psrc.diff.server')} {JSON.stringify(f.server)}</li>
            ))}
          </ul>
          <div className="flex gap-2 pt-0.5">
            <button type="button" onClick={() => onAdoptServer(d.templateKey)} className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-800/40">{t('psrc.diff.adopt')}</button>
            <button type="button" onClick={() => onDismissDrift(d.templateKey)} className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">{t('psrc.diff.keep')}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
