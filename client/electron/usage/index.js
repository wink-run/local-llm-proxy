'use strict';
/**
 * 用量额度抓取注册表 —— 一个 provider 对应一个 usage 抓取器。
 *
 * 设计与 oauth/index.js 同构：新增一家 = 往 USAGE_FETCHERS 加一条。
 * 这一层只负责「订阅方官方口径的剩余额度/重置窗口/余额」，与网关的 token 统计互补。
 *
 * 注册 key 规则（usageProviderName）：
 *   - OAuth 类按 oauth_provider（如 claude）—— 凭证走 oauth.prepare。
 *   - 其余按 provider.id（如 openrouter / deepseek）—— 凭证走 provider.token（API key）。
 *
 * 形态：抓取器统一返回 { provider, id, primary, windows[], ... }，按需附带：
 *   - 窗口配额型：windows 带 usedPercent + resetsAt（Claude）。
 *   - 余额型：credits { total, currency, usedPercent? }（OpenRouter/DeepSeek）。
 */
const { fetchClaudeUsage } = require('./claude');
const { fetchOpenRouterUsage } = require('./openrouter');
const { fetchDeepSeekUsage } = require('./deepseek');
const { fetchCodexUsage } = require('./codex');
const { fetchCopilotUsage } = require('./copilot');
const { fetchGeminiUsage } = require('./gemini');
const { fetchGroqUsage } = require('./groq');

const USAGE_FETCHERS = {
  claude: fetchClaudeUsage, // OAuth 窗口型
  codex: fetchCodexUsage, // OAuth 窗口型（ChatGPT wham/usage）
  copilot: fetchCopilotUsage, // OAuth 窗口型（用 github_token）
  gemini: fetchGeminiUsage, // Google OAuth 窗口型（暂无自动刷新）
  openrouter: fetchOpenRouterUsage, // API key 余额型
  deepseek: fetchDeepSeekUsage, // API key 余额型
  groq: fetchGroqUsage, // API key 指标型（无额度概念）
};

// 前端 UsageMeter 也需要判断「该 provider 是否支持额度抓取」，导出 key 列表保持单一真相源。
const SUPPORTED_KEYS = Object.keys(USAGE_FETCHERS);

/** 返回该 provider 条目对应的抓取器 key（不支持则 null）。 */
function usageProviderName(provider) {
  if (!provider) return null;
  const key = provider.auth_type === 'oauth' && provider.oauth_provider ? provider.oauth_provider : provider.id;
  return USAGE_FETCHERS[key] ? key : null;
}

/** provider 是否已具备可用凭证（OAuth token 或 API key）。 */
function hasCredential(provider) {
  if (!provider) return false;
  const c = provider.credentials || {};
  return !!(c.access_token || c.refresh_token || c.api_key || c.key || provider.token);
}

/** 抓单个 provider 条目；失败不抛，返回 { error }，便于前端逐条展示。 */
async function fetchUsage(provider, deps) {
  const name = usageProviderName(provider);
  const id = provider && provider.id;
  if (!name) return { id, provider: provider && (provider.oauth_provider || provider.id), error: 'unsupported' };
  try {
    return await USAGE_FETCHERS[name](provider, deps || {});
  } catch (e) {
    return { id, provider: name, error: (e && e.message) || String(e) };
  }
}

/** 抓 config 里所有「已启用 + 支持 + 有凭证」的 provider。 */
async function fetchAllUsage(deps) {
  const cfg = deps && deps.getCfg ? deps.getCfg() : null;
  const providers = (cfg && Array.isArray(cfg.providers) ? cfg.providers : []).filter(
    (p) => p && p.enabled !== false && usageProviderName(p) && hasCredential(p),
  );
  const out = [];
  for (const p of providers) out.push(await fetchUsage(p, deps)); // 顺序执行，避免并发刷新同一 OAuth token
  return out;
}

module.exports = { fetchUsage, fetchAllUsage, usageProviderName, hasCredential, USAGE_FETCHERS, SUPPORTED_KEYS };
