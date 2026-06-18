import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getNetwork, getProfile, listKeys, createKey, deleteKey, getProviderCatalog } from '../api/client';
import { loadUserAccounts } from '../api/userAccounts';
import { getServerUrl, normalizeServerBase, syncCloudConfigUrl } from '../config';
import { getGateway, getLocalConfig, getConfig, getOauth } from '../api/adapter';
import { useLang } from '../store/lang';

/** 按当前语言覆盖 meta 中的 label / hint / oauth.label */
function localizeProviderMeta(metaMap, t) {
  const out = { ...metaMap };
  for (const [id, m] of Object.entries(out)) {
    const next = { ...m };
    const labelKey = `providers.meta.${id}.label`;
    const hintKey = `providers.meta.${id}.hint`;
    if (t(labelKey) !== labelKey) next.label = t(labelKey);
    if (t(hintKey) !== hintKey) next.hint = t(hintKey);
    if (m.oauth?.provider) {
      const oauthKey = `providers.oauth.${m.oauth.provider}`;
      if (t(oauthKey) !== oauthKey) next.oauth = { ...m.oauth, label: t(oauthKey) };
    }
    out[id] = next;
  }
  return out;
}

function getTierConfig(t) {
  return {
    free: { dot: 'bg-green-500', label: t('providers.tier.free.label'), hint: t('providers.tier.free.hint'), cols: 'grid-cols-2' },
    p2p:  { dot: 'bg-blue-500',  label: t('providers.tier.p2p.label'),  hint: t('providers.tier.p2p.hint'),  cols: 'grid-cols-1' },
    paid: { dot: 'bg-amber-400', label: t('providers.tier.paid.label'), hint: t('providers.tier.paid.hint'), cols: 'grid-cols-2' },
  };
}

function getOAuthById(t) {
  return {
    'anthropic-paid': { provider: 'claude',  label: t('providers.oauth.claude') },
    openai:           { provider: 'codex',   label: t('providers.oauth.codex') },
    'github-copilot': { provider: 'copilot', label: t('providers.oauth.copilot') },
  };
}

// 内置兜底目录：当后端 /api/catalog 不可达（离线 / VPS 宕机）时使用。
// 正常情况下目录由后端下发，改源请改 server/catalog.py。
const FALLBACK_PROVIDER_META = {
  ollama:          { icon: '🦙', label: 'Ollama',        hint: '自动检测本地实例，无需配置',              keyless: true,  key_prefix: [],                      signup_url: 'https://ollama.com/download' },
  groq:            { icon: '⚡', label: 'Groq',           hint: '免费申请：console.groq.com',              keyless: false, key_prefix: ['gsk_'],                signup_url: 'https://console.groq.com/keys' },
  'github-models': { icon: '🐙', label: 'GitHub Models',  hint: '免费调用 GPT-4o、Llama，需 GitHub PAT',   keyless: false, key_prefix: ['ghp_', 'github_pat_'], signup_url: 'https://github.com/settings/tokens' },
  // ── 整合自 gpt4free needs_auth（合法注册拿 key 的源） ──
  cerebras:        { icon: '🌀', label: 'Cerebras',       hint: '免费档每日 1M tokens：cloud.cerebras.ai', keyless: false, key_prefix: ['csk-'],                signup_url: 'https://cloud.cerebras.ai' },
  nvidia:          { icon: '🟢', label: 'NVIDIA NIM',     hint: '新用户免费额度：build.nvidia.com',        keyless: false, key_prefix: ['nvapi-'],              signup_url: 'https://build.nvidia.com' },
  mistral:         { icon: '🌪', label: 'Mistral',        hint: '免费档：console.mistral.ai',              keyless: false, key_prefix: [],                      signup_url: 'https://console.mistral.ai/api-keys/' },
  openrouter:      { icon: '🛣', label: 'OpenRouter',     hint: '含 :free 免费模型：openrouter.ai',        keyless: false, key_prefix: ['sk-or-'],              signup_url: 'https://openrouter.ai/keys' },
  together:        { icon: '🔗', label: 'Together AI',    hint: '新用户赠额：api.together.ai',             keyless: false, key_prefix: ['tgp_v1_'],             signup_url: 'https://api.together.ai/settings/api-keys' },
  siliconflow:     { icon: '🧪', label: 'SiliconFlow',    hint: '国内免费源，新人 ¥16：siliconflow.cn',    keyless: false, key_prefix: ['sk-'],                 signup_url: 'https://cloud.siliconflow.cn/account/ak' },
  cohere:          { icon: '🐬', label: 'Cohere',         hint: 'Trial Key 免费：dashboard.cohere.com',    keyless: false, key_prefix: [],                      signup_url: 'https://dashboard.cohere.com/api-keys' },
  'tokenbank-p2p': { icon: '🌐', label: 'P2P 分享网络',  hint: '消耗积分使用社区共享算力',                 keyless: true,  key_prefix: [],                      signup_url: '' },
  openai:          { icon: '🤖', label: 'OpenAI',         hint: '付费 API，支持 GPT-4o / o3 等全系模型',   keyless: false, key_prefix: ['sk-proj-', 'sk-'],     signup_url: 'https://platform.openai.com/api-keys', oauth: { provider: 'codex', label: 'ChatGPT 订阅登录' } },
  'anthropic-paid':{ icon: '🧬', label: 'Anthropic',      hint: '付费 API，Claude 3.5 / 3.7 等系列',       keyless: false, key_prefix: ['sk-ant-'],             signup_url: 'https://console.anthropic.com/settings/keys', oauth: { provider: 'claude', label: 'Claude 订阅登录' } },
  gemini:          { icon: '💎', label: 'Google Gemini',  hint: 'AI Studio 免费领 API Key',                keyless: false, key_prefix: ['AIza'],                signup_url: 'https://aistudio.google.com/app/apikey' },
  'github-copilot':{ icon: '🐱', label: 'GitHub Copilot', hint: '用 GitHub 账号登录（需 Copilot 订阅）',   keyless: true,  key_prefix: [],                      signup_url: 'https://github.com/features/copilot', oauth: { provider: 'copilot', label: 'GitHub 登录' } },
  deepseek:        { icon: '🐋', label: 'DeepSeek',       hint: '官方付费：platform.deepseek.com',         keyless: false, key_prefix: ['sk-'],                 signup_url: 'https://platform.deepseek.com/api_keys' },
  xai:             { icon: '✖️', label: 'xAI Grok',       hint: '付费 API：console.x.ai',                  keyless: false, key_prefix: ['xai-'],                signup_url: 'https://console.x.ai' },
  fireworks:       { icon: '🎆', label: 'Fireworks',      hint: '低价高速：fireworks.ai',                  keyless: false, key_prefix: ['fw_'],                 signup_url: 'https://fireworks.ai/account/api-keys' },
};

const FALLBACK_PROVIDERS = [
  { id: 'ollama',          type: 'free', enabled: true,  token: '', base_url: 'http://127.0.0.1:11434/v1', models: [] },
  { id: 'groq',            type: 'free', enabled: false, token: '', base_url: 'https://api.groq.com/openai/v1', models: [] },
  { id: 'github-models',   type: 'free', enabled: false, token: '', base_url: 'https://models.inference.ai.azure.com', models: [] },
  // ── 整合自 gpt4free needs_auth（合法 key 源，OpenAI 兼容） ──
  { id: 'cerebras',        type: 'free', enabled: false, token: '', base_url: 'https://api.cerebras.ai/v1', models: [] },
  { id: 'nvidia',          type: 'free', enabled: false, token: '', base_url: 'https://integrate.api.nvidia.com/v1', models: [] },
  { id: 'mistral',         type: 'free', enabled: false, token: '', base_url: 'https://api.mistral.ai/v1', models: [] },
  { id: 'openrouter',      type: 'free', enabled: false, token: '', base_url: 'https://openrouter.ai/api/v1', models: [] },
  { id: 'together',        type: 'free', enabled: false, token: '', base_url: 'https://api.together.xyz/v1', models: [] },
  { id: 'siliconflow',     type: 'free', enabled: false, token: '', base_url: 'https://api.siliconflow.cn/v1', models: [] },
  { id: 'cohere',          type: 'free', enabled: false, token: '', base_url: 'https://api.cohere.ai/compatibility/v1', models: [] },
  { id: 'tokenbank-p2p',   type: 'p2p',  enabled: true,  token: '', base_url: '', models: [] },
  { id: 'openai',          type: 'paid', enabled: false, token: '', base_url: 'https://api.openai.com/v1', models: [] },
  { id: 'anthropic-paid',  type: 'paid', enabled: false, token: '', base_url: 'https://api.anthropic.com/v1', models: [] },
  { id: 'gemini',          type: 'paid', enabled: false, token: '', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/', models: [] },
  { id: 'github-copilot',  type: 'paid', enabled: false, token: '', base_url: 'https://api.githubcopilot.com', models: [] },
  { id: 'deepseek',        type: 'paid', enabled: false, token: '', base_url: 'https://api.deepseek.com/v1', models: [] },
  { id: 'xai',             type: 'paid', enabled: false, token: '', base_url: 'https://api.x.ai/v1', models: [] },
  { id: 'fireworks',       type: 'paid', enabled: false, token: '', base_url: 'https://api.fireworks.ai/inference/v1', models: [] },
];

// 把后端下发的 catalog 拆成展示 meta 映射 + 默认 provider 列表（与本地配置合并的种子）
function catalogToState(catalog, oauthById) {
  const meta = {};
  const defaults = [];
  for (const p of catalog?.providers || []) {
    if (!p?.id) continue;
    meta[p.id] = {
      icon: p.icon, label: p.label, hint: p.hint, keyless: !!p.keyless,
      key_prefix: Array.isArray(p.key_prefix) ? p.key_prefix : [],
      signup_url: p.signup_url || '',
      // OAuth 能力以客户端为准（仅客户端有对应 oauth 模块）；不信任远端 catalog 的 oauth 字段，
      // 否则远端未重新部署时会下发已废弃的能力（如 gemini 的 google 登录）。
      oauth: oauthById[p.id] || null,
    };
    defaults.push({
      id: p.id,
      type: p.type,
      enabled: !!p.enabled_default,
      token: '',
      base_url: p.base_url || '',
      models: [],
    });
  }
  // 后端目录里缺失的 OAuth 预设（如 gemini / github-copilot）从内置兜底补出来
  for (const id of Object.keys(oauthById)) {
    if (!meta[id]) {
      if (FALLBACK_PROVIDER_META[id]) meta[id] = { ...FALLBACK_PROVIDER_META[id] };
      const fb = FALLBACK_PROVIDERS.find(p => p.id === id);
      if (fb) defaults.push({ ...fb });
    } else if (!meta[id].oauth) {
      meta[id].oauth = oauthById[id];
    }
  }
  return { meta, defaults };
}

/** 从个人页登记 / meta 解析供给源展示名（优先于 URL hostname） */
function resolveProviderDisplayName(id, provider, userPayg = [], userSubs = [], metaMap = {}) {
  const payg = userPayg.find(u => u.provider_id === id);
  if (payg?.label) return payg.label;
  const sub = userSubs.find(s => s.custom && s.source_id === id);
  if (sub?.app_name) return sub.app_name;
  if (metaMap[id]?.label) return metaMap[id].label;
  return provider?.displayName || provider?.label || '';
}

function withProviderDisplayName(provider, userPayg, userSubs, metaMap) {
  const name = resolveProviderDisplayName(provider.id, provider, userPayg, userSubs, metaMap);
  return name ? { ...provider, displayName: name } : provider;
}

/** 合并个人页按量账户中的自定义供给源到本地 providers 列表 */
function mergeUserPaygIntoProviders(resolved, metaMap, userPayg = [], t) {
  const providers = [...resolved];
  const meta = { ...metaMap };
  for (const p of userPayg) {
    const id = p.provider_id;
    if (!id) continue;
    const existing = providers.find(x => x.id === id);
    if (existing) {
      if (p.label) existing.displayName = p.label;
      // 个人页模型仅作初始参考；本地已有配置则保留（供给源页可独立增删）
      if (!(existing.models && existing.models.length) && (p.models || []).length) {
        existing.models = [...p.models];
      }
      if (!meta[id]) {
        meta[id] = {
          icon: p.icon || '🔧',
          label: p.label || id,
          hint: t('providers.hint.userPayg'),
          keyless: false,
          key_prefix: [],
          signup_url: '',
        };
      } else if (p.label) {
        meta[id] = { ...meta[id], label: p.label };
      }
      continue;
    }
    providers.push({
      id,
      type: 'paid',
      enabled: false,
      token: '',
      base_url: '',
      models: [...(p.models || [])],
      displayName: p.label || id,
    });
    if (!meta[id]) {
      meta[id] = {
        icon: p.icon || '🔧',
        label: p.label || id,
        hint: t('providers.hint.userPayg'),
        keyless: false,
        key_prefix: [],
        signup_url: '',
      };
    }
  }
  return { providers, meta };
}

/** 个人页按量账户（用于识别按量供给源） */
function resolvePaygAccount(providerId, userPayg = []) {
  return (userPayg || []).find(p => p.provider_id === providerId) || null;
}

function isPaygManagedProvider(providerId, userPayg = []) {
  return !!resolvePaygAccount(providerId, userPayg);
}

/** 个人页按量账户已配置的模型（供给源页仅可从中选取） */
function buildPaygProfileModels(providerId, userPayg = []) {
  const payg = resolvePaygAccount(providerId, userPayg);
  const names = new Set();
  for (const m of payg?.models || []) {
    const n = typeof m === 'string' ? m.trim() : String(m?.name || '').trim();
    if (n) names.add(n);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** 模型输入候选：非按量供给源可用刊例价目录；按量仅用 buildPaygProfileModels */
function buildModelSuggestions(providerId, userPayg = [], providerPricing = {}, paygCatalog = []) {
  const names = new Set();
  const add = (m) => {
    const n = typeof m === 'string' ? m.trim() : String(m?.name || '').trim();
    if (n) names.add(n);
  };

  const payg = resolvePaygAccount(providerId, userPayg);
  for (const m of payg?.models || []) add(m);

  const cat = (paygCatalog || []).find(p => (p.provider_id || p.id) === providerId);
  for (const m of cat?.models || []) add(m);
  for (const m of Object.keys(cat?.pricing || {})) add(m);

  for (const m of Object.keys(providerPricing[providerId] || {})) add(m);

  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * 个人页登记的供给源 → 付费层可选列表。
 * 跨 free/paid 层匹配（如 groq 在目录为免费层，但个人页按量登记后应在付费层接入）。
 */
function buildPersonalPaidPool(allProviders, paidIds, userPayg = [], userSubs = []) {
  const pool = [];
  const seen = new Set();

  for (const id of paidIds || []) {
    if (!id || seen.has(id)) continue;
    const live = allProviders.find(p => p.id === id);
    const payg = userPayg.find(u => u.provider_id === id);
    const sub = (userSubs || []).find(s => s.custom && s.source_id === id);
    const displayName = sub?.app_name || payg?.label;
    if (live) {
      // 在付费层展示；写入时仍用原 id，保留 free 层条目的 base_url 等
      const enriched = displayName ? { ...live, displayName } : live;
      pool.push(enriched.type === 'paid' ? enriched : { ...enriched, type: 'paid' });
      seen.add(id);
      continue;
    }
    const fb = FALLBACK_PROVIDERS.find(p => p.id === id);
    if (payg || sub || id.startsWith('custom-') || fb) {
      pool.push({
        ...(fb || { id, type: 'paid', enabled: false, token: '', base_url: '', models: [] }),
        id,
        type: 'paid',
        enabled: fb?.enabled ?? false,
        models: [...(payg?.models || fb?.models || [])],
        displayName,
      });
      seen.add(id);
    }
  }
  return pool;
}

/** 个人页登记项 → 供给源选择器条目（渲染端回退；Electron 优先用 billing-config 下发） */
function buildGatewayPickerEntries(userSubs, userPayg, subscriptionCatalog) {
  const catalogBySource = Object.fromEntries(
    (subscriptionCatalog || []).map(c => [c.source_id, c]),
  );
  const entries = [];

  for (const sub of userSubs || []) {
    if (sub.custom) {
      const useApi = sub.subscription_kind === 'api'
        || sub.subscription_to_api === true
        || catalogBySource[sub.source_id]?.subscription_to_api === true;
      if (!useApi) continue;
      entries.push({
        providerId: sub.source_id,
        pickerKey: `sub:${sub.source_id}`,
        label: sub.app_name || sub.source_id,
        icon: sub.app_icon || '🔧',
        authMode: 'api_key',
        source: 'subscription',
        custom: true,
      });
      continue;
    }

    if (sub.subscription_kind === 'api') {
      const pid = sub.plan_provider_id || sub.source_id;
      if (!pid) continue;
      entries.push({
        providerId: pid,
        pickerKey: `sub:${sub.source_id || `api-${pid}`}`,
        label: sub.app_name || pid,
        icon: sub.app_icon || '🔑',
        authMode: 'api_key',
        source: 'subscription',
        custom: true,
      });
      continue;
    }

    const useApi = sub.subscription_to_api != null
      ? sub.subscription_to_api === true
      : catalogBySource[sub.source_id]?.subscription_to_api === true;
    if (!useApi) continue;

    const cat = catalogBySource[sub.source_id];
    const pid = cat?.plan_provider_id;
    if (!pid) continue;
    entries.push({
      providerId: pid,
      pickerKey: `sub:${sub.source_id}`,
      label: sub.app_name || cat?.app_name || pid,
      icon: sub.app_icon || cat?.app_icon || '🔷',
      authMode: 'oauth',
      source: 'subscription',
    });
  }

  for (const payg of userPayg || []) {
    const pid = payg.provider_id;
    if (!pid) continue;
    entries.push({
      providerId: pid,
      pickerKey: `payg:${pid}`,
      label: payg.label || pid,
      icon: payg.icon || '🔧',
      authMode: 'api_key',
      source: 'payg',
    });
  }
  return entries;
}

/** 是否为个人页登记的 API 订阅 / 自定义订阅供给源（走 API Key 卡片） */
function isCustomSubscriptionGatewayId(id, userSubs = []) {
  return (userSubs || []).some(s => {
    if (s.custom && s.source_id === id) return true;
    if (s.subscription_kind === 'api' && (s.plan_provider_id === id || s.source_id === id)) return true;
    return false;
  });
}

/** 已启用卡片：按当前 auth 配置解析验证方式 */
function resolveCardAuthMode(provider, gatewayAuth) {
  if (gatewayAuth === 'oauth' || gatewayAuth === 'api_key') return gatewayAuth;
  if (gatewayAuth === 'both') {
    if (provider.auth_type === 'oauth' || provider.credentials?.refresh_token) return 'oauth';
    if (provider.token) return 'api_key';
    return 'oauth';
  }
  return null;
}

/** 合并个人页 API 订阅 / 自定义订阅到 providers 列表 */
function mergeCustomSubscriptionProviders(resolved, metaMap, userSubs, paidIds = [], t) {
  const providers = [...resolved];
  const meta = { ...metaMap };
  const allow = new Set(paidIds || []);

  for (const sub of userSubs || []) {
    const isApiSub = sub.subscription_kind === 'api';
    if (!sub.custom && !isApiSub) continue;
    const id = isApiSub ? (sub.plan_provider_id || sub.source_id) : sub.source_id;
    if (!id) continue;
    const useApi = isApiSub || sub.subscription_to_api === true;
    if (!useApi || !allow.has(id)) continue;

    if (!providers.find(p => p.id === id)) {
      providers.push({
        id,
        type: 'paid',
        enabled: false,
        token: '',
        base_url: '',
        models: [],
        displayName: sub.app_name || id,
      });
    } else {
      const existing = providers.find(p => p.id === id);
      if (sub.app_name) existing.displayName = sub.app_name;
    }
    if (!meta[id]) {
      meta[id] = {
        icon: sub.app_icon || '🔧',
        label: sub.app_name || id,
        hint: t(isApiSub ? 'providers.hint.apiSub' : 'providers.hint.customSub'),
        keyless: false,
        key_prefix: [],
        signup_url: '',
      };
    }
  }
  return { providers, meta };
}

function StatsOnlyHint({ names }) {
  const { t, lang } = useLang();
  if (!names?.length) return null;
  const sep = lang === 'en' ? ', ' : '、';
  return (
    <p className="text-xs text-gray-500 dark:text-gray-400">
      {t('providers.statsOnly', { names: names.join(sep) })}
    </p>
  );
}

function PersonalPageHint({ onGo }) {
  const { t } = useLang();
  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/80 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
      <p>
        {t('providers.personalPage.before')}
        <strong className="mx-1">{t('providers.personalPage.profile')}</strong>
        {t('providers.personalPage.after')}
      </p>
      <button type="button" onClick={onGo}
        className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300 hover:underline">
        {t('providers.personalPage.go')}
      </button>
    </div>
  );
}

function Toggle({ enabled, onChange }) {
  return (
    <div onClick={onChange}
      className={`relative w-9 h-5 rounded-full cursor-pointer transition-colors shrink-0 ${enabled ? 'bg-blue-600' : 'bg-gray-600'}`}>
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </div>
  );
}

// ── P2P Network Card ──────────────────────────────────────────────────────────

function P2PNetworkCard({ provider, onUpdate }) {
  const { t } = useLang();
  const navigate   = useNavigate();
  const [network,  setNetwork]  = useState(null);
  const [balance,  setBalance]  = useState(null);
  const [loading,  setLoading]  = useState(true);

  // P2P gateway API key config
  const [showKeyConfig, setShowKeyConfig] = useState(false);
  const [apiKeys,       setApiKeys]       = useState([]);   // [{id, key, note, is_active}]
  const [selectedKey,   setSelectedKey]   = useState('');   // key string currently selected
  const [savedKey,      setSavedKey]      = useState('');   // key string saved in local-config
  const [keySaving,     setKeySaving]     = useState(false);
  const [keySaved,      setKeySaved]      = useState(false);
  const [keysLoading,   setKeysLoading]   = useState(false);
  const [newNote,       setNewNote]       = useState('');
  const [creating,      setCreating]      = useState(false);
  const [deletingId,    setDeletingId]    = useState(null);

  // Load saved key from local-config, and backend keys when section opens
  useEffect(() => {
    getLocalConfig().get().then(cfg => {
      const t = cfg.cloud_config?.token || '';
      setSavedKey(t);
      if (t) setSelectedKey(t);
    }).catch(() => {});
  }, []);

  function reloadKeys(preselectKey) {
    setKeysLoading(true);
    listKeys()
      .then(r => {
        const keys = (r.data?.keys || r.data || []).filter(k => k.is_active);
        setApiKeys(keys);
        const target = preselectKey || selectedKey;
        if (keys.length > 0 && !keys.some(k => k.key === target)) {
          setSelectedKey(keys[0].key);
        } else if (preselectKey) {
          setSelectedKey(preselectKey);
        }
      })
      .catch(() => {})
      .finally(() => setKeysLoading(false));
  }

  useEffect(() => {
    if (!showKeyConfig) return;
    reloadKeys();
  }, [showKeyConfig]);

  async function handleCreate() {
    setCreating(true);
    try {
      const r = await createKey(newNote.trim() || undefined);
      const newKey = r.data?.key || r.data;
      setNewNote('');
      reloadKeys(newKey?.key || newKey);
    } catch (e) {
      alert(t('providers.err.createFailed', { msg: e.message || t('providers.err.unknown') }));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(keyId, keyStr) {
    setDeletingId(keyId);
    try {
      await deleteKey(keyId);
      const remaining = apiKeys.filter(k => k.id !== keyId);
      setApiKeys(remaining);
      if (selectedKey === keyStr) setSelectedKey(remaining[0]?.key || '');
      if (savedKey === keyStr) setSavedKey('');
    } catch (e) {
      alert(t('providers.err.deleteFailed', { msg: e.message || t('providers.err.unknown') }));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSaveKey() {
    if (!selectedKey) return;
    setKeySaving(true);
    try {
      await getLocalConfig().setCloudConfig({
        url:   normalizeServerBase(getServerUrl()),
        token: selectedKey,
      });
      await syncCloudConfigUrl(getServerUrl());
      setSavedKey(selectedKey);
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 2000);
    } catch (e) {
      alert(t('providers.err.saveFailed', { msg: e.message }));
    } finally {
      setKeySaving(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [netRes, profRes] = await Promise.allSettled([getNetwork(), getProfile()]);
        if (cancelled) return;
        if (netRes.status === 'fulfilled') setNetwork(netRes.value.data);
        if (profRes.status === 'fulfilled') setBalance(profRes.value.data?.credits_balance ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Aggregate per-model stats from worker list
  const modelStats = React.useMemo(() => {
    if (!network?.workers) return [];
    const map = {};
    for (const w of network.workers) {
      for (const m of (w.models || [])) {
        if (!map[m]) map[m] = { name: m, nodes: 0, totalLatency: 0, latencyCount: 0, activeReqs: 0 };
        map[m].nodes++;
        if (w.avg_latency_ms > 0) {
          map[m].totalLatency += w.avg_latency_ms;
          map[m].latencyCount++;
        }
        map[m].activeReqs += w.active_requests || 0;
      }
    }
    return Object.values(map).sort((a, b) => b.nodes - a.nodes);
  }, [network]);

  const totalNodes = network?.summary?.online_workers ?? 0;

  function ModelDot({ m }) {
    if (m.nodes === 0) return <span className="w-2 h-2 rounded-full bg-gray-600 shrink-0" />;
    return <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />;
  }

  function ModelSub({ m }) {
    if (m.nodes === 0) return <span className="text-gray-600">{t('providers.p2p.unavailable')}</span>;
    const avgS = m.latencyCount > 0 ? (m.totalLatency / m.latencyCount / 1000).toFixed(1) : null;
    return (
      <>
        <span>{t('providers.p2p.nodeCount', { n: m.nodes })}</span>
        {avgS
          ? <span className="text-gray-500"> · avg {avgS}s</span>
          : <span className="text-green-600 dark:text-green-400">{t('providers.p2p.idle')}</span>}
      </>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base shrink-0">🌐</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{t('providers.meta.tokenbank-p2p.label')}</span>
              {provider.enabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400 border border-green-300 dark:border-green-800/50">
                  {t('providers.p2p.running')}
                </span>
              )}
            </div>
            <Toggle enabled={provider.enabled} onChange={() => onUpdate('tokenbank-p2p', { enabled: !provider.enabled })} />
          </div>
          {!loading && (
            <p className="text-xs text-gray-500 mt-1">
              {balance !== null ? t('providers.p2p.balance', { n: Math.round(balance) }) : ''}
              {balance !== null && totalNodes > 0 ? ' · ' : ''}
              {totalNodes > 0 ? t('providers.p2p.nodes', { n: totalNodes }) : t('providers.p2p.fetchingNodes')}
            </p>
          )}
          {loading && <p className="text-xs text-gray-600 mt-1">{t('providers.p2p.loading')}</p>}
        </div>
      </div>

      {/* Model grid */}
      {provider.enabled && (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {t('providers.p2p.modelsTitle')} <span className="text-gray-700">{t('providers.p2p.modelsSub')}</span>
            </span>
            <button onClick={() => navigate('/network')}
              className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 flex items-center gap-1">
              {t('providers.p2p.globalNetwork')}
            </button>
          </div>
          {modelStats.length === 0 && !loading ? (
            <p className="text-xs text-gray-600 py-2">{t('providers.p2p.noNodes')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {(modelStats.length > 0 ? modelStats : Array(4).fill(null)).map((m, i) => (
                m ? (
                  <div key={m.name} className="bg-gray-100 dark:bg-gray-800 border border-gray-300/50 dark:border-gray-700/50 rounded-xl px-3 py-2.5 flex items-center gap-2.5">
                    <ModelDot m={m} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{m.name}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        <ModelSub m={m} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="bg-gray-100/50 dark:bg-gray-800/50 border border-gray-300/30 dark:border-gray-700/30 rounded-xl px-3 py-2.5 h-14 animate-pulse" />
                )
              ))}
            </div>
          )}
        </div>
      )}

      {/* Gateway API Key config */}
      <div className="border-t border-gray-100 dark:border-gray-800">
          <button
            onClick={() => setShowKeyConfig(v => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
          >
            <span className="flex items-center gap-2">
              <span>{t('providers.p2p.gatewayKey')}</span>
              {savedKey
                ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-800/40">{t('providers.p2p.configured')}</span>
                : <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800/40">{t('providers.p2p.notConfigured')}</span>
              }
            </span>
            <span className="text-gray-400">{showKeyConfig ? '▲' : '▼'}</span>
          </button>

          {showKeyConfig && (
            <div className="px-4 pb-4 space-y-3">
              <p className="text-[11px] text-gray-500">{t('providers.p2p.keyHint')}</p>

              {keysLoading ? (
                <p className="text-xs text-gray-400">{t('providers.common.loading')}</p>
              ) : (
                <div className="space-y-2">
                  {/* Key list */}
                  {apiKeys.length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500">{t('providers.p2p.noKeys')}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {apiKeys.map(k => (
                        <div key={k.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                          selectedKey === k.key
                            ? 'border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/20'
                            : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:border-gray-300 dark:hover:border-gray-600'
                        }`} onClick={() => { setSelectedKey(k.key); setKeySaved(false); }}>
                          <div className="flex-1 min-w-0">
                            {k.note && <p className="text-xs text-gray-700 dark:text-gray-300 truncate">{k.note}</p>}
                            <p className="text-[10px] font-mono text-gray-400 dark:text-gray-500">
                              {k.key.slice(0, 14)}…
                              {k.key === savedKey && <span className="ml-1.5 text-green-500">{t('providers.p2p.inUse')}</span>}
                            </p>
                          </div>
                          <button
                            onClick={e => { e.stopPropagation(); handleDelete(k.id, k.key); }}
                            disabled={deletingId === k.id}
                            className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 text-sm leading-none disabled:opacity-40 shrink-0 transition-colors"
                          >
                            {deletingId === k.id ? '…' : '×'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Save selected */}
                  {selectedKey && selectedKey !== savedKey && (
                    <button onClick={handleSaveKey} disabled={keySaving}
                      className="w-full px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors">
                      {keySaving ? t('providers.p2p.saving') : keySaved ? t('providers.p2p.savedKey') : t('providers.p2p.setGatewayKey')}
                    </button>
                  )}

                  {/* Create new key */}
                  <div className="flex gap-2 pt-1 border-t border-gray-100 dark:border-gray-800">
                    <input
                      value={newNote}
                      onChange={e => setNewNote(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreate()}
                      placeholder={t('providers.p2p.notePlaceholder')}
                      className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
                    />
                    <button onClick={handleCreate} disabled={creating}
                      className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 text-xs text-gray-700 dark:text-gray-300 rounded-lg transition-colors whitespace-nowrap">
                      {creating ? t('providers.p2p.creating') : t('providers.p2p.newKey')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
  );
}

function StatusBadge({ enabled, hasKey, keyless }) {
  const { t } = useLang();
  if (!enabled) return null;
  const connected = keyless || hasKey;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
      connected
        ? 'bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400 border-green-300 dark:border-green-800/50'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 border-gray-300 dark:border-gray-700'
    }`}>
      {connected ? t('providers.badge.enabled') : t('providers.badge.needsConfig')}
    </span>
  );
}

// Normalize a model entry to {name, type} — handles both string and object formats
function normModel(m) {
  return typeof m === 'string' ? { name: m, type: 'chat' } : { name: m.name, type: m.type || 'chat' };
}

/** 按量供给源：剔除个人页未配置的模型 */
function filterPaygModels(models, providerId, userPayg) {
  const allowed = new Set(buildPaygProfileModels(providerId, userPayg));
  return (models || []).map(normModel).filter(m => allowed.has(m.name));
}

function ModelListEditor({ models = [], onChange, scrollable = false, suggestions = [], profileOnly = false }) {
  const { t } = useLang();
  const [input,     setInput]     = useState('');
  const [inputType, setInputType] = useState('chat');
  const [open,      setOpen]      = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [menuStyle, setMenuStyle] = useState(null);
  const inputRef = useRef(null);

  const normalized = models.map(normModel);
  const existingNames = useMemo(() => new Set(normalized.map(m => m.name)), [normalized]);
  const allowedSet = useMemo(() => new Set(suggestions || []), [suggestions]);

  const filteredSuggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    return (suggestions || [])
      .filter(name => !existingNames.has(name))
      .filter(name => !q || name.toLowerCase().includes(q))
      .slice(0, 10);
  }, [suggestions, input, existingNames]);

  const showSuggestions = open && filteredSuggestions.length > 0;

  function canAdd(name) {
    const n = (name ?? input).trim();
    if (!n || existingNames.has(n)) return false;
    if (profileOnly && !allowedSet.has(n)) return false;
    return true;
  }

  // 下拉挂到 body，避免被卡片 overflow-hidden 裁切
  const updateMenuPosition = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxH = 160;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < Math.min(maxH, filteredSuggestions.length * 32) && spaceAbove > spaceBelow;
    const height = Math.min(maxH, openUp ? spaceAbove : spaceBelow);
    setMenuStyle({
      left: rect.left,
      width: rect.width,
      top: openUp ? rect.top - gap - height : rect.bottom + gap,
      maxHeight: Math.max(height, 80),
    });
  }, [filteredSuggestions.length]);

  useEffect(() => {
    setActiveIdx(0);
  }, [filteredSuggestions.length, input]);

  useEffect(() => {
    if (!showSuggestions) {
      setMenuStyle(null);
      return;
    }
    updateMenuPosition();
    window.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      window.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [showSuggestions, updateMenuPosition]);

  function add(nameOverride) {
    const n = (nameOverride ?? input).trim();
    if (!canAdd(n)) { setInput(''); setOpen(false); return; }
    onChange([...normalized, { name: n, type: inputType }]);
    setInput('');
    setOpen(false);
  }

  function remove(name)     { onChange(normalized.filter(m => m.name !== name)); }
  function toggleType(name) {
    onChange(normalized.map(m => m.name === name ? { ...m, type: m.type === 'chat' ? 'image' : 'chat' } : m));
  }

  function handleInputKeyDown(e) {
    if (!open || filteredSuggestions.length === 0) {
      if (e.key === 'Enter') { e.preventDefault(); if (canAdd()) add(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => (i + 1) % filteredSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => (i - 1 + filteredSuggestions.length) % filteredSuggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(filteredSuggestions[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const suggestionMenu = showSuggestions && menuStyle && createPortal(
    <ul
      style={{ position: 'fixed', left: menuStyle.left, top: menuStyle.top, width: menuStyle.width, maxHeight: menuStyle.maxHeight, zIndex: 9999 }}
      className="overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg py-1"
      role="listbox"
    >
      {filteredSuggestions.map((name, i) => (
        <li key={name} role="option" aria-selected={i === activeIdx}>
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); add(name); }}
            className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
              i === activeIdx
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            {name}
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  );

  return (
    <div className="space-y-2">
      {/* existing model tags */}
      {normalized.length > 0 && (
        <div className={scrollable ? 'max-h-36 overflow-y-auto pr-1' : ''}>
          <div className="flex flex-wrap gap-1.5">
            {normalized.map(m => (
              <span key={m.name} className="inline-flex items-center gap-0 text-xs bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg overflow-hidden font-mono">
                <span className="px-2 py-0.5">{m.name}</span>
                <button
                  onClick={() => toggleType(m.name)}
                  title={t('providers.models.toggleType')}
                  className={`px-1.5 py-0.5 text-[10px] font-sans border-l border-gray-300 dark:border-gray-700 transition-colors ${
                    m.type === 'image'
                      ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-800/60'
                      : 'bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40'
                  }`}>
                  {m.type === 'image' ? t('providers.models.typeImage') : t('providers.models.typeText')}
                </button>
                <button onClick={() => remove(m.name)} className="px-1.5 py-0.5 border-l border-gray-300 dark:border-gray-700 text-gray-400 hover:text-red-500 dark:hover:text-red-400 leading-none">×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      {/* add input with type picker + suggestions */}
      <div className="flex gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); setOpen(true); requestAnimationFrame(updateMenuPosition); }}
            onFocus={() => { setOpen(true); requestAnimationFrame(updateMenuPosition); }}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={handleInputKeyDown}
            placeholder={profileOnly ? t('providers.models.paygPickPlaceholder') : t('providers.models.placeholder')}
            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
            autoComplete="off"
            role="combobox"
            aria-expanded={showSuggestions}
            aria-autocomplete="list"
          />
          {suggestionMenu}
        </div>
        <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600 shrink-0 text-[10px] font-medium">
          {[['chat', t('providers.models.chat')], ['image', t('providers.models.image')]].map(([typeKey, label]) => (
            <button key={typeKey} type="button" onClick={() => setInputType(typeKey)}
              className={`px-2 py-1.5 transition-colors ${
                inputType === typeKey
                  ? typeKey === 'chat' ? 'bg-blue-600 text-white' : 'bg-purple-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
              }`}>
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => add()}
          disabled={!canAdd()}
          className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 text-xs text-gray-700 dark:text-gray-300 rounded-lg transition-colors whitespace-nowrap"
        >
          {t('providers.models.add')}
        </button>
      </div>
      {profileOnly && suggestions.length === 0 && (
        <p className="text-[11px] text-gray-400">{t('providers.models.paygNoProfileModels')}</p>
      )}
      {normalized.length === 0 && !profileOnly && (
        <p className="text-[11px] text-gray-400">{t('providers.models.emptyHint')}</p>
      )}
    </div>
  );
}

/** 供给源卡片内模型区；按量供给源可独立编辑，新增供给源引导去个人页 */
function ProviderModelSection({ provider, userPayg, onGoPayg, onUpdate, scrollable = false, providerPricing = {}, paygCatalog = [] }) {
  const { t } = useLang();
  const isPayg = isPaygManagedProvider(provider.id, userPayg);
  const models = provider.models || [];
  const modelCount = models.length;
  const profileModels = useMemo(
    () => (isPayg ? buildPaygProfileModels(provider.id, userPayg) : []),
    [isPayg, provider.id, userPayg],
  );
  const suggestions = useMemo(
    () => (isPayg
      ? profileModels
      : buildModelSuggestions(provider.id, userPayg, providerPricing, paygCatalog)),
    [isPayg, provider.id, userPayg, providerPricing, paygCatalog, profileModels],
  );

  function handleModelsChange(next) {
    let out = next;
    if (isPayg) {
      const allowed = new Set(profileModels);
      out = next.map(normModel).filter(m => allowed.has(m.name));
    }
    onUpdate(provider.id, { models: out });
  }

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">{t('providers.models.list')}</span>
        {modelCount > 0
          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40">{t('providers.models.count', { n: modelCount })}</span>
          : <span className="text-[10px] text-gray-400">{t('providers.models.unlimited')}</span>
        }
      </div>
      <ModelListEditor
        models={models}
        onChange={handleModelsChange}
        scrollable={scrollable}
        suggestions={suggestions}
        profileOnly={isPayg}
      />
      {isPayg && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {t('providers.models.paygHint')}{' '}
          <button type="button" onClick={onGoPayg}
            className="text-emerald-600 dark:text-emerald-400 hover:underline">
            {t('providers.models.goPaygProfile')}
          </button>
        </p>
      )}
    </div>
  );
}

function CustomProviderCard({ provider, onUpdate, onRemove, onTest, userPayg = [], onGoPayg, providerPricing = {}, paygCatalog = [] }) {
  const { t } = useLang();
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');

  const displayLabel = provider.displayName || provider.label || (() => {
    try { const h = new URL(provider.base_url || '').hostname; return h || t('providers.custom.defaultName'); } catch { return t('providers.custom.defaultName'); }
  })();

  async function handleTest() {
    if (!provider.base_url) { setTestMsg(t('providers.test.needBaseUrl')); return; }
    setTesting(true); setTestMsg('');
    try {
      const result = await onTest(provider);
      setTestMsg(result.ok ? t('providers.test.success') : `✗ ${result.error || `HTTP ${result.status}`}`);
    } catch (e) {
      setTestMsg(`✗ ${e.message || t('providers.err.unknown')}`);
    } finally {
      setTimeout(() => setTestMsg(''), 3000);
      setTesting(false);
    }
  }

  return (
    <div className={`bg-white dark:bg-gray-900 border rounded-2xl overflow-hidden transition-opacity ${
      provider.enabled ? 'border-gray-200 dark:border-gray-800' : 'border-gray-200 dark:border-gray-800 opacity-50'
    }`}>
      <div className="flex items-start gap-3 p-4">
        <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base shrink-0">🔗</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-sm font-medium truncate ${provider.enabled ? 'text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'}`}>
                {displayLabel}
              </span>
              {provider.enabled && provider.base_url && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400 border border-green-300 dark:border-green-800/50 shrink-0">
                  {t('providers.badge.enabled')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {provider.enabled && provider.base_url && (
                <button onClick={handleTest} disabled={testing}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
                  {testing ? '…' : t('providers.common.test')}
                </button>
              )}
              <Toggle enabled={provider.enabled} onChange={() => onUpdate(provider.id, { enabled: !provider.enabled })} />
              <button onClick={() => onRemove(provider.id)}
                title={t('providers.custom.removeTitle')}
                className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 text-lg leading-none transition-colors">×</button>
            </div>
          </div>

          {testMsg && (
            <p className={`text-xs mt-1 ${testMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{testMsg}</p>
          )}

          {/* Base URL + Token inputs */}
          <div className="mt-3 space-y-2">
            <input
              value={provider.base_url || ''}
              onChange={e => onUpdate(provider.id, { base_url: e.target.value })}
              onBlur={e => {
                const v = e.target.value.replace(/\/v1\/?$/, '').replace(/\/$/, '');
                if (v !== e.target.value) onUpdate(provider.id, { base_url: v });
              }}
              placeholder={t('providers.custom.baseUrlPlaceholder')}
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <div className="flex gap-2">
              <input
                value={provider.token || ''}
                onChange={e => onUpdate(provider.id, { token: e.target.value })}
                type={showKey ? 'text' : 'password'}
                placeholder={t('providers.custom.apiKeyOptional')}
                autoComplete="off"
                className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
              <button onClick={() => setShowKey(v => !v)}
                className="shrink-0 px-2.5 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                {showKey ? t('providers.common.hide') : t('providers.common.show')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Model list — 按量供给源模型来自个人页 */}
      <ProviderModelSection
        provider={provider}
        userPayg={userPayg}
        onGoPayg={onGoPayg}
        onUpdate={onUpdate}
        scrollable
        providerPricing={providerPricing}
        paygCatalog={paygCatalog}
      />
    </div>
  );
}

function ProviderCard({ provider, meta, onUpdate, onTest, initialExpanded = false, gatewayAuthMode = null, userPayg = [], onGoPayg, providerPricing = {}, paygCatalog = [] }) {
  const { t } = useLang();
  const [showKey,    setShowKey]    = useState(false);
  const [expanded,   setExpanded]   = useState(initialExpanded);
  const [testing,    setTesting]    = useState(false);
  const [testMsg,    setTestMsg]    = useState('');

  meta = meta || {};
  const isP2P    = provider.type === 'p2p';
  const oauthCap = meta.oauth || null;                 // 该预设支持的 OAuth 登录（可选）
  const forceOauth  = gatewayAuthMode === 'oauth';
  const forceApiKey = gatewayAuthMode === 'api_key';
  const isOauthCfg = forceOauth || provider.auth_type === 'oauth';
  const hasOauth = !!(provider.credentials && provider.credentials.refresh_token);
  const hasKey   = !isOauthCfg && !!provider.token;
  const billingType    = forceApiKey ? 'api-key' : (provider.billing_type || 'api-key');
  const subMode        = forceOauth ? 'api-proxy' : (provider.sub_mode || 'accounting');
  const isSubscription = forceOauth || billingType === 'subscription';
  // 付费层：订阅转 API 走 OAuth；按量走 API Key
  const configured = forceOauth
    ? hasOauth
    : forceApiKey
      ? hasKey
      : ((meta.keyless && !oauthCap) || hasKey || hasOauth || (isSubscription && subMode === 'accounting'));
  const canApiKey = !meta.keyless && !forceOauth;
  const showOauthUi = forceOauth ? !!oauthCap : (oauthCap && (!forceApiKey));
  const showApiKeyUi = forceApiKey || (canApiKey && !forceOauth);

  // 添加方式：api_key / oauth（按量可切换；订阅转 API 固定 OAuth）
  const [method, setMethod] = useState(forceOauth || isOauthCfg ? 'oauth' : 'api_key');
  const [oauth, setOauth] = useState({ sessionId: '', code: '', busy: false, msg: '', started: false, mode: '', userCode: '' });
  const pollRef = useRef(false);

  function resetOauth() { setOauth({ sessionId: '', code: '', busy: false, msg: '', started: false, mode: '', userCode: '' }); }

  function saveOauthCreds(r) {
    onUpdate(provider.id, {
      auth_type: 'oauth', oauth_provider: r.oauth_provider,
      credentials: r.credentials, token: '', enabled: true,
    });
    resetOauth();
    setExpanded(false);
  }

  async function startOauth() {
    if (!oauthCap) return;
    setOauth(o => ({ ...o, busy: true, msg: '' }));
    try {
      const api = getOauth();
      const r = await api.start(oauthCap.provider, {});
      if (r.mode === 'device' || r.mode === 'loopback') {
        const openUrl = r.verificationUrl || r.authUrl;
        if (openUrl) await api.openExternal(openUrl);
        setOauth(o => ({ ...o, busy: false, started: true, mode: r.mode, sessionId: r.sessionId, userCode: r.userCode || '' }));
        pollRef.current = true;
        pollDevice(r.sessionId);
      } else if (r.mode === 'paste') {
        setOauth(o => ({ ...o, busy: false, started: true, mode: 'paste', sessionId: r.sessionId }));
      } else {
        if (r.authUrl) await api.openExternal(r.authUrl);
        setOauth(o => ({ ...o, busy: false, started: true, mode: 'pkce', sessionId: r.sessionId }));
      }
    } catch (e) { setOauth(o => ({ ...o, busy: false, msg: e.message || t('providers.err.loginFailed') })); }
  }

  async function pollDevice(sessionId) {
    const api = getOauth();
    for (let i = 0; i < 60 && pollRef.current; i++) {
      await new Promise(res => setTimeout(res, 5000));
      if (!pollRef.current) return;
      let r;
      try { r = await api.poll(sessionId); }
      catch (e) { pollRef.current = false; setOauth(o => ({ ...o, msg: e.message || t('providers.err.pollFailed'), started: false })); return; }
      if (r.done) { pollRef.current = false; saveOauthCreds(r); return; }
    }
  }

  // pkce 粘贴 code / paste 粘贴凭证：都走 exchange
  async function finishOauth() {
    setOauth(o => ({ ...o, busy: true, msg: '' }));
    try {
      const r = await getOauth().exchange(oauth.sessionId, oauth.code.trim());
      saveOauthCreds(r);
    } catch (e) { setOauth(o => ({ ...o, busy: false, msg: e.message || t('providers.err.exchangeFailed') })); }
  }

  function cancelOauth() { pollRef.current = false; resetOauth(); }

  function clearOauth() {
    pollRef.current = false;
    onUpdate(provider.id, { auth_type: 'api_key', oauth_provider: '', credentials: null });
    setMethod('api_key');
  }

  async function handleTest() {
    if (!provider.base_url) { setTestMsg(t('providers.test.needBaseUrl')); return; }
    setTesting(true); setTestMsg('');
    try {
      const result = await onTest(provider);
      setTestMsg(result.ok ? t('providers.test.success') : `✗ ${result.error || `HTTP ${result.status}`}`);
    } catch (e) {
      setTestMsg(`✗ ${e.message || t('providers.err.unknown')}`);
    } finally {
      setTimeout(() => setTestMsg(''), 3000);
      setTesting(false);
    }
  }

  return (
    <div className={`bg-white dark:bg-gray-900 border rounded-2xl overflow-hidden transition-opacity ${
      provider.enabled ? 'border-gray-200 dark:border-gray-800' : 'border-gray-200 dark:border-gray-800 opacity-50'
    }`}>
      <div className="flex items-start gap-3 p-4">
        {/* Icon */}
        <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base shrink-0">
          {meta.icon}
        </div>
        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-sm font-medium ${provider.enabled ? 'text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'}`}>
                {meta.label}
              </span>
              <StatusBadge enabled={provider.enabled} hasKey={hasKey || hasOauth} keyless={meta.keyless && !oauthCap} />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!isP2P && provider.enabled && (
                <button onClick={handleTest} disabled={testing}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
                  {testing ? '…' : t('providers.common.test')}
                </button>
              )}
              <Toggle enabled={provider.enabled} onChange={() => onUpdate(provider.id, { enabled: !provider.enabled })} />
            </div>
          </div>

          {/* Hint / status text */}
          {testMsg ? (
            <p className={`text-xs mt-1 ${testMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{testMsg}</p>
          ) : (
            <p className="text-xs text-gray-500 mt-1">
              {forceOauth ? t('providers.card.hint.oauth') : forceApiKey ? t('providers.card.hint.apiKey') : meta.hint}
            </p>
          )}

          {/* Configured (collapsed) row */}
          {!isP2P && !(meta.keyless && !oauthCap) && configured && !expanded && (
            <div className="mt-2 space-y-1">
              <div className="flex items-center gap-2">
                {isSubscription ? (
                  <code className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1 rounded font-mono">
                    {t('providers.card.sub')}{subMode === 'accounting' ? t('providers.card.subAccounting') : t('providers.card.subApiProxy')}
                  </code>
                ) : isOauthCfg ? (
                  <code className="text-xs text-purple-600 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/30 px-2 py-1 rounded font-mono">
                    {t('providers.card.loggedIn')}{provider.credentials?.email ? ' · ' + provider.credentials.email : ''}
                  </code>
                ) : (
                  <code className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded font-mono">
                    {hasKey ? provider.token.slice(0, 4) + '•'.repeat(12) : t('providers.card.notConfigured')}
                  </code>
                )}
                <button onClick={() => { setExpanded(true); setMethod(isOauthCfg ? 'oauth' : 'api_key'); }} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-300">{t('providers.common.edit')}</button>
              </div>
              {provider.base_url && (
                <p className="text-[11px] text-gray-400 dark:text-gray-600 font-mono break-all">{provider.base_url}</p>
              )}
            </div>
          )}

          {/* Inline setup / edit panel */}
          {!isP2P && (showApiKeyUi || showOauthUi) && (!configured || expanded) && (
            <div className="mt-3 space-y-2">
              {/* 计费方式切换（仅非付费层强制模式时显示） */}
              {canApiKey && !forceOauth && !forceApiKey && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{t('providers.card.billingMode')}</span>
                  <div className="inline-flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden text-xs">
                    <button onClick={() => onUpdate(provider.id, { billing_type: 'api-key' })}
                      className={billingType === 'api-key' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}>API Key</button>
                    <button onClick={() => onUpdate(provider.id, { billing_type: 'subscription' })}
                      className={isSubscription ? 'px-3 py-1 bg-amber-500 text-white' : 'px-3 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}>{t('providers.card.subscription')}</button>
                  </div>
                </div>
              )}

              {/* 订阅接入方式（非付费层强制 OAuth 时可选） */}
              {isSubscription && !forceApiKey && !forceOauth && oauthCap && (
                <div className="space-y-2 pl-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500 shrink-0">{t('providers.card.accessMode')}</span>
                    <div className="inline-flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden text-xs">
                      <button onClick={() => onUpdate(provider.id, { sub_mode: 'accounting' })}
                        className={subMode === 'accounting' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}>{t('providers.card.accountingOnly')}</button>
                      <button onClick={() => onUpdate(provider.id, { sub_mode: 'api-proxy' })}
                        className={subMode === 'api-proxy' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}>{t('providers.card.subToApi')}</button>
                    </div>
                  </div>
                  {subMode === 'accounting' && (
                    <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('providers.card.accountingHint')}</p>
                  )}
                </div>
              )}

              {/* API Key / OAuth 切换（同时登记订阅与按量时） */}
              {!isSubscription && canApiKey && oauthCap && !forceOauth && !forceApiKey && (
                <div className="inline-flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden text-xs">
                  <button onClick={() => setMethod('api_key')}
                    className={method === 'api_key' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}>API Key</button>
                  <button onClick={() => setMethod('oauth')}
                    className={method === 'oauth' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}>{oauthCap.label}</button>
                </div>
              )}

              {/* API Key 方式 */}
              {showApiKeyUi && !isSubscription && (!oauthCap || method === 'api_key' || forceApiKey) && (
                <>
                  <div className="flex gap-2">
                    <input
                      value={provider.token}
                      onChange={e => onUpdate(provider.id, { token: e.target.value, auth_type: 'api_key' })}
                      type={showKey ? 'text' : 'password'}
                      placeholder={t('providers.card.pasteApiKey')}
                      autoComplete="off"
                      className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                    <button onClick={() => setShowKey(v => !v)}
                      className="shrink-0 px-2.5 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                      {showKey ? t('providers.common.hide') : t('providers.common.show')}
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    {meta.signup_url && (
                      <a href={meta.signup_url} target="_blank" rel="noreferrer"
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{t('providers.card.getKey')}</a>
                    )}
                  </div>
                </>
              )}

              {/* OAuth 订阅登录 */}
              {showOauthUi && (!canApiKey || method === 'oauth' || (isSubscription && subMode === 'api-proxy') || forceOauth) && (
                <div className="space-y-2">
                  {forceOauth && !oauthCap && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('providers.card.oauthUnsupported')}</p>
                  )}
                  {hasOauth && (
                    <p className="text-xs text-green-600 dark:text-green-400">
                      {t('providers.card.oauthLoggedIn')}{provider.credentials?.email ? ' · ' + provider.credentials.email : ''}
                      <button onClick={clearOauth} className="ml-2 text-gray-500 hover:text-red-500">{t('providers.card.logout')}</button>
                    </p>
                  )}
                  {!oauth.started && (
                    <button onClick={startOauth} disabled={oauth.busy}
                      className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-blue-600 dark:text-blue-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50">
                      {oauth.busy ? '…' : (hasOauth ? t('providers.card.relogin') : t('providers.card.login', { label: oauthCap.label }))}
                    </button>
                  )}

                  {/* 设备码流（Codex / Copilot）+ loopback 流（Gemini）：自动轮询完成 */}
                  {oauth.started && (oauth.mode === 'device' || oauth.mode === 'loopback') && (
                    <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
                      {oauth.userCode ? (
                        <>
                          <p>{t('providers.card.deviceCodeHint')}</p>
                          <p className="font-mono text-base tracking-widest text-blue-600 dark:text-blue-400 select-all">{oauth.userCode}</p>
                        </>
                      ) : (
                        <p>{t('providers.card.browserAuthHint')}</p>
                      )}
                      <p className="text-gray-400">{t('providers.card.autoLoginHint')}<button onClick={cancelOauth} className="ml-2 text-gray-500 hover:text-red-500">{t('providers.common.cancel')}</button></p>
                    </div>
                  )}

                  {/* PKCE 流（Claude）：粘贴回调 code */}
                  {oauth.started && oauth.mode === 'pkce' && (
                    <div className="flex gap-2">
                      <input value={oauth.code} onChange={e => setOauth(o => ({ ...o, code: e.target.value }))}
                        placeholder={t('providers.card.codePlaceholder')}
                        className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
                      <button onClick={finishOauth} disabled={oauth.busy || !oauth.code.trim()}
                        className="shrink-0 px-3 text-xs rounded-lg bg-blue-600 text-white disabled:opacity-50">{t('providers.card.finishStep')}</button>
                    </div>
                  )}

                  {/* 粘贴流（Gemini）：粘贴 ya29 token 或 oauth_creds.json */}
                  {oauth.started && oauth.mode === 'paste' && (
                    <div className="space-y-2">
                      <textarea value={oauth.code} onChange={e => setOauth(o => ({ ...o, code: e.target.value }))}
                        placeholder={t('providers.card.pasteTokenPlaceholder')} rows={3}
                        className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-blue-500" />
                      <button onClick={finishOauth} disabled={oauth.busy || !oauth.code.trim()}
                        className="px-3 py-1 text-xs rounded-lg bg-blue-600 text-white disabled:opacity-50">{t('providers.card.finish')}</button>
                    </div>
                  )}

                  {oauth.msg && <p className="text-xs text-red-500">{oauth.msg}</p>}
                </div>
              )}

              {/* Base URL override */}
              <div className="space-y-1">
                <label className="text-[11px] text-gray-500 dark:text-gray-400">Base URL</label>
                <input
                  value={provider.base_url || ''}
                  onChange={e => onUpdate(provider.id, { base_url: e.target.value })}
                  type="text"
                  placeholder={t('providers.card.defaultBaseUrl')}
                  autoComplete="off"
                  className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>

              {expanded && (
                <button onClick={() => setExpanded(false)} className="text-xs text-gray-600 hover:text-gray-600 dark:text-gray-400">{t('providers.common.cancel')}</button>
              )}
            </div>
          )}

          {/* P2P info */}
          {isP2P && (
            <p className="text-xs text-gray-500 mt-1">
              {t('providers.p2p.creditsHint')}
            </p>
          )}
        </div>

        {/* "立即启用" button for unconfigured providers needing a key or OAuth login */}
        {(canApiKey || oauthCap) && !isP2P && !configured && !expanded && (
          <button onClick={() => { setExpanded(true); onUpdate(provider.id, { enabled: true }); }}
            className="shrink-0 text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-blue-600 dark:text-blue-400 border border-gray-300 dark:border-gray-700 rounded-lg transition-colors">
            {t('providers.card.enableNow')}
          </button>
        )}
      </div>

      {/* Model list section — 按量供给源模型来自个人页 */}
      {!isP2P && (
        <ProviderModelSection
          provider={provider}
          userPayg={userPayg}
          onGoPayg={onGoPayg}
          onUpdate={onUpdate}
          scrollable
          providerPricing={providerPricing}
          paygCatalog={paygCatalog}
        />
      )}
    </div>
  );
}


export default function Providers() {
  const { t } = useLang();
  const navigate = useNavigate();
  const tierConfig = useMemo(() => getTierConfig(t), [t]);
  const oauthById = useMemo(() => getOAuthById(t), [t]);
  const [providers, setProviders] = useState(FALLBACK_PROVIDERS);
  const [meta,      setMeta]      = useState(FALLBACK_PROVIDER_META);
  const [paidAllowlist, setPaidAllowlist] = useState(null);  // null=加载中
  const [providerGatewayAuth, setProviderGatewayAuth] = useState({});
  const [userSubscriptions, setUserSubscriptions] = useState([]);
  const [subscriptionCatalog, setSubscriptionCatalog] = useState([]);
  const [statsOnlyIds, setStatsOnlyIds] = useState([]);
  const [userPayg, setUserPayg] = useState([]);
  const [providerPricing, setProviderPricing] = useState({});
  const [paygCatalog, setPaygCatalog] = useState([]);
  const [savedMsg,  setSavedMsg]  = useState('');
  // Track the last value written/loaded so we skip the initial load trigger
  const lastSaved = useRef(null);
  const [addingPickerKey, setAddingPickerKey] = useState(null);
  const [addingAuthMode, setAddingAuthMode] = useState(null);
  const [gatewayPickerEntries, setGatewayPickerEntries] = useState([]);

  const loadUserPaidAccounts = useCallback(async () => {
    try {
      const r = await loadUserAccounts();
      setPaidAllowlist(r.gateway_provider_ids || []);
      setProviderGatewayAuth(r.provider_gateway_auth || {});
      setUserSubscriptions(r.user_subscriptions || []);
      setSubscriptionCatalog(r.subscription_catalog || []);
      setGatewayPickerEntries(
        r.gateway_picker_entries?.length
          ? r.gateway_picker_entries
          : buildGatewayPickerEntries(r.user_subscriptions, r.user_payg_providers, r.subscription_catalog),
      );
      setStatsOnlyIds(r.stats_only_provider_ids || []);
      setUserPayg(r.user_payg_providers || []);
      setProviderPricing(r.provider_pricing || {});
      setPaygCatalog(r.payg_provider_catalog || []);
    } catch {
      setPaidAllowlist([]);
      setUserPayg([]);
      setProviderPricing({});
      setPaygCatalog([]);
    }
  }, []);

  useEffect(() => {
    loadUserPaidAccounts();
    const unsub = window.electronAPI?.localConfig?.onBillingChanged?.(loadUserPaidAccounts);
    return () => unsub?.();
  }, [loadUserPaidAccounts]);

  useEffect(() => {
    (async () => {
      // 1) 源目录由后端下发，拉不到则回退内置兜底
      let defaults = FALLBACK_PROVIDERS;
      let metaMap  = localizeProviderMeta(FALLBACK_PROVIDER_META, t);
      try {
        const { data } = await getProviderCatalog();
        if (data?.providers?.length) {
          const s = catalogToState(data, oauthById);
          defaults = s.defaults;
          metaMap  = localizeProviderMeta(s.meta, t);
        }
      } catch { /* 离线 / VPS 不可达：用兜底目录 */ }
      setMeta(metaMap);

      // 2) 与本地配置保存的开关/token/base_url 合并（adapter 兼容 Electron/HTTP）
      const cfg = await getConfig().read();
      let resolved;
      if (cfg?.providers?.length) {
        const defaultIds = new Set(defaults.map(p => p.id));
        const mapped = defaults.map(def => {
          const saved = cfg.providers.find(p => p.id === def.id);
          return saved ? { ...def, ...saved, models: saved.models || def.models || [] } : def;
        });
        // Preserve any custom (non-catalog) providers stored in config; normalize base_url
        const custom = cfg.providers.filter(p => !defaultIds.has(p.id)).map(p => ({
          ...p,
          base_url: (p.base_url || '').replace(/\/v1\/?$/, '').replace(/\/$/, ''),
        }));
        resolved = [...mapped, ...custom];
      } else {
        resolved = defaults;
      }
      const merged = mergeUserPaygIntoProviders(resolved, metaMap, userPayg, t);
      const withCustomSubs = mergeCustomSubscriptionProviders(
        merged.providers, merged.meta, userSubscriptions, paidAllowlist || [], t,
      );
      lastSaved.current = withCustomSubs.providers;
      setProviders(withCustomSubs.providers);
      setMeta(localizeProviderMeta(withCustomSubs.meta, t));
    })();
  }, [userPayg, userSubscriptions, paidAllowlist, t, oauthById]);

  // 语言切换时刷新 meta 文案
  useEffect(() => {
    setMeta(prev => localizeProviderMeta(prev, t));
  }, [t]);

  // Auto-save with 500 ms debounce; skip initial load
  useEffect(() => {
    if (lastSaved.current === null || providers === lastSaved.current) return;
    const timer = setTimeout(async () => {
      try {
        const cfg = (await getConfig().read()) || {};
        const normalizedProviders = providers.map(p => {
          const base = meta[p.id]
            ? p
            : { ...p, base_url: (p.base_url || '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
          if (isPaygManagedProvider(p.id, userPayg)) {
            return { ...base, models: filterPaygModels(base.models, p.id, userPayg) };
          }
          return base;
        });
        await getConfig().write({ ...cfg, providers: normalizedProviders });
        lastSaved.current = providers;
        setSavedMsg(t('providers.saved'));
        setTimeout(() => setSavedMsg(''), 1500);
      } catch {}
    }, 500);
    return () => clearTimeout(timer);
  }, [providers, meta, t, userPayg]);

  const updateProvider = useCallback((id, patch) => {
    if (isPaygManagedProvider(id, userPayg) && patch.models != null) {
      patch = { ...patch, models: filterPaygModels(patch.models, id, userPayg) };
    }
    setProviders(prev => {
      const i = prev.findIndex(p => p.id === id);
      if (i < 0) {
        return [...prev, { id, type: 'paid', enabled: false, token: '', base_url: '', models: [], ...patch }];
      }
      return prev.map(p => (p.id === id ? { ...p, ...patch } : p));
    });
  }, [userPayg]);

  /** 选中选择器条目：按订阅/按量预设验证方式 */
  const selectPickerEntry = useCallback((entry) => {
    const isDeselect = addingPickerKey === entry.pickerKey;
    if (isDeselect) {
      setAddingPickerKey(null);
      setAddingId(null);
      setAddingAuthMode(null);
      return;
    }
    setAddingPickerKey(entry.pickerKey);
    setAddingId(entry.providerId);
    setAddingAuthMode(entry.authMode);
    const base = {
      id: entry.providerId,
      type: 'paid',
      enabled: false,
      token: '',
      base_url: '',
      models: [],
      displayName: entry.label,
    };
    if (entry.authMode === 'oauth') {
      updateProvider(entry.providerId, {
        ...base,
        auth_type: 'oauth',
        billing_type: 'subscription',
        sub_mode: 'api-proxy',
      });
    } else {
      updateProvider(entry.providerId, {
        ...base,
        auth_type: 'api_key',
        billing_type: 'api-key',
        credentials: null,
        oauth_provider: '',
      });
    }
  }, [addingPickerKey, updateProvider]);

  const removeProvider = useCallback((id) => {
    setProviders(prev => prev.filter(p => p.id !== id));
  }, []);

  function addCustomProvider() {
    navigate('/', { state: { accountsTab: 'payg' } });
  }

  const goPersonalPage = () => navigate('/', { state: { accountsTab: 'subscription' } });
  const goPaygProfile = () => navigate('/', { state: { accountsTab: 'payg' } });
  const paidAccountsLoaded = paidAllowlist !== null;
  const hasPersonalPaid = paidAccountsLoaded && (paidAllowlist.length > 0 || statsOnlyIds.length > 0);
  const hasGatewayPaid = paidAccountsLoaded && paidAllowlist.length > 0;
  const statsOnlyLabels = statsOnlyIds.map(id => meta[id]?.label || FALLBACK_PROVIDER_META[id]?.label || id);

  async function testProvider(p) {
    return getGateway().testProvider({
      id: p.id, base_url: p.base_url, token: p.token,
      auth_type: p.auth_type, oauth_provider: p.oauth_provider, credentials: p.credentials,
    });
  }

  const [addingTier, setAddingTier] = useState(null);  // 'free' | 'paid' | null
  const [addingId,   setAddingId]   = useState(null);  // providerId being configured in picker

  // When a provider gets enabled from the picker, deselect it
  useEffect(() => {
    if (!addingId) return;
    const p = providers.find(p => p.id === addingId);
    if (p?.enabled) {
      setAddingId(null);
      setAddingPickerKey(null);
      setAddingAuthMode(null);
    }
  }, [providers, addingId]);

  const tiers = ['free', 'p2p', 'paid'];

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('providers.title')}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{t('providers.subtitle')}</p>
        </div>
        {savedMsg && <span className="text-sm text-green-600 dark:text-green-400">{savedMsg}</span>}
      </div>

      {/* Tier sections */}
      {tiers.map(tier => {
        const cfg      = tierConfig[tier];
        const allItems = providers.filter(p => p.type === tier);

        if (tier === 'p2p') {
          return (
            <section key={tier} className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{cfg.label}</h2>
                <span className="text-xs text-gray-500">{cfg.hint}</span>
              </div>
              <div className={`grid ${cfg.cols} gap-3`}>
                {allItems.map(p => <P2PNetworkCard key={p.id} provider={p} onUpdate={updateProvider} />)}
              </div>
            </section>
          );
        }

        // 付费层：按个人页登记 id 构建池（含目录标为 free 的按量源，如 groq）
        const personalPool = tier === 'paid'
          ? buildPersonalPaidPool(providers, paidAllowlist || [], userPayg, userSubscriptions)
          : [];
        const liveState = (p) => withProviderDisplayName(providers.find(x => x.id === p.id) || p, userPayg, userSubscriptions, meta);
        const enabledItems  = tier === 'paid'
          ? personalPool.filter(p => liveState(p).enabled)
          : allItems.filter(p => p.enabled);
        const disabledItems = tier === 'paid'
          ? personalPool.filter(p => !liveState(p).enabled)
          : allItems.filter(p => !p.enabled);
        const disabledPickerEntries = tier === 'paid'
          ? gatewayPickerEntries.filter(e => !liveState({ id: e.providerId }).enabled)
          : [];
        const disabledSubEntries = disabledPickerEntries.filter(e => e.source === 'subscription');
        const disabledPaygEntries = disabledPickerEntries.filter(e => e.source === 'payg');
        const disabledCustomSubEntries = disabledSubEntries.filter(e => e.custom);
        const disabledCatalogSubEntries = disabledSubEntries.filter(e => !e.custom);
        const isOpen        = addingTier === tier;

        function togglePicker() {
          if (isOpen) {
            setAddingTier(null);
            setAddingId(null);
            setAddingPickerKey(null);
            setAddingAuthMode(null);
          } else {
            setAddingTier(tier);
          }
        }

        function renderPickerButton(entry) {
          const sel = addingPickerKey === entry.pickerKey;
          const authTag = entry.authMode === 'oauth' ? 'OAuth' : 'Key';
          return (
            <button key={entry.pickerKey} type="button" onClick={() => selectPickerEntry(entry)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-colors ${
                sel
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
              }`}>
              <span>{entry.icon}</span>
              <span>{entry.label}</span>
              <span className={`text-[10px] px-1 rounded ${
                entry.authMode === 'oauth'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
              }`}>{authTag}</span>
            </button>
          );
        }

        return (
          <section key={tier} className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{cfg.label}</h2>
              <span className="text-xs text-gray-500">{cfg.hint}</span>
            </div>

            <div className={`grid ${cfg.cols} gap-3`}>
              {/* Enabled providers */}
              {enabledItems.map(p => {
                const live = tier === 'paid' ? liveState(p) : p;
                const useCustomCard = isCustomSubscriptionGatewayId(live.id, userSubscriptions) || !meta[live.id];
                return !useCustomCard
                  ? <ProviderCard key={live.id} provider={live} meta={meta[live.id]} onUpdate={updateProvider} onTest={testProvider} gatewayAuthMode={tier === 'paid' ? resolveCardAuthMode(live, providerGatewayAuth[live.id]) : null} userPayg={userPayg} onGoPayg={goPaygProfile} providerPricing={providerPricing} paygCatalog={paygCatalog} />
                  : <CustomProviderCard key={live.id} provider={live} onUpdate={updateProvider} onRemove={removeProvider} onTest={testProvider} userPayg={userPayg} onGoPayg={goPaygProfile} providerPricing={providerPricing} paygCatalog={paygCatalog} />;
              })}

              {/* 添加供给源：始终展示；付费层无个人页账户时点开显示引导 */}
              <button onClick={togglePicker}
                className={`flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed min-h-[90px] transition-colors ${
                  isOpen
                    ? 'border-blue-400 dark:border-blue-600 text-blue-500 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/10'
                    : 'border-gray-200 dark:border-gray-700 text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-500'
                }`}>
                <span className="text-xl leading-none">{isOpen ? '×' : '+'}</span>
                <span className="text-xs font-medium">{isOpen ? t('providers.add.collapse') : t('providers.add.expand')}</span>
                {!isOpen && tier === 'paid' && paidAccountsLoaded && !hasGatewayPaid && (
                  <span className="text-[10px] text-amber-500 dark:text-amber-400">{t('providers.add.needProfile')}</span>
                )}
                {!isOpen && disabledPickerEntries.length > 0 && (
                  <span className="text-[10px] text-gray-300 dark:text-gray-600">{t('providers.add.availableCount', { n: disabledPickerEntries.length })}</span>
                )}
              </button>
            </div>

            {/* Picker panel */}
            {isOpen && (
              <div className="p-4 bg-gray-50 dark:bg-gray-800/40 rounded-2xl border border-gray-200 dark:border-gray-700 space-y-3">
                {tier === 'paid' && !paidAccountsLoaded && (
                  <p className="text-xs text-gray-400">{t('providers.add.loadingAccounts')}</p>
                )}
                {tier === 'paid' && paidAccountsLoaded && !hasGatewayPaid ? (
                  <>
                    <PersonalPageHint onGo={goPersonalPage} />
                    <StatsOnlyHint names={statsOnlyLabels} />
                  </>
                ) : (
                <>
                <StatsOnlyHint names={statsOnlyLabels} />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {tier === 'paid'
                    ? t('providers.add.paidHint')
                    : t('providers.add.freeHint')}
                </p>
                {tier === 'paid' ? (
                  <div className="space-y-3">
                    {disabledCatalogSubEntries.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-medium text-amber-700 dark:text-amber-300">{t('providers.add.catalogSub')}</p>
                        <div className="flex flex-wrap gap-2">
                          {disabledCatalogSubEntries.map(renderPickerButton)}
                        </div>
                      </div>
                    )}
                    {disabledCustomSubEntries.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-medium text-amber-700/80 dark:text-amber-300/80">{t('providers.add.customSub')}</p>
                        <div className="flex flex-wrap gap-2">
                          {disabledCustomSubEntries.map(renderPickerButton)}
                        </div>
                      </div>
                    )}
                    {disabledPaygEntries.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">{t('providers.add.payg')}</p>
                        <div className="flex flex-wrap gap-2">
                          {disabledPaygEntries.map(renderPickerButton)}
                        </div>
                      </div>
                    )}
                    {disabledPickerEntries.length === 0 && hasGatewayPaid && (
                      <p className="text-xs text-gray-400">{t('providers.add.allAdded')}</p>
                    )}
                    <button type="button" onClick={() => { addCustomProvider(); setAddingTier(null); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors bg-white dark:bg-gray-900">
                      <span>+</span> {t('providers.add.goProfile')}
                    </button>
                  </div>
                ) : (
                <div className="flex flex-wrap gap-2">
                  {disabledItems.map(p => {
                    const m = meta[p.id] || {};
                    const sel = addingId === p.id;
                    return (
                      <button key={p.id} type="button" onClick={() => setAddingId(sel ? null : p.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-colors ${
                          sel
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
                            : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}>
                        <span>{m.icon || '🔌'}</span>
                        <span>{m.label || p.id}</span>
                      </button>
                    );
                  })}
                  {disabledItems.length === 0 && (
                    <p className="text-xs text-gray-400">{t('providers.add.noneAvailable')}</p>
                  )}
                </div>
                )}

                {/* Config card for selected provider */}
                {addingId && (() => {
                  const entry = gatewayPickerEntries.find(e => e.pickerKey === addingPickerKey)
                    || gatewayPickerEntries.find(e => e.providerId === addingId);
                  const pid = addingId;
                  const stubFromEntry = entry ? {
                    id: pid,
                    type: 'paid',
                    enabled: false,
                    token: '',
                    base_url: '',
                    models: [],
                    displayName: entry.label,
                  } : null;
                  const p = tier === 'paid'
                    ? (personalPool.find(pr => pr.id === pid) || providers.find(pr => pr.id === pid) || stubFromEntry)
                    : disabledItems.find(pr => pr.id === pid);
                  if (!p) return null;
                  const live = tier === 'paid' ? liveState(p) : p;
                  const cardAuth = tier === 'paid'
                    ? (addingAuthMode || resolveCardAuthMode(live, providerGatewayAuth[pid]))
                    : null;
                  const useCustomCard = entry?.custom || isCustomSubscriptionGatewayId(pid, userSubscriptions) || !meta[pid];
                  return (
                    <div className="mt-1">
                      {entry && (
                        <p className="text-[10px] text-gray-400 mb-2">
                          {t('providers.add.configuring', {
                            label: entry.label,
                            auth: entry.authMode === 'oauth' ? t('providers.add.authOauth') : t('providers.add.authApiKey'),
                          })}
                        </p>
                      )}
                      {!useCustomCard
                        ? <ProviderCard key={pid} provider={live} meta={meta[pid]} onUpdate={updateProvider} onTest={testProvider} initialExpanded gatewayAuthMode={cardAuth} userPayg={userPayg} onGoPayg={goPaygProfile} providerPricing={providerPricing} paygCatalog={paygCatalog} />
                        : <CustomProviderCard key={pid} provider={live} onUpdate={updateProvider} onRemove={removeProvider} onTest={testProvider} userPayg={userPayg} onGoPayg={goPaygProfile} providerPricing={providerPricing} paygCatalog={paygCatalog} />
                      }
                    </div>
                  );
                })()}
                </>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
