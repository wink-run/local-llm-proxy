import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getConfig } from '../api/adapter';
import { loadUserAccounts, saveUserAccounts } from '../api/userAccounts';
import { useLang } from '../store/lang';
import { useCurrency } from '../store/currency';
import { isAccountOkMsg } from '../i18n';
import ServiceIcon from './ServiceIcon';
import {
  AccountStatsView, SourceTemplateGrid, TemplateEditModal,
  SyncDiffBanner, CustomSourceWizard, SourcePickerModal,
  buildInstancePatch, templateReadyForInstance,
} from './PersonalSources';

const CUSTOM_APP = '__custom_app__';
const CUSTOM_PLAN = '__custom_plan__';
const CUSTOM_PAYG = '__custom_payg__';
const CUSTOM_API = '__custom_api__';
const SUB_KIND_APP = 'app';
const SUB_KIND_API = 'api';

function subscriptionKind(s) {
  return s?.subscription_kind === SUB_KIND_API ? SUB_KIND_API : SUB_KIND_APP;
}

function uid() {
  return `ua-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 同模板已有 N 个实例 → 默认名「label_(N+1)」；首个用 label */
function instanceName(label, list, keyField, keyVal) {
  const n = (list || []).filter(x => x[keyField] === keyVal).length;
  return n > 0 ? `${label}_${n + 1}` : label;
}

/** 用户手动添加模型时的默认刊例价（USD / 百万 Token） */
const DEFAULT_MODEL_PRICING = { in: 1, out: 5, cacheRead: 0.1 };

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

/** 个人页：积分 / 订阅 / 按量付费 三类账户
 * @param {'full'|'billing'} scope — billing 仅订阅+按量（供给页未登录可用）
 */
export default function UserAccountsPanel({
  user,
  scope = 'full',
  txs = [],
  creditsOpen,
  onCreditsToggle,
  onRefreshUser,
  onAccountsChanged,
  onInstanceAdded,
  CheckinCard,
  SpinCard,
  purchaseForm,
  initialTab = 'p2p',
}) {
  const { t } = useLang();
  const { fmtCost } = useCurrency();
  const billingOnly = scope === 'billing';
  const [tab, setTab] = useState(() => {
    if (billingOnly) return 'templates';   // 供给源页：账户区只剩模板库（订阅/API/统计已并入别处）
    return initialTab;
  });
  const [data, setData] = useState(null);
  const [templateEditing, setTemplateEditing] = useState(null);   // 当前编辑的源模板
  const [wizardOpen, setWizardOpen] = useState(false);             // 自定义源向导
  const [instancePickerOpen, setInstancePickerOpen] = useState(false);  // 「添加账户实例」选源弹窗
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // 订阅：添加表单
  const [addSubKind, setAddSubKind] = useState(SUB_KIND_APP);
  const [addSubSource, setAddSubSource] = useState('');
  const [addSubPlan, setAddSubPlan] = useState('');
  const [addSubUseApi, setAddSubUseApi] = useState(false);
  const [addApiSource, setAddApiSource] = useState('');
  const [addApiPlan, setAddApiPlan] = useState('');
  const [customAppName, setCustomAppName] = useState('');
  const [customPlanLabel, setCustomPlanLabel] = useState('');
  const [customPlanUsd, setCustomPlanUsd] = useState('');

  function resetSubForm() {
    setAddSubKind(SUB_KIND_APP);
    setAddSubSource('');
    setAddSubPlan('');
    setAddSubUseApi(false);
    setAddApiSource('');
    setAddApiPlan('');
    setCustomAppName('');
    setCustomPlanLabel('');
    setCustomPlanUsd('');
  }

  function onSubKindChange(kind) {
    setAddSubKind(kind);
    setAddSubSource('');
    setAddSubPlan('');
    setAddSubUseApi(false);
    setAddApiSource('');
    setAddApiPlan('');
    setCustomAppName('');
    setCustomPlanLabel('');
    setCustomPlanUsd('');
  }

  function onSubSourceChange(value) {
    setAddSubSource(value);
    setAddSubPlan('');
    setCustomPlanLabel('');
    setCustomPlanUsd('');
    if (value !== CUSTOM_APP) {
      setCustomAppName('');
      const item = catalog.find(c => c.source_id === value);
      setAddSubUseApi(item?.subscription_to_api === true);
    } else {
      setAddSubUseApi(false);
    }
  }

  /** 切换预置 API 订阅 / 自定义 API */
  function onApiSourceChange(value) {
    setAddApiSource(value);
    setAddApiPlan('');
    setCustomAppName('');
    setCustomPlanLabel('');
    setCustomPlanUsd('');
  }

  // 按量：添加 provider
  const [addPaygId, setAddPaygId] = useState('');
  const [customPaygLabel, setCustomPaygLabel] = useState('');
  const [paygExpanded, setPaygExpanded] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [providerPricing, setProviderPricing] = useState({});
  const [subMsg, setSubMsg] = useState('');
  const [paygMsg, setPaygMsg] = useState('');
  const pricingSaveTimer = useRef(null);

  function onPaygSelectChange(value) {
    setAddPaygId(value);
    if (value !== CUSTOM_PAYG) setCustomPaygLabel('');
  }

  const load = useCallback(() => {
    setLoading(true);
    loadUserAccounts()
      .then(r => {
        setData(r);
        setOverrides(JSON.parse(JSON.stringify(r.provider_pricing_overrides || {})));
        setProviderPricing(r.provider_pricing || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, user?.id]);

  // 服务端下发新报价后自动刷新
  useEffect(() => {
    const unsub = window.electronAPI?.localConfig?.onBillingChanged?.(load);
    return () => unsub?.();
  }, [load]);

  useEffect(() => () => {
    if (pricingSaveTimer.current) clearTimeout(pricingSaveTimer.current);
  }, []);

  // 订阅 tab 含 APP + API 两类；按量 tab 仅 PAYG provider。
  async function saveAccounts(patch, { quiet = false, successMsg } = {}) {
    setSaving(true);
    setMsg('');
    setSubMsg('');
    setPaygMsg('');
    try {
      const r = await saveUserAccounts({
        user_subscriptions: data?.user_subscriptions,
        user_payg_providers: data?.user_payg_providers,
        provider_pricing_overrides: overrides,
        ...patch,
      });
      setData(r);
      if (!quiet) {
        setMsg(t('accounts.saved'));
        if ('user_subscriptions' in patch) {
          setSubMsg(successMsg ?? t('accounts.added'));
        }
        if ('user_payg_providers' in patch) {
          setPaygMsg(successMsg ?? t('accounts.added'));
        }
        setTimeout(() => { setMsg(''); setSubMsg(''); setPaygMsg(''); }, 2000);
      }
      onAccountsChanged?.(r);
      return true;
    } catch {
      const tip = t('accounts.saveFailed');
      setMsg(tip);
      setSubMsg(tip);
      setPaygMsg(tip);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const catalog = data?.subscription_catalog || [];
  const apiCatalog = data?.api_subscription_catalog || [];
  const subs = data?.user_subscriptions || [];
  const payg = data?.user_payg_providers || [];
  const paygOptions = data?.payg_provider_catalog || [];
  // OAuth 订阅（app 类）与 API-key 订阅（kind=api）均在订阅 tab；按量 provider 在 payg tab。
  const appSubs = subs.filter(s => subscriptionKind(s) === SUB_KIND_APP);
  const apiSubs = subs.filter(s => subscriptionKind(s) === SUB_KIND_API);
  const addedTemplateKeys = useMemo(() => {
    const keys = new Set();
    for (const s of subs) keys.add(s.source_id);
    for (const p of payg) keys.add(p.provider_id);
    return keys;
  }, [subs, payg]);
  // 网格模板 = 官方目录 + 自定义源模板（均由 billing-config 的 source_templates 下发，含 custom 标记）
  const mergedTemplates = data?.source_templates || [];
  function adoptServerTemplate(key) {
    const next = { ...(data?.source_template_overrides || {}) };
    delete next[key];
    saveAccounts({ source_template_overrides: next }, { quiet: true });
  }

  const isCustomApp = addSubSource === CUSTOM_APP;
  const isCustomPlan = addSubPlan === CUSTOM_PLAN;
  const isCustomApi = addApiSource === CUSTOM_API;
  const catalogItem = !isCustomApp ? catalog.find(c => c.source_id === addSubSource) : null;
  const apiCatalogItem = !isCustomApi ? apiCatalog.find(c => c.source_id === addApiSource) : null;
  const planOptions = catalogItem?.plans?.length
    ? catalogItem.plans
    : (catalogItem ? [{ id: 'other', label: t('accounts.otherPlan'), monthly_usd: null }] : []);
  const apiPlanOptions = apiCatalogItem?.plans?.length
    ? apiCatalogItem.plans
    : (apiCatalogItem ? [{ id: 'other', label: t('accounts.otherPlan'), monthly_usd: null }] : []);

  async function addSubscription() {
    setSubMsg('');
    if (addSubKind === SUB_KIND_API) {
      if (!addApiSource) {
        setSubMsg(t('accounts.err.selectApiSubscription'));
        return;
      }

      // 自定义 API 订阅：名称 + 套餐 + 可选月费
      if (isCustomApi) {
        const name = customAppName.trim();
        const planLabel = customPlanLabel.trim();
        if (!name || !planLabel) {
          setSubMsg(t('accounts.err.apiPlan'));
          return;
        }
        if (apiSubs.some(s => s.app_name.toLowerCase() === name.toLowerCase())) {
          setSubMsg(t('accounts.err.apiExists', { name }));
          return;
        }
        const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'api';
        const sourceId = `api-custom-${slug}-${Date.now().toString(36)}`;
        const monthly = customPlanUsd === '' ? null : Number(customPlanUsd);
        const next = [...subs, {
          id: uid(),
          subscription_kind: SUB_KIND_API,
          custom: true,
          source_id: sourceId,
          plan_provider_id: sourceId,
          agent_id: null,
          app_name: name,
          app_icon: '🔑',
          plan_id: 'custom',
          plan_label: planLabel,
          monthly_usd: Number.isFinite(monthly) ? monthly : null,
          subscription_to_api: true,
        }];
        setData(d => ({ ...(d || {}), user_subscriptions: next }));
        const ok = await saveAccounts({ user_subscriptions: next });
        if (ok) resetSubForm();
        return;
      }

      if (!apiCatalogItem) {
        setSubMsg(t('accounts.err.selectApiSubscription'));
        return;
      }
      if (!addApiPlan) {
        setSubMsg(t('accounts.err.selectPlan'));
        return;
      }
      const plan = apiPlanOptions.find(p => p.id === addApiPlan);
      if (!plan) {
        setSubMsg(t('accounts.err.invalidPlan'));
        return;
      }
      const next = [...subs, {
        id: uid(),
        subscription_kind: SUB_KIND_API,
        source_id: addApiSource,
        plan_provider_id: apiCatalogItem.plan_provider_id,
        agent_id: null,
        app_name: apiCatalogItem.app_name,
        app_icon: apiCatalogItem.app_icon,
        plan_id: plan.id,
        plan_label: plan.label || plan.id,
        monthly_usd: plan.monthly_usd ?? null,
        subscription_to_api: true,
      }];
      setData(d => ({ ...(d || {}), user_subscriptions: next }));
      const ok = await saveAccounts({ user_subscriptions: next });
      if (ok) resetSubForm();
      return;
    }

    if (isCustomApp) {
      const name = customAppName.trim();
      const planLabel = customPlanLabel.trim();
      if (!name || !planLabel) {
        setSubMsg(t('accounts.err.appPlan'));
        return;
      }
      if (subs.some(s => s.app_name.toLowerCase() === name.toLowerCase())) {
        setSubMsg(t('accounts.err.appExists', { name }));
        return;
      }
      const sourceId = `custom-${name.toLowerCase().replace(/\s+/g, '-').slice(0, 32)}-${Date.now().toString(36)}`;
      const monthly = customPlanUsd === '' ? null : Number(customPlanUsd);
      const next = [...subs, {
        id: uid(),
        subscription_kind: SUB_KIND_APP,
        source_id: sourceId,
        agent_id: null,
        app_name: name,
        app_icon: '🔧',
        plan_id: 'custom',
        plan_label: planLabel,
        monthly_usd: Number.isFinite(monthly) ? monthly : null,
        custom: true,
        subscription_to_api: addSubUseApi,
      }];
      setData(d => ({ ...(d || {}), user_subscriptions: next }));
      const ok = await saveAccounts({ user_subscriptions: next });
      if (ok) resetSubForm();
      return;
    }

    if (!addSubSource || !catalogItem) {
      setSubMsg(t('accounts.err.selectApp'));
      return;
    }
    let plan_id, plan_label, monthly_usd;
    if (isCustomPlan) {
      const planLabel = customPlanLabel.trim();
      if (!planLabel) {
        setSubMsg(t('accounts.err.planName'));
        return;
      }
      plan_id = 'custom';
      plan_label = planLabel;
      monthly_usd = customPlanUsd === '' ? null : Number(customPlanUsd);
      if (monthly_usd != null && !Number.isFinite(monthly_usd)) monthly_usd = null;
    } else {
      if (!addSubPlan) {
        setSubMsg(t('accounts.err.selectPlan'));
        return;
      }
      const plan = planOptions.find(p => p.id === addSubPlan);
      if (!plan) {
        setSubMsg(t('accounts.err.invalidPlan'));
        return;
      }
      plan_id = plan.id;
      plan_label = plan.label || plan.id;
      monthly_usd = plan.monthly_usd ?? null;
    }

    const next = [...subs, {
      id: uid(),
      subscription_kind: SUB_KIND_APP,
      source_id: addSubSource,
      name: instanceName(catalogItem.app_name, appSubs, 'source_id', addSubSource),
      agent_id: catalogItem.agent_id,
      app_name: catalogItem.app_name,
      app_icon: catalogItem.app_icon,
      plan_id,
      plan_label,
      monthly_usd,
      subscription_to_api: addSubUseApi,
    }];
    setData(d => ({ ...(d || {}), user_subscriptions: next }));
    const ok = await saveAccounts({ user_subscriptions: next });
    if (ok) resetSubForm();
  }

  const canAddSubscription = addSubKind === SUB_KIND_API
    ? (isCustomApi
      ? customAppName.trim() && customPlanLabel.trim()
      : addApiSource && addApiPlan)
    : isCustomApp
      ? customAppName.trim() && customPlanLabel.trim()
      : addSubSource && (isCustomPlan ? customPlanLabel.trim() : addSubPlan);

  /** 是否启用「订阅转 API」（API 类固定 true；APP 类用户设置优先，否则目录默认） */
  function subUseApi(s) {
    if (subscriptionKind(s) === SUB_KIND_API) return true;
    const cat = catalog.find(c => c.source_id === s.source_id);
    if (s.subscription_to_api != null) return s.subscription_to_api === true;
    return cat?.subscription_to_api === true;
  }

  function updateSubApiFlag(id, useApi) {
    const next = subs.map(s => (
      s.id === id && subscriptionKind(s) === SUB_KIND_APP
        ? { ...s, subscription_to_api: useApi }
        : s
    ));
    setData(d => ({ ...d, user_subscriptions: next }));
    saveAccounts({ user_subscriptions: next });
  }

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
        setPaygMsg(t('accounts.err.providerName'));
        return;
      }
      if (payg.some(p => p.label.toLowerCase() === label.toLowerCase())) {
        setPaygMsg(t('accounts.err.providerLabelExists', { name: label }));
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
      setPaygMsg(t('accounts.err.selectProvider'));
      return;
    }
    const meta = paygOptions.find(p => p.id === addPaygId || p.provider_id === addPaygId)
      || { label: addPaygId, icon: '🔧', models: [] };
    const next = [...payg, {
      id: uid(),
      provider_id: addPaygId,
      label: meta.label,
      name: instanceName(meta.label, payg, 'provider_id', addPaygId),
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

  async function removePayg(id) {
    const item = payg.find(p => p.id === id);
    if (!item) return;
    setPaygMsg('');
    try {
      const cfg = await getConfig().read().catch(() => ({}));
      const enabled = (cfg?.providers || []).some(
        pr => pr.id === item.provider_id && pr.enabled,
      );
      if (enabled) {
        setPaygMsg(t('accounts.err.providerOffline'));
        return;
      }
    } catch {
      // 读配置失败时不阻断移除
    }
    const next = payg.filter(p => p.id !== id);
    setData(d => ({ ...d, user_payg_providers: next }));
    saveAccounts({ user_payg_providers: next }, { successMsg: t('accounts.removed') });
    if (paygExpanded === id) setPaygExpanded(null);
  }

  function addModelToPayg(paygId, modelName) {
    const name = (modelName || '').trim();
    if (!name) return;
    const item = payg.find(p => p.id === paygId);
    if (!item || (item.models || []).includes(name)) return;

    const next = payg.map(p => {
      if (p.id !== paygId) return p;
      return { ...p, models: [...(p.models || []), name] };
    });

    // 无 yaml 默认价时，写入缺省刊例价
    const pid = item.provider_id;
    const baseRow = (providerPricing[pid] || {})[name] || {};
    const ovrRow = (overrides[pid] || {})[name] || {};
    const hasPricing = ['in', 'out', 'cacheRead'].some(
      f => ovrRow[f] != null || baseRow[f] != null,
    );
    let nextOverrides = overrides;
    if (!hasPricing) {
      nextOverrides = {
        ...overrides,
        [pid]: {
          ...(overrides[pid] || {}),
          [name]: { ...DEFAULT_MODEL_PRICING },
        },
      };
      setOverrides(nextOverrides);
    }

    setData(d => ({ ...d, user_payg_providers: next }));
    saveAccounts({
      user_payg_providers: next,
      ...(nextOverrides !== overrides ? { provider_pricing_overrides: nextOverrides } : {}),
    });
  }

  /** 从按量账户登记中删除单个模型（含刊例价覆盖） */
  function removeModelFromPayg(paygId, modelName) {
    const item = payg.find(p => p.id === paygId);
    if (!item || !(item.models || []).includes(modelName)) return;
    const nextPayg = payg.map(p => {
      if (p.id !== paygId) return p;
      return { ...p, models: (p.models || []).filter(m => m !== modelName) };
    });
    const nextOverrides = { ...overrides };
    const pid = item.provider_id;
    if (nextOverrides[pid]?.[modelName]) {
      const perModel = { ...nextOverrides[pid] };
      delete perModel[modelName];
      if (Object.keys(perModel).length) nextOverrides[pid] = perModel;
      else delete nextOverrides[pid];
    }
    setOverrides(nextOverrides);
    setData(d => ({ ...d, user_payg_providers: nextPayg }));
    saveAccounts({ user_payg_providers: nextPayg, provider_pricing_overrides: nextOverrides });
  }

  function updatePricing(providerId, model, field, value) {
    const num = value === '' ? null : Number(value);
    setOverrides(prev => {
      const next = {
        ...prev,
        [providerId]: {
          ...(prev[providerId] || {}),
          [model]: { ...(prev[providerId]?.[model] || {}), [field]: num },
        },
      };
      if (pricingSaveTimer.current) clearTimeout(pricingSaveTimer.current);
      pricingSaveTimer.current = setTimeout(() => {
        saveAccounts({ provider_pricing_overrides: next }, { quiet: true });
      }, 400);
      return next;
    });
  }

  const statsTab = { id: 'accounts', label: t('psrc.tab.stats'), sub: t('accounts.count', { n: data?.account_stats?.total ?? 0 }), color: 'zinc' };
  const templatesTab = { id: 'templates', label: t('psrc.tab.sourceList'), sub: t('accounts.count', { n: (data?.source_templates || []).length }), color: 'violet' };
  const tabs = billingOnly
    // 供给源页：统计移到下面「个人源」、订阅/API 已并入模板（点模板加实例），账户区只剩模板库
    ? [templatesTab]
    : [
        { id: 'p2p', label: t('accounts.tab.p2p'), sub: t('accounts.tab.p2pSub'), color: 'blue' },
        statsTab,
        { id: 'subscription', label: t('accounts.tab.subscription'), sub: t('accounts.count', { n: appSubs.length + apiSubs.length }), color: 'amber' },
        { id: 'payg', label: t('accounts.tab.payg'), sub: t('accounts.count', { n: payg.length }), color: 'emerald' },
        templatesTab,
      ];

  return (
    <section className={billingOnly ? '' : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden'}>
      {/* 账户类型切换（只剩一个 tab 时隐藏标题栏，直接展示内容）*/}
      {tabs.length > 1 && (
        <div className="flex border-b border-zinc-100 dark:border-zinc-800">
          {tabs.map(tabItem => (
            <button key={tabItem.id} type="button" onClick={() => setTab(tabItem.id)}
              className={`flex-1 px-4 py-3 text-left transition-colors ${
                tab === tabItem.id
                  ? 'bg-zinc-50 dark:bg-zinc-800/80 border-b-2 border-zinc-900 dark:border-zinc-100'
                  : 'hover:bg-zinc-50/50 dark:hover:bg-zinc-800/40'
              }`}>
              <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{tabItem.label}</div>
              <div className="text-xs text-zinc-400 mt-0.5">{tabItem.sub}</div>
            </button>
          ))}
        </div>
      )}

      <div className="p-5 space-y-4">
        {msg && <p className="text-xs text-green-600 dark:text-green-400">{msg}</p>}

        {/* ── 积分账户 P2P（仅完整个人页）── */}
        {!billingOnly && tab === 'p2p' && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
                  💎 {Math.floor(user?.credits_balance ?? 0).toLocaleString()}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {t('accounts.totalEarned')}{' '}
                  <span className="text-green-600">+{Math.floor(user?.credits_earned ?? 0).toLocaleString()}</span>
                  {' / '}
                  <span className="text-red-500">-{Math.floor(user?.credits_spent ?? 0).toLocaleString()}</span>
                </p>
              </div>
              <button type="button" onClick={onCreditsToggle}
                className="text-xs text-gray-400 hover:text-gray-600">
                {creditsOpen ? t('accounts.collapseDetail') : t('accounts.expandDetail')}
              </button>
            </div>

            {creditsOpen && (
              <div className="space-y-3 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300">{t('accounts.creditsLedger')}</h3>
                {txs.length === 0 ? (
                  <p className="text-sm text-gray-400">{t('accounts.noRecords')}</p>
                ) : txs.slice(0, 10).map(tx => (
                  <div key={tx.id} className="flex items-center justify-between text-sm">
                    <div>
                      <span className="text-gray-700 dark:text-gray-300">
                        {t(`accounts.tx.${tx.type}`) !== `accounts.tx.${tx.type}` ? t(`accounts.tx.${tx.type}`) : tx.type}{tx.model_name ? ` · ${tx.model_name}` : ''}
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
            <p className="text-xs text-gray-400">{t('accounts.p2pHint')}</p>
          </>
        )}

        {/* ── 统计 tab：账户统计 + 同步差异 ── */}
        {tab === 'accounts' && (
          loading ? <p className="text-sm text-gray-400">{t('accounts.loading')}</p> : (
            <div className="space-y-3">
              <SyncDiffBanner syncDiff={data?.sync_diff} t={t}
                onAdoptServer={adoptServerTemplate} onDismissDrift={adoptServerTemplate} />
              <AccountStatsView data={data} t={t} />
            </div>
          )
        )}

        {/* ── 源模板库（账户源列表）── */}
        {tab === 'templates' && (
          loading ? <p className="text-sm text-gray-400">{t('accounts.loading')}</p> : (
            <SourceTemplateGrid templates={mergedTemplates}
              addedKeys={addedTemplateKeys} onEdit={setTemplateEditing}
              onAdd={() => setInstancePickerOpen(true)} t={t} />
          )
        )}

        {templateEditing && (
          <TemplateEditModal template={templateEditing}
            overrides={data?.source_template_overrides || {}}
            payg={payg} subs={subs}
            customTemplates={data?.custom_source_templates || {}}
            paygCatalog={data?.payg_provider_catalog || []}
            onSave={(patch) => saveAccounts(patch, { quiet: true })}
            onInstanceAdded={onInstanceAdded}
            onClose={() => setTemplateEditing(null)} t={t} />
        )}
        {wizardOpen && (
          <CustomSourceWizard payg={payg} subs={subs} customTemplates={data?.custom_source_templates || {}} t={t}
            onSave={(patch) => saveAccounts(patch)}
            onClose={() => setWizardOpen(false)} />
        )}
        {instancePickerOpen && (
          <SourcePickerModal templates={mergedTemplates} t={t}
            onPick={async (tpl) => {
              setInstancePickerOpen(false);
              // 配好的源 → 直接建实例 + 弹凭证配置（一步）；没配好的 → 进模板编辑去配
              if (!templateReadyForInstance(tpl)) { setTemplateEditing(tpl); return; }
              await saveAccounts(buildInstancePatch(tpl, { payg, subs }), { quiet: true });
              onInstanceAdded?.(tpl.key);
            }}
            onNewSource={() => { setInstancePickerOpen(false); setWizardOpen(true); }}
            onClose={() => setInstancePickerOpen(false)} />
        )}

        {/* ── 订阅账户 ── */}
        {tab === 'subscription' && (
          <>
            {loading ? (
              <p className="text-sm text-gray-400">{t('accounts.loading')}</p>
            ) : (
              <>
                <p className="text-xs text-gray-500">{t('accounts.subHint')}</p>

                {/* APP 订阅 */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-300">{t('accounts.sectionAppSubs')}</h4>
                  {appSubs.length === 0 ? (
                    <p className="text-sm text-gray-400 py-2 text-center">{t('accounts.noAppSubscriptions')}</p>
                  ) : (
                    <div className="space-y-2">
                      {appSubs.map(s => (
                        <div key={s.id}
                          className="flex items-center gap-3 px-4 py-3 rounded-xl border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/60">
                          <ServiceIcon id={s.plan_provider_id || s.source_id} name={s.app_name} icon={s.app_icon} />
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate max-w-[7rem] shrink-0">
                            {s.app_name}
                          </span>
                          <span className="text-xs text-gray-500 truncate flex-1 min-w-0">
                            {s.plan_label || s.plan_id}
                            {s.monthly_usd != null ? ` · ${fmtCost(s.monthly_usd)}${t('accounts.perMonth')}` : ''}
                            {(s.custom || s.plan_id === 'custom') && (
                              <span className="ml-1 text-gray-400">{t('accounts.custom')}</span>
                            )}
                          </span>
                          <select
                            value={subUseApi(s) ? 'api' : 'stats'}
                            onChange={e => updateSubApiFlag(s.id, e.target.value === 'api')}
                            disabled={saving}
                            className="text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 shrink-0"
                          >
                            <option value="stats">{t('accounts.statsOnly')}</option>
                            <option value="api">{t('accounts.convertApi')}</option>
                          </select>
                          <button type="button" onClick={() => removeSubscription(s.id)}
                            className="text-xs text-red-400 hover:text-red-500 shrink-0">{t('accounts.remove')}</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* API 订阅 */}
                <div className="space-y-2 pt-3 border-t border-zinc-100 dark:border-zinc-800">
                  <h4 className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{t('accounts.sectionApiSubs')}</h4>
                  {apiSubs.length === 0 ? (
                    <p className="text-sm text-zinc-400 py-2 text-center">{t('accounts.noApiSubscriptions')}</p>
                  ) : (
                    <div className="space-y-2">
                      {apiSubs.map(s => (
                        <div key={s.id} className="flex items-center gap-3 px-4 py-3 rounded-xl border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/60">
                          <ServiceIcon id={s.plan_provider_id || s.source_id} name={s.app_name} icon={s.app_icon} />
                          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate max-w-[8rem] shrink-0">{s.app_name}</span>
                          <span className="text-xs text-zinc-500 truncate flex-1 min-w-0">
                            {s.plan_label || s.plan_id}
                            {s.monthly_usd != null ? ` · ${fmtCost(s.monthly_usd)}${t('accounts.perMonth')}` : ''}
                            {s.custom && (<span className="ml-1 text-zinc-400">{t('accounts.custom')}</span>)}
                          </span>
                          <button type="button" onClick={() => removeSubscription(s.id)} className="text-xs text-red-400 hover:text-red-500 shrink-0">{t('accounts.remove')}</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 添加订阅（APP / API） */}
                <div className="space-y-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                  {subMsg && (
                    <p className={`text-xs ${isAccountOkMsg(subMsg, t) ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                      {subMsg}
                    </p>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 min-w-[100px]">
                      <label className="text-xs text-zinc-400 block mb-1">{t('accounts.subKind')}</label>
                      <select value={addSubKind} onChange={e => onSubKindChange(e.target.value)}
                        className="w-full text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2">
                        <option value={SUB_KIND_APP}>{t('accounts.subKindApp')}</option>
                        <option value={SUB_KIND_API}>{t('accounts.subKindApi')}</option>
                      </select>
                    </div>
                    {addSubKind === SUB_KIND_API ? (
                      <>
                        <div className="flex-1 min-w-[140px]">
                          <label className="text-xs text-gray-400 block mb-1">{t('accounts.apiSubscription')}</label>
                          <select value={addApiSource} onChange={e => onApiSourceChange(e.target.value)}
                            className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2">
                            <option value="">{t('accounts.selectApiSubscription')}</option>
                            {apiCatalog.map(c => (
                              <option key={c.source_id} value={c.source_id}>
                                {c.app_icon} {c.app_name}
                              </option>
                            ))}
                            <option value={CUSTOM_API}>{t('accounts.customApi')}</option>
                          </select>
                        </div>
                        {!isCustomApi && (
                        <div className="flex-1 min-w-[120px]">
                          <label className="text-xs text-gray-400 block mb-1">{t('accounts.plan')}</label>
                          <select value={addApiPlan} onChange={e => setAddApiPlan(e.target.value)} disabled={!addApiSource}
                            className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2 disabled:opacity-50">
                            <option value="">{t('accounts.selectPlan')}</option>
                            {apiPlanOptions.map(p => (
                              <option key={p.id} value={p.id}>
                                {p.label}{p.monthly_usd != null ? ` (${fmtCost(p.monthly_usd)}${t('accounts.perMonth')})` : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                        )}
                      </>
                    ) : (
                      <>
                    <div className="flex-1 min-w-[140px]">
                      <label className="text-xs text-gray-400 block mb-1">{t('accounts.app')}</label>
                      <select value={addSubSource} onChange={e => onSubSourceChange(e.target.value)}
                        className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2">
                        <option value="">{t('accounts.selectApp')}</option>
                        {catalog.map(c => (
                          <option key={c.source_id} value={c.source_id}>
                            {c.app_icon} {c.app_name}
                          </option>
                        ))}
                        <option value={CUSTOM_APP}>{t('accounts.customApp')}</option>
                      </select>
                    </div>

                    {!isCustomApp && (
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.plan')}</label>
                        <select value={addSubPlan} onChange={e => setAddSubPlan(e.target.value)} disabled={!addSubSource}
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2 disabled:opacity-50">
                          <option value="">{t('accounts.selectPlan')}</option>
                          {planOptions.map(p => (
                            <option key={p.id} value={p.id}>
                              {p.label}{p.monthly_usd != null ? ` (${fmtCost(p.monthly_usd)}${t('accounts.perMonth')})` : ''}
                            </option>
                          ))}
                          <option value={CUSTOM_PLAN}>{t('accounts.customPlan')}</option>
                        </select>
                      </div>
                    )}

                    <div className="flex-1 min-w-[110px]">
                      <label className="text-xs text-gray-400 block mb-1">{t('accounts.appMode')}</label>
                      <select
                        value={addSubUseApi ? 'api' : 'stats'}
                        onChange={e => setAddSubUseApi(e.target.value === 'api')}
                        disabled={!isCustomApp && !catalogItem}
                        className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2 disabled:opacity-50"
                      >
                        <option value="stats">{t('accounts.statsOnly')}</option>
                        <option value="api">{t('accounts.convertApi')}</option>
                      </select>
                    </div>
                      </>
                    )}

                    <button type="button" onClick={addSubscription} disabled={!canAddSubscription || saving}
                      className="text-xs px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50">
                      {saving ? t('accounts.saving') : t('accounts.addSubscription')}
                    </button>
                  </div>

                  {/* 自定义 API：名称 + 套餐 + 月费 */}
                  {addSubKind === SUB_KIND_API && isCustomApi && (
                    <div className="flex flex-wrap items-end gap-2 pl-1">
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.apiProviderName')}</label>
                        <input value={customAppName} onChange={e => setCustomAppName(e.target.value)}
                          placeholder="如 DeepSeek、Moonshot…"
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2" />
                      </div>
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.planName')}</label>
                        <input value={customPlanLabel} onChange={e => setCustomPlanLabel(e.target.value)}
                          placeholder="如 Pro、Team…"
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2" />
                      </div>
                      <div className="w-24">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.monthlyUsd')}</label>
                        <input type="number" min="0" step="0.01" value={customPlanUsd}
                          onChange={e => setCustomPlanUsd(e.target.value)} placeholder={t('accounts.optional')}
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2 text-right" />
                      </div>
                    </div>
                  )}

                  {/* 自定义 APP：名称 + 套餐 + 月费 */}
                  {addSubKind === SUB_KIND_APP && isCustomApp && (
                    <div className="flex flex-wrap items-end gap-2 pl-1">
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.appName')}</label>
                        <input value={customAppName} onChange={e => setCustomAppName(e.target.value)}
                          placeholder="如 Cursor、Warp…"
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2" />
                      </div>
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.planName')}</label>
                        <input value={customPlanLabel} onChange={e => setCustomPlanLabel(e.target.value)}
                          placeholder="如 Pro、Business…"
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2" />
                      </div>
                      <div className="w-24">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.monthlyUsd')}</label>
                        <input type="number" min="0" step="0.01" value={customPlanUsd}
                          onChange={e => setCustomPlanUsd(e.target.value)} placeholder={t('accounts.optional')}
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2 text-right" />
                      </div>
                    </div>
                  )}

                  {/* 目录 APP + 自定义套餐 */}
                  {addSubKind === SUB_KIND_APP && !isCustomApp && isCustomPlan && (
                    <div className="flex flex-wrap items-end gap-2 pl-1">
                      <div className="flex-1 min-w-[120px]">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.planName')}</label>
                        <input value={customPlanLabel} onChange={e => setCustomPlanLabel(e.target.value)}
                          placeholder={t('accounts.err.planPlaceholder')}
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2" />
                      </div>
                      <div className="w-24">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.monthlyUsd')}</label>
                        <input type="number" min="0" step="0.01" value={customPlanUsd}
                          onChange={e => setCustomPlanUsd(e.target.value)} placeholder={t('accounts.optional')}
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2 text-right" />
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
              <p className="text-sm text-gray-400">{t('accounts.loading')}</p>
            ) : (
              <>
                <p className="text-xs text-zinc-500">{t('accounts.paygHint')}</p>

                {/* ── 按量付费 ── */}
                <h4 className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{t('accounts.sectionPayg')}</h4>
                {paygMsg && (
                  <p className={`text-xs ${isAccountOkMsg(paygMsg, t) ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                    {paygMsg}
                  </p>
                )}

                {/* 已添加 provider */}
                {payg.length === 0 ? (
                  <p className="text-sm text-gray-400 py-4 text-center">{t('accounts.noPayg')}</p>
                ) : (
                  <div className="space-y-2">
                    {payg.map(p => (
                      <div key={p.id} className="rounded-xl border border-gray-100 dark:border-gray-700 overflow-hidden">
                        <button type="button" onClick={() => setPaygExpanded(paygExpanded === p.id ? null : p.id)}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30">
                          <ServiceIcon id={p.provider_id} name={p.label} icon={p.icon} />
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-200 flex-1 min-w-0 truncate">
                            {p.label}
                            {p.custom && <span className="ml-1 text-xs text-emerald-600/80">{t('accounts.custom')}</span>}
                          </span>
                          <span className="text-xs text-gray-400 shrink-0">{t('accounts.modelsCount', { n: (p.models || []).length })}</span>
                          <span className="text-gray-400 shrink-0">{paygExpanded === p.id ? '▲' : '▼'}</span>
                        </button>
                        {paygExpanded === p.id && (
                          <div className="px-4 pb-4 space-y-3 border-t border-gray-100 dark:border-gray-700">
                            <div className="flex gap-2 pt-2">
                              <input id={`model-add-${p.id}`} placeholder={t('accounts.modelPlaceholder')}
                                className="flex-1 text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 font-mono"
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
                                className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white">{t('accounts.addModel')}</button>
                            </div>

                            {/* 该 provider 下的模型报价 */}
                            <div className="rounded-lg border border-gray-100 dark:border-gray-700 overflow-hidden">
                              <table className="w-full text-xs">
                                <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-500">
                                  <tr>
                                    <th className="text-left px-2 py-1.5">{t('accounts.modelCol')}</th>
                                    <th className="text-right px-1 py-1.5">{t('accounts.inputCol')}</th>
                                    <th className="text-right px-1 py-1.5">{t('accounts.outputCol')}</th>
                                    <th className="text-right px-1 py-1.5">{t('accounts.cacheReadCol')}</th>
                                    <th className="w-8" />
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                                  {(p.models || []).length === 0 ? (
                                    <tr>
                                      <td colSpan={5} className="px-2 py-2 text-gray-400 text-center">{t('accounts.noModels')}</td>
                                    </tr>
                                  ) : pricingRowsForProvider(p.provider_id, p.models, providerPricing, overrides)
                                    .filter(r => (p.models || []).includes(r.model))
                                    .map(r => (
                                    <tr key={r.model} className={r._override ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}>
                                      <td className="px-2 py-1 font-mono text-gray-700 dark:text-gray-300 truncate max-w-[8rem]" title={r.model}>{r.model}</td>
                                      {['in', 'out', 'cacheRead'].map(f => (
                                        <td key={f} className="px-1 py-1">
                                          <input type="number" min="0" step="0.001" value={r[f] ?? ''}
                                            onChange={e => updatePricing(p.provider_id, r.model, f, e.target.value)}
                                            className="w-12 ml-auto block text-right tabular-nums bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-600 focus:border-zinc-900 dark:focus:border-zinc-100 rounded px-0.5" />
                                        </td>
                                      ))}
                                      <td className="px-1 py-1 text-center">
                                        <button type="button" title={t('accounts.deleteModel')}
                                          onClick={() => removeModelFromPayg(p.id, r.model)}
                                          className="text-gray-400 hover:text-red-500 leading-none">×</button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>

                            <button type="button" onClick={() => removePayg(p.id)}
                              className="text-xs text-red-400 hover:text-red-500">{t('accounts.removeProvider')}</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 添加 provider */}
                <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                  {paygMsg && (
                    <p className={`text-xs ${isAccountOkMsg(paygMsg, t) ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                      {paygMsg}
                    </p>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 min-w-[140px]">
                      <label className="text-xs text-gray-400 block mb-1">{t('accounts.provider')}</label>
                      <select value={addPaygId} onChange={e => onPaygSelectChange(e.target.value)}
                        className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2">
                        <option value="">{t('accounts.selectProvider')}</option>
                        {paygOptions.map(o => (
                          <option key={o.id || o.provider_id} value={o.id || o.provider_id}>{o.icon} {o.label}</option>
                        ))}
                        <option value={CUSTOM_PAYG}>{t('accounts.customProvider')}</option>
                      </select>
                    </div>
                    {!isCustomPayg && (
                      <button type="button" onClick={addPaygProvider} disabled={!canAddPayg || saving}
                        className="text-xs px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                        {saving ? t('accounts.saving') : t('accounts.add')}
                      </button>
                    )}
                  </div>
                  {isCustomPayg && (
                    <div className="flex flex-wrap items-end gap-2 pl-1">
                      <div className="flex-1 min-w-[160px]">
                        <label className="text-xs text-gray-400 block mb-1">{t('accounts.providerName')}</label>
                        <input value={customPaygLabel} onChange={e => setCustomPaygLabel(e.target.value)}
                          placeholder="如 MiniMax、Moonshot…"
                          className="w-full text-xs bg-gray-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-2"
                          onKeyDown={e => { if (e.key === 'Enter') addPaygProvider(); }} />
                      </div>
                      <button type="button" onClick={addPaygProvider} disabled={!canAddPayg || saving}
                        className="text-xs px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                        {saving ? t('accounts.saving') : t('accounts.add')}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
