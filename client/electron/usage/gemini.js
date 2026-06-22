'use strict';
/**
 * Gemini（Google Gemini CLI）配额抓取（窗口型，移植自 CodexBar Gemini quota）。
 * 端点：POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
 * 头：Authorization: Bearer <google access_token>  ·  Content-Type: application/json
 * 体：{ project: <projectId> } 或 {}
 * 响应：{ buckets: [{ modelId, remainingFraction(0-1), resetTime(ISO), tokenType }] }
 *
 * ⚠️ 限制：local 的 oauth.prepare 不支持 Google，这里直接用 credentials.access_token，
 * 不做自动刷新；token 过期需重新导入 Gemini 凭证（后续可补 Google token 刷新）。
 */
const { num } = require('./shared');

const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';

/** modelId → tier（Pro / Flash / Flash-Lite）。 */
function tierOf(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('flash-lite')) return { id: 'flash_lite', title: 'Flash-Lite · 24h', order: 2 };
  if (m.includes('flash')) return { id: 'flash', title: 'Flash · 24h', order: 1 };
  if (m.includes('pro')) return { id: 'pro', title: 'Pro · 24h', order: 0 };
  return { id: 'other', title: modelId || '其他', order: 3 };
}

/** quota 响应 → 统一快照（纯函数，可单测）；每 tier 取用量最高（剩余最少）的桶。 */
function mapGeminiUsage(data, provider) {
  const d = data || {};
  const buckets = Array.isArray(d.buckets) ? d.buckets : [];
  const byTier = new Map();
  for (const b of buckets) {
    const frac = num(b.remainingFraction);
    if (frac == null) continue;
    const t = tierOf(b.modelId);
    const usedPercent = Math.max(0, Math.min(100, (1 - frac) * 100));
    const cur = byTier.get(t.id);
    if (!cur || usedPercent > cur.usedPercent) {
      byTier.set(t.id, {
        id: t.id,
        title: t.title,
        usedPercent,
        usageKnown: true,
        resetsAt: b.resetTime || null,
        windowMinutes: 1440,
        _order: t.order,
      });
    }
  }
  const windows = [...byTier.values()].sort((a, b) => a._order - b._order).map(({ _order, ...w }) => w);
  return {
    provider: 'gemini',
    id: (provider && provider.id) || 'gemini',
    primary: windows[0] || null,
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchGeminiUsage(provider) {
  const creds = provider.credentials || {};
  const token = creds.access_token;
  if (!token) throw new Error('缺少 Google access_token；Gemini 暂不支持自动刷新，过期需重新导入凭证');
  const projectId = creds.project_id || creds.project || null;
  const resp = await fetch(QUOTA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
  });
  if (resp.status === 401) throw new Error('401：Google token 失效，需重新导入 Gemini 凭证（暂无自动刷新）');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapGeminiUsage(await resp.json(), provider);
}

module.exports = { fetchGeminiUsage, mapGeminiUsage, tierOf };
