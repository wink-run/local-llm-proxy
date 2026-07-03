// 个人源体系 UI 组件集（账户统计 / 源模板库 / 个人源双视图 / 同步差异）。
// 数据来自 IPC getUserAccounts（billing-config）：account_stats / source_templates /
// direct_source_instances / sync_diff / user_subscriptions / user_payg_providers。
// 保存统一走父级传入的 onSave(patch)（= saveAccounts），写 source_template_overrides /
// direct_source_billing / user_payg_providers 等字段。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../store/lang';
import { useCurrency } from '../store/currency';
import { getGateway, isElectron } from '../api/adapter';
import ServiceIcon from './ServiceIcon';
import { resolveBrandIcon } from '../lib/brandIcons';

const INVALID_MODEL_NAMES = new Set(['_excluded_models', 'excluded_models']);

/** 模型名（字符串或 { name/id } 对象） */
function modelEntryName(m) {
  let n = '';
  if (typeof m === 'string') n = m.trim();
  else n = String(m?.name || m?.id || '').trim();
  return n && !INVALID_MODEL_NAMES.has(n) ? n : '';
}

/** 供给源 logo 去重键：同一 provider 多账户只显示一个图标 */
function providerDedupKey(inst) {
  const hay = `${inst.source_id || inst.provider_id || ''} ${inst.gateway_id || ''} ${inst.label || inst.name || ''}`;
  const brand = resolveBrandIcon(hay);
  if (brand) return brand;
  return String(inst.source_id || inst.provider_id || inst.gateway_id || inst.id || '');
}

function dedupeByProvider(insts) {
  const seen = new Set();
  const out = [];
  for (const inst of insts) {
    const k = providerDedupKey(inst);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(inst);
  }
  return out;
}

/** 供给源 logo（紧凑图标，hover 显示名称） */
function SourceProviderLogo({ inst }) {
  const name = inst.name || inst.label || inst.source_id;
  const brand = resolveBrandIcon(`${inst.source_id || inst.provider_id || ''} ${name || ''}`);
  return (
    <span title={name} className="inline-flex items-center justify-center w-4 h-4 shrink-0">
      {brand
        ? <img src={brand} alt="" className="w-3.5 h-3.5 object-contain" draggable={false} />
        : <span className="text-[10px] leading-none">{inst.icon || '🔧'}</span>}
    </span>
  );
}

const PRICE_FIELDS = ['in', 'out', 'cacheRead'];

/** 从刊例价字段推断模态（图像模型仅有 image 价） */
export function inferModalityFromPricing(rates = {}) {
  if (!rates || typeof rates !== 'object') return 'chat';
  if (rates.image != null && rates.in == null && rates.out == null && rates.cacheRead == null) return 'image';
  return 'chat';
}

/** 各模态对应的刊例价字段 */
export function priceFieldsForModality(type) {
  if (type === 'image') return ['image'];
  if (type === 'embedding') return ['in', 'out'];
  return PRICE_FIELDS;
}

/** 计费表格列头/占位：图像按张，其余按百万 Token */
export function priceFieldLabel(field, type, t) {
  if (field === 'image') return t('providers.billing.priceImage');
  return field;
}

/** 模型模态短标签（文/图/嵌），供供给源页与路由下拉复用 */
export function modelTypeLabel(type, t) {
  if (type === 'image') return t('providers.models.typeImage');
  if (type === 'embedding') return t('providers.models.typeEmbedding');
  return t('providers.models.typeText');
}

export function modelTypeBtnClass(type) {
  if (type === 'image') {
    return 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-800/60';
  }
  if (type === 'embedding') {
    return 'bg-teal-50 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-900/40';
  }
  return 'bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40';
}

/** 计费表格（模型 → 模态相关刊例价字段）。图像：image（$/张）；对话：in/out/cacheRead；嵌入：in/out。 */
export function PricingTable({
  rows, onCell, onAddModel, onRemoveModel, t,
  withModality = false, modelTypes = {}, onToggleType,
}) {
  const [newModel, setNewModel] = useState('');
  const [inputType, setInputType] = useState('chat');
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
  const resolveType = (name, row) => modelTypes[name] || row?.type || 'chat';

  // 带模态：每行按类型渲染不同价格列（与服务端 admin 表单一致）
  if (withModality) {
    return (
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="min-w-[17rem] space-y-1.5">
          <div className="flex gap-1.5 text-[10px] text-zinc-400 px-0.5">
            <span className="flex-1 min-w-0">{t('psrc.model')}</span>
            <span className="w-7 text-center shrink-0">{t('providers.models.modalityCol')}</span>
            <span className="flex-[3] text-right">{t('providers.billing.priceCol')}</span>
            <span className="w-4 shrink-0" />
          </div>
          {rows.length === 0 && (
            <p className="text-xs text-zinc-400 py-1.5 text-center">{t('psrc.noModels')}</p>
          )}
          {rows.map(r => {
            const mType = resolveType(r.model, r);
            const fields = priceFieldsForModality(mType);
            return (
              <div key={r.model} className={`flex gap-1.5 items-start ${r._override ? 'bg-amber-50/50 dark:bg-amber-900/10 rounded px-0.5 py-0.5' : ''}`}>
                <span className="flex-1 min-w-0 text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all leading-snug px-0.5 py-0.5" title={r.model}>
                  {r.model}
                </span>
                {onToggleType && (
                  <button
                    type="button"
                    onClick={() => onToggleType(r.model)}
                    title={t('providers.models.toggleType')}
                    className={`shrink-0 w-7 h-6 flex items-center justify-center text-[10px] font-sans rounded border border-zinc-200 dark:border-zinc-700 transition-colors ${modelTypeBtnClass(mType)}`}
                  >
                    {modelTypeLabel(mType, t)}
                  </button>
                )}
                <div className="flex flex-1 gap-1 min-w-0 justify-end">
                  {fields.map(f => (
                    <input
                      key={f}
                      type="text"
                      inputMode="decimal"
                      value={cellVal(r.model, f, r[f])}
                      placeholder={priceFieldLabel(f, mType, t)}
                      title={priceFieldLabel(f, mType, t)}
                      onChange={e => onInput(r.model, f, e.target.value)}
                      onBlur={e => onCommit(r.model, f, e.target.value)}
                      className="text-xs text-right bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1 py-1 w-full min-w-[2.5rem] max-w-[4.5rem] tabular-nums"
                    />
                  ))}
                </div>
                {onRemoveModel
                  ? <button type="button" onClick={() => onRemoveModel(r.model)} className="shrink-0 text-xs text-red-400 hover:text-red-500 pt-1 w-4">×</button>
                  : <span className="w-4 shrink-0" />}
              </div>
            );
          })}
          {onAddModel && (
            <div className="flex flex-wrap gap-1.5 pt-1 items-center">
              <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder={t('psrc.addModelPh')}
                className="flex-1 min-w-[8rem] text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 font-mono" />
              <select value={inputType} onChange={e => setInputType(e.target.value)}
                className="shrink-0 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-1 text-zinc-700 dark:text-zinc-300">
                <option value="chat">{t('providers.models.chat')}</option>
                <option value="image">{t('providers.models.image')}</option>
                <option value="embedding">{t('providers.models.embedding')}</option>
              </select>
              <button type="button" disabled={!newModel.trim()}
                onClick={() => {
                  if (newModel.trim()) {
                    onAddModel(newModel.trim(), inputType);
                    setNewModel('');
                  }
                }}
                className="shrink-0 text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-700 disabled:opacity-50 whitespace-nowrap">
                + {t('providers.models.add')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const rowGrid = 'grid-cols-[minmax(0,1fr)_repeat(3,minmax(2.5rem,3rem))_1.25rem]';

  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <div className={`min-w-[17rem] space-y-1.5 ${withModality ? 'min-w-[20rem]' : ''}`}>
      <div className={`grid ${rowGrid} gap-x-1.5 gap-y-0.5 text-[10px] text-zinc-400 px-0.5`}>
        <span className="min-w-0">{t('psrc.model')}</span>
        {withModality && <span className="text-center">{t('providers.models.modalityCol')}</span>}
        {PRICE_FIELDS.map(f => <span key={f} className="text-right tabular-nums">{f}</span>)}
        <span />
      </div>
      {rows.length === 0 && (
        <p className="text-xs text-zinc-400 py-1.5 text-center">{t('psrc.noModels')}</p>
      )}
      {rows.map(r => {
        const mType = resolveType(r.model, r);
        return (
          <div key={r.model} className={`grid ${rowGrid} gap-x-1.5 gap-y-0.5 items-start ${r._override ? 'bg-amber-50/50 dark:bg-amber-900/10 rounded px-0.5 py-0.5' : ''}`}>
            <span
              className="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all leading-snug px-0.5 py-0.5 min-w-0"
              title={r.model}
            >
              {r.model}
            </span>
            {withModality && onToggleType && (
              <button
                type="button"
                onClick={() => onToggleType(r.model)}
                title={t('providers.models.toggleType')}
                className={`shrink-0 w-7 h-6 flex items-center justify-center text-[10px] font-sans rounded border border-zinc-200 dark:border-zinc-700 transition-colors ${modelTypeBtnClass(mType)}`}
              >
                {modelTypeLabel(mType, t)}
              </button>
            )}
            {PRICE_FIELDS.map(f => (
              <input key={f} type="text" inputMode="decimal" value={cellVal(r.model, f, r[f])} placeholder="—"
                onChange={e => onInput(r.model, f, e.target.value)}
                onBlur={e => onCommit(r.model, f, e.target.value)}
                className="text-xs text-right bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1 py-1 w-full tabular-nums min-w-0" />
            ))}
            {onRemoveModel
              ? <button type="button" onClick={() => onRemoveModel(r.model)} className="text-xs text-red-400 hover:text-red-500 pt-1">×</button>
              : <span />}
          </div>
        );
      })}
      {onAddModel && (
        <div className="flex flex-wrap gap-1.5 pt-1 items-center">
          <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder={t('psrc.addModelPh')}
            className="flex-1 min-w-[8rem] text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 font-mono" />
          {withModality && (
            <select value={inputType} onChange={e => setInputType(e.target.value)}
              className="shrink-0 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-1 text-zinc-700 dark:text-zinc-300">
              <option value="chat">{t('providers.models.chat')}</option>
              <option value="image">{t('providers.models.image')}</option>
              <option value="embedding">{t('providers.models.embedding')}</option>
            </select>
          )}
          <button type="button" disabled={!newModel.trim()}
            onClick={() => {
              if (newModel.trim()) {
                onAddModel(newModel.trim(), withModality ? inputType : undefined);
                setNewModel('');
              }
            }}
            className="shrink-0 text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-700 disabled:opacity-50 whitespace-nowrap">
            + {withModality ? t('providers.models.add') : t('psrc.add')}
          </button>
        </div>
      )}
      </div>
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

/** 可折叠「模型和计费」区块，默认收起 */
export function CollapsibleBillingPanel({ hint, summary, t, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-zinc-100 dark:border-zinc-800 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{t('providers.billing.section')}</span>
          {!open && summary && (
            <span className="text-[11px] text-zinc-400 truncate">{summary}</span>
          )}
        </div>
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
          className="text-xs px-2.5 py-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors shrink-0">
          {open ? t('providers.models.collapse') : t('providers.models.expand')}
        </button>
      </div>
      {open && (
        <div className="space-y-3 mt-3">
          {hint && <p className="text-[11px] text-zinc-400">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

// ── 第3块：直连源卡（与其它供给源卡片同风格，编辑自动保存）────────────────────────
export function DirectSourceCard({
  instance, onSave, onRemove, allowApiBilling = false, canConvertToApi = false, onConvertToApi, t,
}) {
  const baseMonthly = instance.monthly_usd != null ? String(instance.monthly_usd) : '';
  const basePricing = instance.pricing || {};
  const baseApi = allowApiBilling && instance.mode === 'api';
  const [monthly, setMonthly] = useState(baseMonthly);
  const [pricing, setPricing] = useState(basePricing);
  const [isApi, setIsApi] = useState(baseApi);
  const [removing, setRemoving] = useState(false);
  const [converting, setConverting] = useState(false);
  const saveTimer = useRef(null);
  const savingRef = useRef(false);

  const sig = `${baseMonthly}|${JSON.stringify(basePricing)}|${baseApi}`;
  const sigRef = useRef(sig);
  useEffect(() => {
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    if (savingRef.current) return;
    setMonthly(baseMonthly);
    setPricing(basePricing);
    setIsApi(baseApi);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  useEffect(() => {
    if (!allowApiBilling && isApi) setIsApi(false);
  }, [allowApiBilling, isApi]);

  const rows = Object.keys(pricing).map(m => ({ model: m, ...pricing[m] }));
  const hasPricing = !!instance.has_pricing;
  // Cursor 等不可转 API 的 App 订阅：仅说明直连官方，不单独罗列模型名
  const isDirectAppSub = !canConvertToApi && !isApi;

  function buildPatch(m, p, a) {
    const num = m.trim() === '' ? null : Number(m);
    const billing = { ...(instance._allBilling || {}) };
    billing[instance.agent_id] = {
      ...(billing[instance.agent_id] || {}),
      mode: (allowApiBilling && a) ? 'api' : 'subscription',
      monthly_usd: (num != null && Number.isFinite(num)) ? num : null,
      pricing: allowApiBilling && a ? p : {},
    };
    return { direct_source_billing: billing };
  }

  const flushSave = async (m, p, a) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    savingRef.current = true;
    try { await onSave(buildPatch(m, p, a)); }
    finally { savingRef.current = false; }
  };

  const scheduleSave = (m, p, a) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushSave(m, p, a), 400);
  };

  const onCell = (model, field, val) => {
    const next = { ...pricing, [model]: { ...(pricing[model] || {}) } };
    if (val === '' || val == null) delete next[model][field];
    else { const num = Number(val); if (Number.isFinite(num)) next[model][field] = num; }
    setPricing(next);
    scheduleSave(monthly, next, isApi);
  };
  const onAddModel = (m) => {
    if (pricing[m]) return;
    const next = { ...pricing, [m]: {} };
    setPricing(next);
    scheduleSave(monthly, next, isApi);
  };
  const onRemoveModel = (m) => {
    const next = { ...pricing };
    delete next[m];
    setPricing(next);
    scheduleSave(monthly, next, isApi);
  };

  const doRemove = async () => {
    if (!onRemove) return;
    setRemoving(true);
    try { await onRemove(instance); }
    finally { setRemoving(false); }
  };

  const doConvert = async () => {
    if (!onConvertToApi) return;
    setConverting(true);
    try { await onConvertToApi(instance); }
    finally { setConverting(false); }
  };

  const toggleMode = () => {
    const nv = !isApi;
    setIsApi(nv);
    flushSave(monthly, pricing, nv);
  };

  const billingSummary = (() => {
    const parts = [];
    if (!isApi && monthly.trim()) parts.push(`$${monthly.trim()}${t('psrc.direct.monthlyUnit')}`);
    if (allowApiBilling && isApi && rows.length) parts.push(t('providers.billing.modelCount', { n: rows.length }));
    return parts.join(' · ') || null;
  })();

  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
      <div className="flex items-start gap-3 p-3.5">
        <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-[15px] shrink-0 mt-0.5">
          <ServiceIcon id={instance.source_id} name={instance.label} icon={instance.icon} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{instance.name}</span>
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-md border shrink-0 bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/50" title={t('providers.filter.appSub')}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" className="w-3 h-3" aria-hidden>
                  <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
                  <circle cx="8" cy="8" r="2" />
                </svg>
              </span>
            </div>
            {onRemove && (
              <button type="button" onClick={doRemove} disabled={removing}
                title={t('providers.custom.removeTitle')}
                className="text-zinc-400 hover:text-red-500 dark:hover:text-red-400 text-lg leading-none transition-colors disabled:opacity-40 shrink-0">×</button>
            )}
          </div>
          {!hasPricing && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">⚠ {t('psrc.direct.noPricing')}</p>
          )}
          {canConvertToApi && onConvertToApi && (
            <div className="mt-2">
              <button type="button" onClick={doConvert} disabled={converting || removing}
                className="text-xs px-2.5 py-1 rounded-lg border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40">
                {converting ? t('psrc.direct.converting') : t('psrc.direct.convertToApi')}
              </button>
            </div>
          )}
        </div>
      </div>

      <CollapsibleBillingPanel
        t={t}
        summary={billingSummary}
        hint={isDirectAppSub ? t('psrc.direct.officialModelsHint') : (isApi ? t('psrc.direct.apiTitle') : t('psrc.direct.subTitle'))}
      >
        <div className="flex flex-wrap items-center gap-2">
          {!isApi && (
            <>
              <span className="text-xs text-zinc-400">$</span>
              <input type="text" inputMode="decimal" value={monthly} placeholder="0"
                onChange={e => { const v = e.target.value; setMonthly(v); scheduleSave(v, pricing, isApi); }}
                onBlur={() => flushSave(monthly, pricing, isApi)}
                className="w-24 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 tabular-nums" />
              <span className="text-xs text-zinc-400">{t('psrc.direct.monthlyUnit')}</span>
            </>
          )}
          {allowApiBilling && (
            <button type="button" onClick={toggleMode}
              className={`text-xs ${isApi ? '' : 'ml-auto'} text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300`}>
              {isApi ? t('psrc.direct.switchSub') : t('psrc.direct.switchApi')}
            </button>
          )}
        </div>
        {allowApiBilling && isApi && (
          <PricingTable rows={rows} onCell={onCell} onAddModel={onAddModel} onRemoveModel={onRemoveModel} t={t} />
        )}
      </CollapsibleBillingPanel>
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

/** 账户实例可能对应的网关 provider_id（与 local-stats 落账字段对齐） */
function accountProviderIds(inst) {
  const raw = [
    inst.gateway_id,
    inst.provider_id,
    inst.source_id,
    inst.id,
    inst.id ? `acct-${String(inst.id).replace(/^acct-/, '')}` : null,
  ].filter(Boolean);
  return [...new Set(raw.map(String))];
}

/** 在延迟表里查找模型（兼容大小写 / 带前缀别名） */
function providerLatencyMap(latencyMap, model) {
  if (!latencyMap || !model) return null;
  if (latencyMap[model]) return latencyMap[model];
  const lower = model.toLowerCase();
  for (const key of Object.keys(latencyMap)) {
    if (key.toLowerCase() === lower) return latencyMap[key];
    if (key.endsWith(`/${model}`) || key.endsWith(`/${lower}`)) return latencyMap[key];
  }
  return null;
}

/** 读取某模型在某账户上的最近延迟（多 id 别名时取时间最新的一条） */
function resolveAccountLatencyRow(latencyMap, model, inst) {
  const pmap = providerLatencyMap(latencyMap, model);
  if (!pmap) return null;
  let best = null;
  for (const pid of accountProviderIds(inst)) {
    const row = pmap[pid];
    if (!row) continue;
    const ts = row.last_ts || 0;
    const ttft = row.last_ttft_ms > 0 ? row.last_ttft_ms : (row.avg_ttft_ms > 0 ? row.avg_ttft_ms : 0);
    if (ttft <= 0) continue;
    if (!best || ts > best.ts) {
      best = { ts, ttft };
    }
  }
  return best;
}

function resolveAccountTtft(latencyMap, model, inst) {
  return resolveAccountLatencyRow(latencyMap, model, inst)?.ttft ?? null;
}

function accountDisplayName(inst) {
  return inst.name || inst.label || inst.plan_label || inst.source_id || inst.gateway_id || inst.provider_id || '—';
}

// ── 第3块：按模型视图（仿社区源 P2P 网格：一行两列，左模型、右供给源 logo）────────
export function PersonalSourceModelView({
  instances, t, trailing = null, onEmptyAdd = null, modelTypeMap = {},
  latencyMap: latencyMapProp = null, onRefreshLatency = null,
}) {
  const [expandedModel, setExpandedModel] = useState(null);
  const [latencyMapLocal, setLatencyMapLocal] = useState({});
  const latencyMap = latencyMapProp ?? latencyMapLocal;

  const loadLatency = useCallback(async () => {
    if (onRefreshLatency) {
      onRefreshLatency();
      return;
    }
    try {
      const map = await getGateway().getModelProviderLatency(7);
      if (map && typeof map === 'object') setLatencyMapLocal({ ...map });
    } catch { /* 网关未就绪时忽略 */ }
  }, [onRefreshLatency]);

  // 无父级注入时自行拉取
  useEffect(() => {
    if (latencyMapProp) return undefined;
    loadLatency();
    const fast = expandedModel ? 5000 : 30000;
    const id = setInterval(loadLatency, fast);
    return () => clearInterval(id);
  }, [loadLatency, expandedModel, latencyMapProp]);

  useEffect(() => {
    if (latencyMapProp || !isElectron() || !window.electronAPI?.localStats?.onChanged) return undefined;
    return window.electronAPI.localStats.onChanged(loadLatency);
  }, [loadLatency, latencyMapProp]);

  useEffect(() => {
    if (expandedModel) loadLatency();
  }, [expandedModel, loadLatency]);

  const byModel = useMemo(() => {
    const m = {};
    for (const inst of instances) {
      const modelList = (inst.models || []).map(modelEntryName).filter(Boolean);
      if (!modelList.length) continue;
      for (const model of modelList) {
        const list = m[model] || (m[model] = []);
        const uid = inst.id || inst.agent_id || inst.source_id;
        if (!list.some(x => (x.id || x.agent_id || x.source_id) === uid)) list.push(inst);
      }
    }
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [instances]);

  // 参与供给的账户（按 provider 去重 logo），统计仍用全部账户数
  const uniqueProviders = useMemo(() => {
    const withModels = instances.filter(inst =>
      (inst.models || []).map(modelEntryName).filter(Boolean).length > 0,
    );
    return dedupeByProvider(withModels);
  }, [instances]);

  const accountCount = useMemo(() => {
    return instances.filter(inst =>
      (inst.models || []).map(modelEntryName).filter(Boolean).length > 0,
    ).length;
  }, [instances]);

  if (byModel.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <p className="text-xs text-zinc-400">
            {t('psrc.model.empty')}
            {onEmptyAdd && (
              <>
                ，
                <button type="button" onClick={onEmptyAdd}
                  className="text-blue-500 dark:text-blue-400 hover:underline">
                  {t('psrc.model.emptyAdd')}
                </button>
              </>
            )}
          </p>
          {trailing}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          {uniqueProviders.length > 0 && (
            <div className="flex items-center -space-x-1 shrink-0">
              {uniqueProviders.map((s, i) => (
                <span
                  key={providerDedupKey(s) + ':' + i}
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-50 dark:bg-zinc-900 ring-1 ring-zinc-200 dark:ring-zinc-700"
                >
                  <SourceProviderLogo inst={s} />
                </span>
              ))}
            </div>
          )}
          <span className="text-xs text-zinc-500 truncate">
            {t('psrc.modelView.summary', { accounts: accountCount, models: byModel.length })}
          </span>
        </div>
        {trailing}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {byModel.map(([model, srcs]) => {
          const verified = srcs.some(s => s.test_verified === true);
          const mType = modelTypeMap[model];
          const ttftList = srcs.map(s => resolveAccountTtft(latencyMap, model, s)).filter(v => v > 0);
          const fastMs = ttftList.length ? Math.min(...ttftList) : null;
          const sortedSrcs = [...srcs].sort((a, b) => {
            const ta = resolveAccountTtft(latencyMap, model, a) ?? 999999;
            const tb = resolveAccountTtft(latencyMap, model, b) ?? 999999;
            return ta - tb;
          });
          return (
          <div key={model} className="min-w-0">
            <button
              type="button"
              onClick={() => setExpandedModel(prev => (prev === model ? null : model))}
              className={`w-full bg-zinc-100 dark:bg-zinc-800 border rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-1.5 min-w-0 text-left transition-colors ${
                expandedModel === model
                  ? 'border-blue-400/60 dark:border-blue-500/50'
                  : 'border-zinc-300/50 dark:border-zinc-700/50 hover:border-zinc-400/70 dark:hover:border-zinc-600/70'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${verified ? 'bg-green-500' : 'bg-zinc-400 dark:bg-zinc-500'}`}
                  aria-hidden
                  title={verified ? t('providers.badge.verified') : t('providers.badge.needsConfig')}
                />
                <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate" title={model}>{model}</span>
                {mType && mType !== 'chat' && (
                  <span
                    className={`shrink-0 text-[9px] font-sans leading-none px-1 py-px rounded border border-transparent ${modelTypeBtnClass(mType)}`}
                    title={mType === 'image' ? t('providers.models.image') : t('providers.models.embedding')}
                  >
                    {modelTypeLabel(mType, t)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                {srcs.map((s, i) => (
                  <SourceProviderLogo key={(s.id || s.agent_id || s.source_id) + ':' + i} inst={s} />
                ))}
                {fastMs != null && (
                  <span className="text-[10px] text-zinc-400 tabular-nums ml-0.5">
                    {t('providers.p2p.ttftShort', { s: (fastMs / 1000).toFixed(1) })}
                  </span>
                )}
                <span className="text-[10px] text-zinc-400">{expandedModel === model ? '▾' : '▸'}</span>
              </div>
            </button>
            {expandedModel === model && (
              <div className="mt-1 ml-1 pl-2 border-l border-zinc-200 dark:border-zinc-700 space-y-1">
                {sortedSrcs.map((inst, i) => {
                  const row = resolveAccountLatencyRow(latencyMap, model, inst);
                  return (
                    <div
                      key={(inst.id || inst.agent_id || inst.source_id) + ':' + i}
                      className="flex items-center justify-between gap-2 text-[10px] text-zinc-500 dark:text-zinc-400"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <SourceProviderLogo inst={inst} />
                        <span className="truncate text-zinc-700 dark:text-zinc-300">{accountDisplayName(inst)}</span>
                      </div>
                      <span className="shrink-0 tabular-nums text-right">
                        {row?.ttft != null
                          ? t('providers.p2p.lastTtft', { ms: Math.round(row.ttft) })
                          : t('providers.p2p.noTtftYet')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 第2块：源模板库网格（彩/灰均可点编辑）────────────────────────────────────────
function templateKindLabel(tpl, t) {
  const base = tpl.kind === 'payg' ? t('psrc.kind.payg') : tpl.kind === 'api_sub' ? t('psrc.kind.apiSub') : t('psrc.kind.appSub');
  return tpl.custom ? `${base} · ${t('psrc.tpl.customTag')}` : base;
}

export function SourceTemplateGrid({
  templates, addedKeys, onEdit, onAdd, t,
  hintKey = 'psrc.tpl.hint', showAdd = true,
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">{t(hintKey)}</p>
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
      {/* 完整个人页：选源加实例 */}
      {showAdd && onAdd && (
        <button type="button" onClick={onAdd}
          className="w-full text-xs py-2 rounded-xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          + {t('psrc.tpl.addSource2')}
        </button>
      )}
    </div>
  );
}

// 添加源弹窗：选一个已有源 → 打开该源的编辑弹窗加实例
export function SourcePickerModal({ templates, onPick, onClose, t }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-3 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('psrc.tpl.pickSource')}</h3>
        <p className="text-[11px] text-zinc-400">{t('psrc.tpl.pickHint')}</p>
        <div className="grid grid-cols-2 gap-2">
          {templates.map(tpl => {
            const ready = templateReadyForInstance(tpl);   // 没配模型的(灰)点击去配置
            return (
              <button key={tpl.key} type="button" onClick={() => onPick(tpl)}
                title={ready ? '' : t('psrc.tpl.needConfig')}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition
                  ${ready ? 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/60 hover:border-blue-300 dark:hover:border-blue-700'
                          : 'border-dashed border-zinc-200 dark:border-zinc-700 bg-zinc-50/40 dark:bg-zinc-800/20'}`}>
                <span className={ready ? '' : 'grayscale opacity-50'}>
                  <ServiceIcon id={tpl.key} name={tpl.label} icon={tpl.icon} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-xs font-medium truncate ${ready ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-400'}`}>{tpl.label}</span>
                  <span className="block text-[10px] text-zinc-400">
                    {templateKindLabel(tpl, t)}{ready ? '' : ' · ' + t('psrc.tpl.needConfigTag')}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end pt-1">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800">{t('psrc.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

// 基于模板建一个实例（字段与 add* 一致）。供模板编辑弹窗 + 选源弹窗（直接添加）共用。
const OAUTH_SUB_TO_GW = { claude: 'anthropic-paid', codex: 'openai', copilot: 'github-copilot' };

function collectUsedGatewayIds(payg = [], subs = []) {
  const ids = new Set();
  for (const p of payg) {
    if (p.gateway_id) ids.add(p.gateway_id);
    else if (p.provider_id) ids.add(p.provider_id);
  }
  for (const s of subs) {
    if (s.gateway_id) ids.add(s.gateway_id);
    else if (s.source_id) ids.add(s.source_id);
  }
  return ids;
}

function allocateGatewayId(baseId, used, instanceId) {
  if (baseId && !used.has(baseId)) return baseId;
  return `acct-${instanceId}`;
}

function baseGatewayForPayg(providerId) {
  return providerId;
}

function baseGatewayForSubTpl(tpl, isApiSub) {
  if (isApiSub) return tpl.plan_provider_id || tpl.key;
  if (tpl.custom) return tpl.key;
  if (tpl.subscription_to_api) return OAUTH_SUB_TO_GW[tpl.key] || tpl.plan_provider_id || tpl.key;
  return tpl.key;
}

/** 解析账户实例添加时间（毫秒），用于列表按添加顺序排列 */
export function accountInstanceAddedOrder(inst, directBilling = {}) {
  const toMs = (v) => {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? NaN : t;
  };
  const fromAddedAt = toMs(inst?.added_at);
  if (!Number.isNaN(fromAddedAt)) return fromAddedAt;
  if (inst?.kind === 'direct' && inst?.id) {
    const fromBill = toMs(directBilling[inst.id]?.added_at);
    if (!Number.isNaN(fromBill)) return fromBill;
  }
  // 新实例 id 前缀为 Date.now().toString(36)，可回退解析
  const id = String(inst?.id || inst?.agent_id || '').replace(/^acct-/, '');
  const prefix = id.match(/^([0-9a-z]+)/i)?.[1];
  if (prefix) {
    const n = parseInt(prefix, 36);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

export function buildInstancePatch(tpl, { payg = [], subs = [], planId } = {}) {
  const key = tpl.key;
  const isPayg = tpl.kind === 'payg';
  const isApiSub = tpl.kind === 'api_sub';
  const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const addedAt = Date.now();
  const nextName = (list, kf) => {
    const n = (list || []).filter(x => x[kf] === key).length;
    return n > 0 ? `${tpl.label}_${n + 1}` : tpl.label;
  };
  const usedGw = collectUsedGatewayIds(payg, subs);
  if (isPayg) {
    const instId = uid();
    const gateway_id = allocateGatewayId(baseGatewayForPayg(key), usedGw, instId);
    // 从服务端模板预填模型（保留模态信息）
    const seedModels = [];
    for (const m of tpl.models || []) {
      if (typeof m === 'string') {
        const mt = tpl.model_types?.[m] || 'chat';
        seedModels.push(mt === 'chat' ? m : { name: m, type: mt });
      } else if (m && typeof m === 'object') {
        const name = m.name || m.id;
        if (name) seedModels.push({ name, type: m.type || m.modality || 'chat' });
      }
    }
    const inst = {
      id: instId, provider_id: key, gateway_id, label: tpl.label,
      name: nextName(payg, 'provider_id'), icon: tpl.icon, models: seedModels, enabled: true,
      added_at: addedAt,
    };
    return { user_payg_providers: [...payg, inst] };
  }
  const tplPlans = tpl.plans || [];
  const plan = tplPlans.find(p => p.id === planId) || tplPlans[0] || {};
  const instId = uid();
  const needsGateway = isApiSub || tpl.subscription_to_api === true;
  const gateway_id = needsGateway
    ? allocateGatewayId(baseGatewayForSubTpl(tpl, isApiSub), usedGw, instId)
    : `acct-${instId}`;
  const inst = {
    id: instId, subscription_kind: isApiSub ? 'api' : 'app', source_id: key, gateway_id,
    name: nextName(subs, 'source_id'), agent_id: isApiSub ? null : (tpl.agent_id || null),
    app_name: tpl.label, app_icon: tpl.icon,
    plan_id: plan.id || 'custom', plan_label: plan.label || plan.id || tpl.label,
    monthly_usd: plan.monthly_usd ?? null,
    subscription_to_api: isApiSub ? true : (tpl.subscription_to_api === true),
    models: [], // 新建时不预填 catalog 模型，由用户在卡片上添加
    ...(isApiSub ? { plan_provider_id: tpl.plan_provider_id || key } : {}),
    added_at: addedAt,
  };
  return { user_subscriptions: [...subs, inst] };
}

/** 纯 APP 订阅（不可转 API）→ 写入直连源计费，在个人源页「直连源」区展示 */
export function buildDirectSourcePatch(tpl, { billing = {}, planId } = {}) {
  const agentId = tpl.agent_id || tpl.key;
  if (!agentId) return {};
  const plans = tpl.plans || [];
  const plan = (planId && plans.find(p => p.id === planId)) || plans[0] || {};
  return {
    direct_source_billing: {
      ...(billing || {}),
      [agentId]: {
        ...((billing || {})[agentId] || {}),
        mode: 'subscription',
        monthly_usd: plan.monthly_usd ?? null,
        name: tpl.label || agentId,
        plan_id: plan.id || null,
        plan_label: plan.label || null,
        source_id: tpl.key,
        added_at: ((billing || {})[agentId]?.added_at) ?? Date.now(),
      },
    },
  };
}

/** 删除直连源：清除计费登记 */
export function buildDirectSourceRemovePatch(agentId, billing = {}) {
  if (!agentId) return {};
  const next = { ...(billing || {}) };
  delete next[agentId];
  return { direct_source_billing: next };
}

/** 模板是否已配好（UI 提示用）：按量源无预填模型也可直接添加 */
export function templateReadyForInstance(tpl) {
  if (tpl.kind === 'payg') return true;
  if (tpl.kind === 'app_sub' || tpl.kind === 'api_sub') {
    if ((tpl.plans || []).length > 0) return true;
    if (tpl.kind === 'app_sub' && !tpl.subscription_to_api) return true;
  }
  if (Object.keys(tpl.pricing || {}).length > 0) return true;
  if (tpl.kind !== 'payg' && tpl.plan_provider_id) return true;
  return (tpl.models || []).length > 0;
}

// ── 第2块：模板编辑弹窗（写 source_template_overrides）──────────────────────────
export function TemplateEditModal({
  template, overrides, payg = [], subs = [], customTemplates = {}, paygCatalog = [],
  onSave, onClose, onInstanceAdded, t, editOnly = false,
}) {
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
    const effectiveTpl = { ...template, pricing, subscription_to_api: subToApi };
    if (isAppSub && !subToApi) {
      onSave(buildDirectSourcePatch(effectiveTpl, { billing: {} }));
    } else {
      onSave(buildInstancePatch(effectiveTpl, { payg, subs, planId }));
      onInstanceAdded?.(key);
    }
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
      if (isAppSub && isCustomTpl) ov.subscription_to_api = subToApi;
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
        {isAppSub && isCustomTpl && (
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" checked={subToApi} onChange={e => setSubToApi(e.target.checked)} />
            {t('psrc.tpl.subToApi')}
          </label>
        )}
        {isAppSub && !isCustomTpl && (
          <p className="text-xs text-zinc-400">
            {template.subscription_to_api ? t('psrc.tpl.serverSubToApiOn') : t('psrc.tpl.serverSubToApiOff')}
          </p>
        )}
        {/* 模型 + 计费：所有模板都配（订阅模板也要有支持的模型才能加实例）*/}
        <div className="space-y-1">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{isSub ? t('psrc.tpl.subModels') : t('psrc.tpl.pricing')}</p>
          <PricingTable rows={rows} onCell={onCell} onAddModel={onAddModel} onRemoveModel={onRemoveModel} t={t} />
        </div>

        {/* 添加为我的源（实例化此模板）；供给页 billing 模式仅编辑模板，实例在下方添加 */}
        {!editOnly && (
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
        )}

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
