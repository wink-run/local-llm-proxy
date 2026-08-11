'use strict';
/**
 * 火山方舟控制面用量：GetAFPUsage / GetCodingPlanUsage
 * （open.volcengineapi.com，需账号级 AccessKey/Secret 签名，非推理 API Key）。
 *
 * 签名为火山 V4 变体（对照官方 Sign.java / cc-switch）：
 * - SignedHeaders 固定顺序 host;x-date;x-content-sha256;content-type（不按字母序）
 * - 算法串 HMAC-SHA256（无 AWS4 前缀），scope 以 request 结尾
 */
const crypto = require('crypto');

const OPENAPI_HOST = 'open.volcengineapi.com';
const API_VERSION = '2024-01-01';
const SERVICE = 'ark';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** RFC3986：除 unreserved 外全部 %XX */
function uriEncode(input) {
  return String(input).replace(/[^A-Za-z0-9\-_.~]/g, (ch) => {
    const buf = Buffer.from(ch, 'utf8');
    let out = '';
    for (const b of buf) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    return out;
  });
}

function canonicalQuery(action, region) {
  const pairs = [
    ['Action', action],
    ['Region', region],
    ['Version', API_VERSION],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
}

/** @returns {{ authorization, xDate, xContentSha256 }} */
function signVolcRequest({
  accessKeyId, secretAccessKey, region, canonicalQueryStr, body = Buffer.alloc(0), now = new Date(),
}) {
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const shortDate = xDate.slice(0, 8);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  const xContentSha256 = sha256Hex(payload);

  const canonicalHeaders = [
    `host:${OPENAPI_HOST}`,
    `x-date:${xDate}`,
    `x-content-sha256:${xContentSha256}`,
    `content-type:${CONTENT_TYPE}`,
    '',
  ].join('\n');

  const canonicalRequest = [
    'POST',
    '/',
    canonicalQueryStr,
    canonicalHeaders,
    SIGNED_HEADERS,
    xContentSha256,
  ].join('\n');

  const credentialScope = `${shortDate}/${region}/${SERVICE}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(secretAccessKey, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return {
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    xContentSha256,
  };
}

function regionFromBaseUrl(baseUrl) {
  const host = String(baseUrl || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0] || '';
  const hit = host.split('.').find((p) => /^cn-/.test(p) || /^ap-/.test(p));
  return hit || 'cn-beijing';
}

function isAuthErrorCode(code) {
  const c = String(code || '').toLowerCase();
  return /auth|signature|accessdenied|denied|unauthorized|forbidden|credential|token/.test(c);
}

function responseError(body) {
  const err = (body && body.ResponseMetadata && body.ResponseMetadata.Error)
    || (body && body.Error)
    || null;
  if (!err) return null;
  return {
    code: String(err.Code || ''),
    message: String(err.Message || ''),
  };
}

/** 秒 / 毫秒 / ISO；≤0 视为无效（session 常见 -1）。 */
function extractResetAt(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const s = String(value).trim();
  if (!s || s === '0' || s === '-1') return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n <= 0) return null;
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function windowMeta(level) {
  const l = String(level || '').toLowerCase();
  if (['session', '5h', 'fivehour', 'five_hour', 'rolling_5h'].includes(l)) {
    return { id: 'five_hour', title: '会话 · 5h', windowMinutes: 300 };
  }
  if (['weekly', 'week', '7d'].includes(l)) {
    return { id: 'seven_day', title: '本周 · 7d', windowMinutes: 10080 };
  }
  if (['monthly', 'month'].includes(l)) {
    return { id: 'monthly', title: '本月', windowMinutes: null };
  }
  return null;
}

function toWindow(idTitle, usedPercent, resetsAt) {
  const pct = typeof usedPercent === 'number' && isFinite(usedPercent) ? usedPercent : null;
  if (pct == null) return null;
  return {
    id: idTitle.id,
    title: idTitle.title,
    usedPercent: Math.min(100, Math.max(0, pct)),
    usageKnown: true,
    resetsAt: resetsAt || null,
    windowMinutes: idTitle.windowMinutes,
  };
}

/** GetCodingPlanUsage Result → windows[] */
function mapCodingPlanResult(result) {
  const arr = (result && (result.QuotaUsage || result.Usages || result.Details)) || [];
  if (!Array.isArray(arr)) return [];
  const windows = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const level = item.Level || item.Type || item.Period || item.Label || item.Window || '';
    const meta = windowMeta(level);
    if (!meta) continue;
    const pct = [item.Percent, item.UsedPercent, item.UsagePercent]
      .find((v) => typeof v === 'number' && isFinite(v));
    const resetsAt = extractResetAt(item.ResetTime != null ? item.ResetTime : item.ResetTimestamp);
    const w = toWindow(meta, pct == null ? 0 : pct, resetsAt);
    if (w) windows.push(w);
  }
  return windows;
}

/** GetAFPUsage Result → windows[]（绝对 Quota/Used） */
function mapAfpResult(result) {
  if (!result || typeof result !== 'object') return [];
  const windows = [];
  const pairs = [
    ['AFPFiveHour', 'five_hour', '会话 · 5h', 300],
    ['AFPWeekly', 'seven_day', '本周 · 7d', 10080],
    ['AFPMonthly', 'monthly', '本月', null],
  ];
  for (const [key, id, title, windowMinutes] of pairs) {
    const win = result[key];
    if (!win || typeof win !== 'object') continue;
    const quota = Number(win.Quota);
    if (!(quota > 0)) continue;
    const used = Number(win.Used) || 0;
    const w = toWindow(
      { id, title, windowMinutes },
      (used / quota) * 100,
      extractResetAt(win.ResetTime != null ? win.ResetTime : win.ResetTimestamp),
    );
    if (w) windows.push(w);
  }
  return windows;
}

async function openApiCall(action, { accessKeyId, secretAccessKey, region, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const q = canonicalQuery(action, region);
  const url = `https://${OPENAPI_HOST}/?${q}`;
  const body = Buffer.alloc(0);
  const signed = signVolcRequest({
    accessKeyId, secretAccessKey, region, canonicalQueryStr: q, body,
  });
  const resp = await doFetch(url, {
    method: 'POST',
    headers: {
      'X-Date': signed.xDate,
      'X-Content-Sha256': signed.xContentSha256,
      'Content-Type': CONTENT_TYPE,
      Authorization: signed.authorization,
    },
    body,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }

  if (resp.status === 401 || resp.status === 403) {
    const err = new Error(`火山 OpenAPI 鉴权失败 HTTP ${resp.status}`);
    err.code = 'auth';
    throw err;
  }
  const apiErr = responseError(json);
  if (apiErr && isAuthErrorCode(apiErr.code)) {
    const err = new Error(`火山 OpenAPI 鉴权失败 ${apiErr.code}: ${apiErr.message}`);
    err.code = 'auth';
    throw err;
  }
  if (!resp.ok) {
    const msg = apiErr
      ? `${apiErr.code}: ${apiErr.message}`
      : `HTTP ${resp.status}`;
    const err = new Error(`火山 OpenAPI ${action} 失败：${msg}`);
    err.code = 'soft';
    throw err;
  }
  if (apiErr && apiErr.code) {
    const err = new Error(`${apiErr.code}: ${apiErr.message}`);
    err.code = 'soft';
    throw err;
  }
  return (json && json.Result) != null ? json.Result : json;
}

/**
 * 先 Agent Plan（GetAFPUsage），再 Coding Plan（GetCodingPlanUsage）。
 * @returns {{ windows, plan, source, status }}
 */
async function fetchVolcengineOpenApiUsage({
  accessKeyId, secretAccessKey, region = 'cn-beijing', fetchImpl,
} = {}) {
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('缺少火山 AccessKey / SecretAccessKey');
  }
  const soft = [];
  // 1) Agent Plan
  try {
    const afp = await openApiCall('GetAFPUsage', {
      accessKeyId, secretAccessKey, region, fetchImpl,
    });
    const windows = mapAfpResult(afp);
    if (windows.length) {
      return {
        windows,
        plan: 'Agent Plan',
        source: 'openapi-afp',
        status: (afp && afp.Status) || null,
      };
    }
  } catch (e) {
    if (e && e.code === 'auth') throw e;
    soft.push((e && e.message) || String(e));
  }
  // 2) Coding Plan
  try {
    const coding = await openApiCall('GetCodingPlanUsage', {
      accessKeyId, secretAccessKey, region, fetchImpl,
    });
    const windows = mapCodingPlanResult(coding);
    if (windows.length) {
      const status = (coding && coding.Status) || null;
      return {
        windows,
        plan: status && status !== 'Running' ? `Coding Plan · ${status}` : 'Coding Plan',
        source: 'openapi-coding',
        status,
      };
    }
    soft.push('GetCodingPlanUsage 无窗口数据');
  } catch (e) {
    if (e && e.code === 'auth') throw e;
    soft.push((e && e.message) || String(e));
  }
  const err = new Error(soft.filter(Boolean).join('；') || '未订阅 Coding/Agent Plan');
  err.code = 'empty';
  throw err;
}

module.exports = {
  OPENAPI_HOST,
  canonicalQuery,
  signVolcRequest,
  regionFromBaseUrl,
  extractResetAt,
  mapCodingPlanResult,
  mapAfpResult,
  fetchVolcengineOpenApiUsage,
  windowMeta,
};
