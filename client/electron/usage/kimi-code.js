'use strict';
/**
 * Kimi Code（api.kimi.com/coding）额度抓取 —— 订阅窗口型。
 * 端点：GET {base}/usages  ·  Authorization: Bearer <api_key|CLI token>
 * 响应：usage（周请求配额）+ limits[]（如 5h=300 分钟窗）
 */
const { providerApiKey, toNum } = require('./shared');

const DEFAULT_BASE = 'https://api.kimi.com/coding/v1';

const MEMBERSHIP_LABEL = {
  LEVEL_BASIC: 'Andante',
  LEVEL_ADVANCED: 'Moderato',
  LEVEL_PRO: 'Allegretto',
  LEVEL_ANDANTE: 'Andante',
  LEVEL_MODERATO: 'Moderato',
  LEVEL_ALLEGRETTO: 'Allegretto',
};

function resolveUsagesUrl(provider) {
  const base = String((provider && provider.base_url) || DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, '');
  return `${base}/usages`;
}

function windowMinutesFrom(window) {
  if (!window || typeof window !== 'object') return null;
  const dur = toNum(window.duration);
  if (dur == null) return null;
  const unit = String(window.timeUnit || window.time_unit || '').toUpperCase();
  if (unit.includes('MINUTE')) return dur;
  if (unit.includes('HOUR')) return dur * 60;
  if (unit.includes('DAY')) return dur * 1440;
  // 常见：duration=300 + TIME_UNIT_MINUTE → 5h
  return dur;
}

function usedPercentFromDetail(detail) {
  const d = detail || {};
  const limit = toNum(d.limit);
  const used = toNum(d.used);
  const remaining = toNum(d.remaining);
  if (limit != null && limit > 0 && used != null) {
    return Math.min(100, Math.max(0, (used / limit) * 100));
  }
  if (limit != null && limit > 0 && remaining != null) {
    return Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
  }
  return null;
}

function resetIso(detail) {
  const raw = detail && (detail.resetTime || detail.reset_time);
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** usages 响应 → 统一快照（纯函数，可单测）。 */
function mapKimiCodeUsage(data, provider) {
  const root = data || {};
  const user = root.user || {};
  const membership = user.membership || {};
  const level = String(membership.level || '');
  const plan = MEMBERSHIP_LABEL[level] || (level ? level.replace(/^LEVEL_/, '') : null);

  const windows = [];
  // 周配额（usage）
  const weeklyPct = usedPercentFromDetail(root.usage);
  if (weeklyPct != null) {
    windows.push({
      id: 'seven_day',
      title: '本周',
      usedPercent: weeklyPct,
      usageKnown: true,
      resetsAt: resetIso(root.usage),
      windowMinutes: 10080,
    });
  }
  // 滚动窗（limits）
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue;
    const mins = windowMinutesFrom(item.window);
    const detail = item.detail || {};
    const pct = usedPercentFromDetail(detail);
    if (pct == null) continue;
    const id = mins === 300 ? 'five_hour' : (mins != null ? `window_${mins}m` : 'rate');
    const title = mins === 300 ? '会话 · 5h'
      : mins != null ? `${Math.round(mins / 60)}h 窗`
        : '速率限制';
    windows.push({
      id,
      title,
      usedPercent: pct,
      usageKnown: true,
      resetsAt: resetIso(detail),
      windowMinutes: mins,
    });
  }

  const primary = windows.find((w) => w.id === 'five_hour')
    || windows.find((w) => w.id === 'seven_day')
    || windows[0]
    || null;

  return {
    provider: 'kimi-code',
    id: (provider && provider.id) || 'kimi-code',
    available: true,
    plan,
    primary,
    windows,
    source: 'coding-usages',
    fetchedAt: new Date().toISOString(),
  };
}

/** 从 usages / models 错误体提炼文案 */
async function readKimiErrorText(resp) {
  try {
    const raw = await resp.text();
    if (!raw) return '';
    try {
      const j = JSON.parse(raw);
      return String(j?.error?.message || j?.message || raw).trim();
    } catch {
      return raw.trim().slice(0, 300);
    }
  } catch {
    return '';
  }
}

/** 403：会员校验失败 → 订阅失效（非「连不上」） */
function kimiMembershipForbiddenError(detail = '') {
  const d = String(detail || '').trim();
  // 官方文案含 membership benefits；统一成可读提示
  if (/membership|会员|订阅/i.test(d)) {
    return '订阅已失效或未开通，请续费或确认会员状态后重试';
  }
  return '订阅已失效或无权访问（HTTP 403），请确认 Kimi Code 会员有效';
}

async function fetchKimiCodeUsage(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少 Kimi Code API key');
  const url = resolveUsagesUrl(provider);
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (resp.status === 401) throw new Error('401：API key 无效或已过期');
  if (resp.status === 403) {
    const detail = await readKimiErrorText(resp);
    throw new Error(kimiMembershipForbiddenError(detail));
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapKimiCodeUsage(await resp.json(), provider);
}

module.exports = {
  fetchKimiCodeUsage,
  mapKimiCodeUsage,
  resolveUsagesUrl,
  usedPercentFromDetail,
  kimiMembershipForbiddenError,
};
