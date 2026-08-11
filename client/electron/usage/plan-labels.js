'use strict';
/**
 * 订阅计划展示标签（对齐 token-monitor limitCollector 的 accountLabel 规则）。
 * 只做展示层归一化：把 API / 凭证里的 planType、rate_limit_tier 收成短标签（如 Max 20x）。
 */

const PLAN_LABEL_ALIASES = Object.freeze({
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  teams: 'Team',
  enterprise: 'Enterprise',
  ultra: 'Ultra',
  business: 'Business',
});

function displayPlanWord(word) {
  const raw = String(word || '');
  const lower = raw.toLowerCase();
  if (['ai', 'api', 'cbp', 'gpt', 'k12'].includes(lower)) return lower.toUpperCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** 去掉品牌前缀、下划线，得到可比较的小写短语。 */
function cleanPlanText(text, prefixes = ['claude', 'chatgpt', 'openai']) {
  const raw = String(text || '').trim();
  if (!raw || raw.includes('@')) return '';
  const prefixPattern = prefixes.length > 0
    ? new RegExp(`^(?:${prefixes.join('|')})[\\s_-]+`, 'i')
    : null;
  let clean = raw;
  while (prefixPattern && prefixPattern.test(clean)) clean = clean.replace(prefixPattern, '');
  return clean.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function displayPlanText(raw, maxWords = 3) {
  const words = String(raw || '').split(/\s+/).filter(Boolean);
  const visible = Number.isFinite(maxWords) ? words.slice(0, maxWords) : words;
  return visible.map(displayPlanWord).join(' ');
}

function planLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '')).find(Boolean) || '';
  const raw = cleanPlanText(text);
  if (!raw || raw.includes('@')) return '';
  if (PLAN_LABEL_ALIASES[raw]) return PLAN_LABEL_ALIASES[raw];
  return displayPlanText(raw);
}

/** rate_limit_tier（如 default_claude_max_20x）→ Max 20x；过滤 default/claude/raven 噪音词。 */
function claudeRateLimitTierLabel(rateLimitTier) {
  const raw = cleanPlanText(rateLimitTier, []);
  if (!raw) return '';
  const words = raw.split(/\s+/).filter((word) => !['default', 'claude', 'ai', 'raven'].includes(word));
  if (words.length === 0) return '';
  return planLabelFromParts(words.join(' '));
}

/**
 * Claude：subscriptionType + rate_limit_tier → 展示标签。
 * Max 且 tier 带 5x/20x 时优先用倍率标签；Team 等不吞掉成 Max。
 */
function claudePlanLabelFromParts(subscriptionType, rateLimitTier) {
  const subscriptionLabel = planLabelFromParts(subscriptionType);
  const tierLabel = claudeRateLimitTierLabel(rateLimitTier);
  if (subscriptionLabel === 'Max' && /^Max\s+(?:5x|20x)$/i.test(tierLabel)) return tierLabel;
  return subscriptionLabel || tierLabel || '';
}

/** Codex / ChatGPT：pro→Pro 20x、prolite→Pro 5x，企业档位压成短词。 */
function codexPlanLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '').trim()).find(Boolean) || '';
  if (!text || text.includes('@')) return '';
  const exact = {
    pro: 'Pro 20x',
    prolite: 'Pro 5x',
    pro_lite: 'Pro 5x',
    'pro-lite': 'Pro 5x',
    'pro lite': 'Pro 5x',
  };
  const raw = text.toLowerCase();
  if (exact[raw]) return exact[raw];
  const cleaned = cleanPlanText(text, ['codex', 'chatgpt', 'openai']);
  if (!cleaned) return '';
  if (exact[cleaned]) return exact[cleaned];
  const aliases = {
    free: 'Free',
    plus: 'Plus',
    max: 'Max',
    team: 'Team',
    teams: 'Team',
    enterprise: 'Enterprise',
    'enterprise cbp usage based': 'Enterprise',
    'self serve business usage based': 'Business',
  };
  if (aliases[cleaned]) return aliases[cleaned];
  return displayPlanText(cleaned, Infinity);
}

module.exports = {
  cleanPlanText,
  planLabelFromParts,
  claudeRateLimitTierLabel,
  claudePlanLabelFromParts,
  codexPlanLabelFromParts,
};
