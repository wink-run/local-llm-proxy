'use strict';
/**
 * GitHub Copilot 额度抓取（窗口型，移植自 CodexBar CopilotUsageModels）。
 * 端点：GET https://api.github.com/copilot_internal/user
 * 头：Authorization: token <github_token>（注意：用 GitHub token，非 copilot access_token；前缀是 token 不是 Bearer）
 * 响应：quota_snapshots.{premium_interactions,chat}{ entitlement, remaining, percent_remaining, unlimited } + quota_reset_date
 * 凭证：local copilot OAuth 在 credentials.github_token 里存了 GitHub token，直接用，无需刷新 copilot token。
 */
const { num } = require('./shared');

const USER_URL = 'https://api.github.com/copilot_internal/user';
const BASE_HEADERS = {
  Accept: 'application/json',
  'Editor-Version': 'vscode/1.96.2',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'X-Github-Api-Version': '2025-04-01',
};

/** quota_snapshots 的一项 → 统一窗口；usedPercent = 100 - percent_remaining。占位符返回 null。 */
function mapSnapshot(id, title, snap, resetDate) {
  if (!snap || typeof snap !== 'object') return null;
  if (snap.unlimited) {
    return { id, title, usedPercent: 0, usageKnown: true, unlimited: true, resetsAt: null, windowMinutes: null };
  }
  const pr = num(snap.percent_remaining);
  const ent = num(snap.entitlement);
  const rem = num(snap.remaining);
  let usedPercent = pr != null ? Math.max(0, 100 - pr) : ent && rem != null && ent > 0 ? (1 - rem / ent) * 100 : null;
  if (usedPercent == null && !ent) return null; // 占位符
  return {
    id,
    title,
    usedPercent: usedPercent == null ? 0 : usedPercent,
    usageKnown: usedPercent != null,
    limit: ent,
    resetsAt: resetDate || null,
    windowMinutes: null,
  };
}

/** usage 响应 → 统一快照（纯函数，可单测）。 */
function mapCopilotUsage(data, provider) {
  const d = data || {};
  const reset = d.quota_reset_date || null;
  const qs = d.quota_snapshots || {};
  const windows = [];
  const prem = mapSnapshot('premium_interactions', 'Premium 交互', qs.premium_interactions, reset);
  const chat = mapSnapshot('chat', 'Chat', qs.chat, reset);
  for (const w of [prem, chat]) if (w) windows.push(w);
  return {
    provider: 'copilot',
    id: (provider && provider.id) || 'copilot',
    plan: d.copilot_plan || null,
    primary: prem || chat || windows[0] || null,
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchCopilotUsage(provider) {
  const ghToken = (provider.credentials && provider.credentials.github_token) || null;
  if (!ghToken) throw new Error('缺少 GitHub token，请重新登录 Copilot');
  const resp = await fetch(USER_URL, { headers: { ...BASE_HEADERS, Authorization: `token ${ghToken}` } });
  if (resp.status === 401) throw new Error('401 未授权，请重新登录');
  if (resp.status === 403) throw new Error('403：该 GitHub 账号可能未订阅 Copilot');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapCopilotUsage(await resp.json(), provider);
}

module.exports = { fetchCopilotUsage, mapCopilotUsage, mapSnapshot };
