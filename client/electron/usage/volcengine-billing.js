'use strict';
/**
 * 火山费用中心余额：QueryBalanceAcct
 * GET https://billing.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01
 * 签名：HMAC-SHA256，SignedHeaders=host;x-date，service=billing
 * 文档：https://www.volcengine.com/docs/6269/1223898
 */
const crypto = require('crypto');
const { toNum } = require('./shared');

const BILLING_HOST = 'billing.volcengineapi.com';
const BILLING_VERSION = '2022-01-01';
const BILLING_SERVICE = 'billing';
const BILLING_REGION = 'cn-beijing';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SIGNED_HEADERS = 'host;x-date';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** 控制台「余额」= AvailableBalance；透支额度单独保留供展示。 */
function mapBalanceAcctResult(result) {
  const r = result || {};
  // 与控制台「余额」对齐（含可用现金 + 可用信控 − 冻结）
  const available = toNum(r.AvailableBalance);
  const cash = toNum(r.CashBalance);
  const creditLimit = toNum(r.CreditLimit);
  const freeze = toNum(r.FreezeAmount);
  const arrears = toNum(r.ArrearsBalance);
  if (available == null && cash == null) return null;
  const remaining = available != null ? available : cash;
  return {
    total: remaining,
    remaining,
    cash,
    creditLimit,
    freeze,
    arrears,
    currency: 'CNY',
    usedPercent: null,
  };
}

/** @returns {{ authorization, xDate }} */
function signBillingGet({
  accessKeyId, secretAccessKey, canonicalQueryStr, region = BILLING_REGION, now = new Date(),
}) {
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const shortDate = xDate.slice(0, 8);
  const canonicalHeaders = [
    `host:${BILLING_HOST}`,
    `x-date:${xDate}`,
    '',
  ].join('\n');
  const canonicalRequest = [
    'GET',
    '/',
    canonicalQueryStr,
    canonicalHeaders,
    SIGNED_HEADERS,
    EMPTY_SHA256,
  ].join('\n');
  const credentialScope = `${shortDate}/${region}/${BILLING_SERVICE}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(secretAccessKey, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, BILLING_SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  return {
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
  };
}

/**
 * 查询账户可用余额（对齐控制台费用中心「余额」）。
 * @returns {{ credits, source, accountId }}
 */
async function fetchVolcengineBalance({
  accessKeyId, secretAccessKey, region = BILLING_REGION, fetchImpl,
} = {}) {
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('缺少火山 AccessKey / SecretAccessKey');
  }
  const doFetch = fetchImpl || fetch;
  // Query 参数按字母序：Action、Version（无 Region）
  const canonicalQueryStr = `Action=QueryBalanceAcct&Version=${BILLING_VERSION}`;
  const signed = signBillingGet({
    accessKeyId, secretAccessKey, canonicalQueryStr, region,
  });
  const url = `https://${BILLING_HOST}/?${canonicalQueryStr}`;
  const resp = await doFetch(url, {
    method: 'GET',
    headers: {
      Host: BILLING_HOST,
      'X-Date': signed.xDate,
      Authorization: signed.authorization,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }

  const apiErr = (json && json.ResponseMetadata && json.ResponseMetadata.Error) || null;
  if (resp.status === 401 || resp.status === 403
    || (apiErr && /auth|denied|forbidden|signature|credential/i.test(String(apiErr.Code || '')))) {
    const err = new Error(
      apiErr
        ? `费用中心鉴权失败 ${apiErr.Code}: ${apiErr.Message}`
        : `费用中心鉴权失败 HTTP ${resp.status}`,
    );
    err.code = 'auth';
    throw err;
  }
  if (!resp.ok || apiErr) {
    const err = new Error(
      apiErr
        ? `${apiErr.Code}: ${apiErr.Message}`
        : `QueryBalanceAcct HTTP ${resp.status}`,
    );
    err.code = 'soft';
    throw err;
  }
  const result = (json && json.Result) || null;
  const credits = mapBalanceAcctResult(result);
  if (!credits) {
    const err = new Error('QueryBalanceAcct 无余额字段');
    err.code = 'empty';
    throw err;
  }
  return {
    credits,
    source: 'billing-balance',
    accountId: result && result.AccountID != null ? result.AccountID : null,
  };
}

module.exports = {
  BILLING_HOST,
  mapBalanceAcctResult,
  signBillingGet,
  fetchVolcengineBalance,
};
