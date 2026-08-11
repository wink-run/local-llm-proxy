'use strict';
/**
 * 火山引擎 Coding / Agent Plan 订阅额度抓取。
 *
 * 优先级：
 * 1) 账号 AccessKey/Secret → OpenAPI GetAFPUsage / GetCodingPlanUsage（会话/周/月）
 * 2) 本机 arkcli usage plan（SSO）
 * 3) 推理 API Key 探针：读 x-ratelimit-*（多数 Coding Plan Key 无此头）
 *
 * 按量余额（QueryBalanceAcct）见 volcengine-ark.js，勿在此混合。
 */
const { providerApiKey } = require('./shared');
const {
  fetchVolcengineOpenApiUsage,
  regionFromBaseUrl,
} = require('./volcengine-openapi');
const { fetchArkcliUsagePlan, resolveArkcliPath } = require('./volcengine-arkcli');

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions';
const PROBE_MODELS = ['doubao-seed-2.0-code', 'doubao-seed-2.0-pro', 'doubao-1.5-pro-32k', 'doubao-lite-32k'];

function intHeader(headers, name) {
  const v = headers.get(name);
  if (v == null) return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** reset 头 → ISO：支持 ISO 串、"1d2h3m4s" 相对量、纯秒数。 */
function parseReset(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  let seconds = 0;
  const re = /(\d+)([dhms])/g;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    seconds += m[2] === 'd' ? n * 86400 : m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
  }
  if (seconds > 0) return new Date(Date.now() + seconds * 1000).toISOString();
  const bare = Number(s);
  if (Number.isFinite(bare)) return new Date(Date.now() + bare * 1000).toISOString();
  return null;
}

/** 从 provider / 环境变量解析账号级 AK/SK（与推理 API Key 不同）。 */
function resolveVolcAkSk(provider) {
  const c = (provider && provider.credentials) || {};
  let ak = c.access_key_id || c.accessKeyId || c.ak
    || process.env.VOLCENGINE_ACCESS_KEY_ID
    || process.env.VOLC_ACCESSKEY
    || process.env.VOLCENGINE_AK;
  let sk = c.secret_access_key || c.secretAccessKey || c.sk
    || process.env.VOLCENGINE_SECRET_ACCESS_KEY
    || process.env.VOLC_SECRETKEY
    || process.env.VOLCENGINE_SK;

  const token = String((provider && provider.token) || '').trim();
  // 兼容 token 写成 AKLT...:Secret
  if ((!ak || !sk) && /^AK[A-Z0-9]/i.test(token) && token.includes(':')) {
    const i = token.indexOf(':');
    ak = token.slice(0, i).trim();
    sk = token.slice(i + 1).trim();
  }
  ak = ak ? String(ak).trim() : '';
  sk = sk ? String(sk).trim() : '';
  if (!ak || !sk) return null;
  return { accessKeyId: ak, secretAccessKey: sk };
}

function snapshotBase(provider, extra = {}) {
  return {
    provider: 'volcengine',
    id: (provider && provider.id) || 'volcengine',
    available: true,
    primary: null,
    windows: [],
    plan: null,
    fetchedAt: new Date().toISOString(),
    ...extra,
  };
}

function withWindows(provider, { windows, plan, source, warning, credits }) {
  const wins = Array.isArray(windows) ? windows.filter(Boolean) : [];
  const primary = wins.find((w) => w.id === 'five_hour') || wins[0] || null;
  return snapshotBase(provider, {
    windows: wins,
    primary,
    plan: plan || null,
    source: source || null,
    warning: warning || null,
    credits: credits || null,
    available: true,
  });
}

/** AK/SK → Coding/Agent Plan 窗口（不含按量余额）。 */
async function fetchViaAkSk(provider, aksk) {
  const region = regionFromBaseUrl(provider && provider.base_url);
  try {
    const planRaw = await fetchVolcengineOpenApiUsage({
      accessKeyId: aksk.accessKeyId,
      secretAccessKey: aksk.secretAccessKey,
      region,
    });
    return withWindows(provider, {
      windows: (planRaw && planRaw.windows) || [],
      plan: (planRaw && planRaw.plan) || null,
      source: (planRaw && planRaw.source) || 'openapi',
      credits: null,
    });
  } catch (e) {
    const err = new Error((e && e.message) || String(e));
    err.code = (e && e.code) || 'soft';
    throw err;
  }
}

/** 一次探针结果 → 统一快照（纯函数，可单测）。 */
function mapVolcengineUsage({ limit, remaining, reset, keyValid }, provider) {
  const reliable = limit != null && remaining != null && limit > 0;
  let primary = null;
  const windows = [];
  if (reliable) {
    const used = Math.max(0, limit - remaining);
    const usedPercent = Math.min(100, Math.max(0, (used / limit) * 100));
    primary = {
      id: 'requests',
      title: '请求配额',
      usedPercent,
      usageKnown: true,
      resetsAt: reset,
      windowMinutes: null,
    };
    windows.push(primary);
  }
  return snapshotBase(provider, {
    available: !!keyValid,
    primary,
    windows,
    source: 'probe',
    // key 有效但无配额头：提示改用 AK/SK 或 arkcli 查 Coding Plan
    warning: keyValid && !reliable
      ? '推理 Key 无配额头；请填写 AccessKey 或执行 arkcli auth login 以显示会话/周/月额度'
      : null,
  });
}

async function probe(key, model) {
  const resp = await fetch(ARK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  if (resp.status !== 200 && resp.status !== 429) {
    const e = new Error(`HTTP ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return {
    status: resp.status,
    limit: intHeader(resp.headers, 'x-ratelimit-limit-requests'),
    remaining: intHeader(resp.headers, 'x-ratelimit-remaining-requests'),
    reset: parseReset(resp.headers.get('x-ratelimit-reset-requests')),
    keyValid: true,
  };
}

async function fetchViaProbe(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少火山引擎 API key（ARK_API_KEY）');
  let lastErr = null;
  for (const model of PROBE_MODELS) {
    try {
      return mapVolcengineUsage(await probe(key, model), provider);
    } catch (e) {
      if (e && (e.status === 403 || e.status === 404)) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('所有探针 model 均不可用');
}

async function fetchVolcengineUsage(provider) {
  const softNotes = [];

  // 1) AK/SK → 会话/周/月（订阅）
  const aksk = resolveVolcAkSk(provider);
  if (aksk) {
    try {
      return await fetchViaAkSk(provider, aksk);
    } catch (e) {
      softNotes.push((e && e.message) || String(e));
    }
  }

  // 2) arkcli SSO
  if (resolveArkcliPath()) {
    try {
      const raw = fetchArkcliUsagePlan();
      return withWindows(provider, raw);
    } catch (e) {
      softNotes.push((e && e.message) || String(e));
    }
  }

  // 3) 推理 Key 探针
  try {
    const snap = await fetchViaProbe(provider);
    if (softNotes.length && snap.warning) {
      snap.warning = `${snap.warning}（${softNotes[0]}）`;
    } else if (softNotes.length && !(snap.windows || []).length) {
      snap.warning = softNotes[0];
    }
    // 若已登记套餐名，补到徽章
    if (!snap.plan && provider && provider.plan_label) snap.plan = provider.plan_label;
    return snap;
  } catch (probeErr) {
    if (aksk || resolveArkcliPath()) {
      // 有其它凭证路径失败信息时一并返回软结果
      return snapshotBase(provider, {
        available: false,
        warning: softNotes[0] || ((probeErr && probeErr.message) || String(probeErr)),
        plan: (provider && provider.plan_label) || null,
      });
    }
    throw probeErr;
  }
}

module.exports = {
  fetchVolcengineUsage,
  mapVolcengineUsage,
  parseReset,
  resolveVolcAkSk,
  withWindows,
  fetchViaAkSk,
};
