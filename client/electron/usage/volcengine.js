'use strict';
/**
 * 火山引擎 / 豆包（Volcengine Ark）额度抓取（探针型，移植自 CodexBar DoubaoUsageFetcher）。
 * Ark 没有独立额度端点：发一个 max_tokens=1 的极小 chat/completions，从响应头读请求配额。
 * 端点：POST https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions
 * 头：Authorization: Bearer <ARK_API_KEY>
 * 响应头：x-ratelimit-limit-requests / x-ratelimit-remaining-requests / x-ratelimit-reset-requests
 *   used = limit - remaining；仅当 limit 与 remaining 都拿到才认为配额可信。
 * 200 或 429 都带配额头（429=限流，key 仍有效）；403/404=该 model 无权限，换下一个探针 model。
 */
const { num, providerApiKey } = require('./shared');

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions';
// 按可用概率排序：不同 key 类型未必都有权限，逐个探针直到命中。
const PROBE_MODELS = ['doubao-seed-2.0-code', 'doubao-1.5-pro-32k', 'doubao-lite-32k'];

function intHeader(headers, name) {
  const v = headers.get(name);
  if (v == null) return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** reset 头 → ISO 时间：支持 ISO 串、"1d2h3m4s" 相对量、纯秒数。 */
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
  return {
    provider: 'volcengine',
    id: (provider && provider.id) || 'volcengine',
    available: keyValid,
    // key 有效但没有可信配额头时，不造窗口（避免把「未知」显示成 0%/100%）。
    primary,
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

/** 单次探针：返回 { status, limit, remaining, reset, keyValid } 或抛（403/404 触发换 model）。 */
async function probe(key, model) {
  const resp = await fetch(ARK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
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
    keyValid: true, // 200/429 都表示 key 有效
  };
}

async function fetchVolcengineUsage(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少火山引擎 API key（ARK_API_KEY）');
  let lastErr = null;
  for (const model of PROBE_MODELS) {
    try {
      return mapVolcengineUsage(await probe(key, model), provider);
    } catch (e) {
      if (e && (e.status === 403 || e.status === 404)) { lastErr = e; continue; } // 换下一个探针 model
      throw e;
    }
  }
  throw lastErr || new Error('所有探针 model 均不可用');
}

module.exports = { fetchVolcengineUsage, mapVolcengineUsage, parseReset };
