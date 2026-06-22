'use strict';
/**
 * Claude 订阅用量额度抓取（移植自 CodexBar ClaudeOAuthUsageFetcher）。
 *
 * 与「网关转发后自己累加 token」不同：这里直接打 Anthropic 官方端点，
 * 拿订阅方口径的剩余额度 + 重置时间 + 订阅计划。复用 oauth.prepare 拿 fresh access_token。
 *
 * 端点：
 *   GET /api/oauth/usage   → 各窗口用量（utilization 直接是 0-100，resets_at 为 ISO8601）
 *   GET /api/oauth/profile → 账号 + 订阅计划（has_claude_max / organization.rate_limit_tier 等）
 * 窗口映射：five_hour→会话 / seven_day→本周 / seven_day_opus|sonnet→模型周窗 / extra_usage→月度额外用量。
 */
const oauth = require('../oauth');
const { num, anthropicOAuthGet } = require('./shared');

/**
 * 从 /api/oauth/profile 推断订阅计划（公共方法，可单测，可被其他流程复用）。
 * 优先 account 标志位，回退 organization 的 type / rate_limit_tier。
 */
function inferClaudePlan(profile) {
  const acct = (profile && profile.account) || {};
  const org = (profile && profile.organization) || {};
  if (acct.has_claude_max) return 'Max';
  if (acct.has_claude_pro) return 'Pro';
  const tier = String(org.organization_type || org.rate_limit_tier || '').toLowerCase();
  if (tier.includes('max')) return 'Max';
  if (tier.includes('pro')) return 'Pro';
  if (tier.includes('team')) return 'Team';
  if (tier.includes('enterprise')) return 'Enterprise';
  return null;
}

/**
 * 从 profile 检测当前订阅档位（公共方法，可单测）。
 * 返回 subscription_plans 目录里的 plan_id（max5x / max20x / claude-pro），
 * 价格/label 交给目录，这里只负责「API 真值 → 档位 id」。无有效订阅返回 null。
 */
function detectClaudeSubscription(profile) {
  const acct = (profile && profile.account) || {};
  const org = (profile && profile.organization) || {};
  const status = org.subscription_status;
  if (status && status !== 'active') return null; // 已取消/过期不算
  const tier = String(org.rate_limit_tier || org.organization_type || '').toLowerCase();
  if (acct.has_claude_max || tier.includes('max')) {
    return { planId: tier.includes('20x') ? 'max20x' : 'max5x', source: 'api', tier: tier || null };
  }
  if (acct.has_claude_pro || tier.includes('pro')) {
    return { planId: 'claude-pro', source: 'api', tier: tier || null };
  }
  return null;
}

/** 单个 window：{ utilization, resets_at } → 统一窗口结构（null 表示该窗口不存在）。 */
function mapWindow(id, title, raw, windowMinutes) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = num(raw.utilization);
  if (usedPercent == null && !raw.resets_at) return null;
  return {
    id,
    title,
    usedPercent: usedPercent == null ? 0 : usedPercent,
    usageKnown: usedPercent != null, // 只有 reset 信息、无用量时为 false
    resetsAt: raw.resets_at || null,
    windowMinutes: windowMinutes == null ? null : windowMinutes,
  };
}

/** usage(+profile) → 统一快照（纯函数，可单测）。 */
function mapUsage(data, { profile = null, provider = null } = {}) {
  const d = data || {};
  const acct = (profile && profile.account) || {};
  const creds = (provider && provider.credentials) || {};
  const windows = [];

  const session = mapWindow('five_hour', '会话 · 5h', d.five_hour, 300);
  const weekly = mapWindow('seven_day', '本周 · 7d', d.seven_day, 10080);
  const opus = mapWindow('seven_day_opus', 'Opus · 7d', d.seven_day_opus, 10080);
  const sonnet = mapWindow('seven_day_sonnet', 'Sonnet · 7d', d.seven_day_sonnet, 10080);
  for (const w of [session, weekly, opus, sonnet]) if (w) windows.push(w);

  // 主窗口：会话窗口有用量时优先，否则回退本周窗（与 CodexBar 行为一致）。
  const primary = session && session.usageKnown ? session : weekly || session || null;

  let extra = null;
  const eu = d.extra_usage;
  if (eu && typeof eu === 'object' && (eu.is_enabled || eu.monthly_limit != null)) {
    extra = {
      enabled: !!eu.is_enabled,
      monthlyLimit: num(eu.monthly_limit),
      usedCredits: num(eu.used_credits),
      usedPercent: num(eu.utilization),
    };
  }

  return {
    provider: 'claude',
    id: (provider && provider.id) || 'claude',
    email: acct.email || creds.email || null,
    name: acct.display_name || acct.full_name || null,
    plan: inferClaudePlan(profile),
    subscription: detectClaudeSubscription(profile), // API 检测到的订阅档位（供个人中心自动登记）
    primary,
    windows,
    extra,
    fetchedAt: new Date().toISOString(),
  };
}

/** 抓取 + 映射。provider 为 config 里的 oauth 条目；deps 提供 getCfg/saveCfg 供刷新回写。 */
async function fetchClaudeUsage(provider, { getCfg, saveCfg } = {}) {
  const prepared = await oauth.prepare(provider, getCfg, saveCfg); // 复用：判过期→刷新→回写
  const token = prepared.credentials && prepared.credentials.access_token;
  if (!token) throw new Error('缺少 access_token，请重新登录 Claude');

  // usage 必需；profile 尽力而为（失败仅丢 plan/name，不致命）。
  const [usage, profile] = await Promise.all([
    anthropicOAuthGet('/api/oauth/usage', token),
    anthropicOAuthGet('/api/oauth/profile', token).catch(() => null),
  ]);

  return mapUsage(usage, { profile, provider: prepared });
}

module.exports = { fetchClaudeUsage, mapUsage, mapWindow, inferClaudePlan, detectClaudeSubscription };
