'use strict';
/**
 * usage 抓取公共工具 —— 跨 provider 复用。
 * 新增一家 usage 抓取器时，HTTP / 数值清洗 / 窗口结构都从这里取，避免各 provider 重复实现。
 */

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const CLAUDE_UA = 'claude-code/2.1.0';

/** 仅保留有限数值，其余归 null（便于区分「0%」与「无数据」）。 */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 兼容字符串数值（部分余额端点把金额返回为 string，如 DeepSeek total_balance）。 */
function toNum(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

/** 从 provider 条目取 API key（api_key 类抓取器用；OAuth 类走 oauth.prepare 不用这个）。 */
function providerApiKey(provider) {
  if (!provider) return null;
  const c = provider.credentials || {};
  return provider.token || c.api_key || c.key || null;
}

/** 把 4xx/5xx 状态翻译成可读中文错误（OAuth 类端点通用）。 */
function describeHttpError(status, pathname) {
  if (status === 401) return '401 未授权：token 失效，请重新登录';
  if (status === 403) return '403：账号可能以 setup-token 登录（缺 user:profile 权限），请用完整权限重新登录';
  if (status === 429) return '429 限流，请稍后再试';
  return `HTTP ${status}${pathname ? ' @ ' + pathname : ''}`;
}

/**
 * 通用 Anthropic OAuth GET —— 返回解析后的 JSON；非 2xx 抛可读 Error。
 * usage / profile 以及后续其他 Anthropic OAuth 端点共用。
 */
async function anthropicOAuthGet(pathname, token, opts = {}) {
  if (!token) throw new Error('缺少 access_token');
  const { base = ANTHROPIC_BASE, beta = ANTHROPIC_BETA, userAgent = CLAUDE_UA } = opts;
  const resp = await fetch(base + pathname, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': beta,
      'User-Agent': userAgent,
    },
  });
  if (!resp.ok) throw new Error(describeHttpError(resp.status, pathname));
  return resp.json();
}

module.exports = {
  num,
  toNum,
  providerApiKey,
  describeHttpError,
  anthropicOAuthGet,
  ANTHROPIC_BASE,
  ANTHROPIC_BETA,
  CLAUDE_UA,
};
