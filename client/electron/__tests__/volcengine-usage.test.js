'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalQuery,
  signVolcRequest,
  mapCodingPlanResult,
  mapAfpResult,
  extractResetAt,
} = require('../usage/volcengine-openapi');
const { mapArkcliUsagePlan } = require('../usage/volcengine-arkcli');
const { mapVolcengineUsage, resolveVolcAkSk } = require('../usage/volcengine');
const { normalizeUsageKey } = require('../usage');

describe('volcengine openapi sign', () => {
  it('canonical query 按 key 字母序', () => {
    assert.equal(
      canonicalQuery('GetCodingPlanUsage', 'cn-beijing'),
      'Action=GetCodingPlanUsage&Region=cn-beijing&Version=2024-01-01',
    );
  });

  it('签名头含 HMAC-SHA256 Credential 与固定 SignedHeaders', () => {
    const q = canonicalQuery('GetAFPUsage', 'cn-beijing');
    const signed = signVolcRequest({
      accessKeyId: 'AKLTtest',
      secretAccessKey: 'secret',
      region: 'cn-beijing',
      canonicalQueryStr: q,
      body: Buffer.alloc(0),
      now: new Date('2024-06-21T12:00:00Z'),
    });
    assert.match(signed.authorization, /^HMAC-SHA256 Credential=AKLTtest\/20240621\/cn-beijing\/ark\/request,/);
    assert.match(signed.authorization, /SignedHeaders=host;x-date;x-content-sha256;content-type/);
    assert.equal(signed.xDate, '20240621T120000Z');
    assert.equal(signed.xContentSha256.length, 64);
  });
});

describe('mapCodingPlanResult', () => {
  it('映射 session/weekly/monthly 百分比', () => {
    const windows = mapCodingPlanResult({
      Status: 'Running',
      QuotaUsage: [
        { Level: 'session', Percent: 12.5, ResetTimestamp: 1786359991 },
        { Level: 'weekly', Percent: 40, ResetTimestamp: -1 },
        { Level: 'monthly', Percent: 8.2, ResetTime: '2026-09-01T00:00:00+08:00' },
      ],
    });
    assert.equal(windows.length, 3);
    assert.equal(windows[0].id, 'five_hour');
    assert.equal(windows[0].usedPercent, 12.5);
    assert.ok(windows[0].resetsAt);
    assert.equal(windows[1].resetsAt, null); // -1 → 无效
    assert.equal(windows[2].id, 'monthly');
  });
});

describe('mapAfpResult', () => {
  it('用 Quota/Used 算百分比', () => {
    const windows = mapAfpResult({
      AFPFiveHour: { Quota: 2000, Used: 500, ResetTime: 1786359991 },
      AFPWeekly: { Quota: 0, Used: 0 },
      AFPMonthly: { Quota: 10000, Used: 2500 },
    });
    assert.equal(windows.length, 2);
    assert.equal(windows[0].usedPercent, 25);
    assert.equal(windows[1].id, 'monthly');
    assert.equal(windows[1].usedPercent, 25);
  });
});

describe('extractResetAt', () => {
  it('忽略 ≤0', () => {
    assert.equal(extractResetAt(-1), null);
    assert.equal(extractResetAt(0), null);
  });
});

describe('mapArkcliUsagePlan', () => {
  it('优先 coding-plan periods', () => {
    const snap = mapArkcliUsagePlan({
      items: [
        {
          product: 'agent-plan',
          subscribed: true,
          periods: [{ label: '5h', percent: 10 }],
        },
        {
          product: 'coding-plan',
          edition: 'personal',
          subscribed: true,
          periods: [
            { label: 'session', percent: 40.74, reset_at: '2026-07-17T19:22:45+08:00' },
            { label: 'weekly', percent: 43.54 },
            { label: 'monthly', percent: 21.77 },
          ],
        },
      ],
    });
    assert.equal(snap.source, 'arkcli');
    assert.match(snap.plan, /Coding Plan/);
    assert.equal(snap.windows.length, 3);
    assert.equal(snap.windows[0].usedPercent, 40.74);
  });
});

describe('mapVolcengineUsage probe', () => {
  it('无配额头时带引导 warning', () => {
    const snap = mapVolcengineUsage({
      limit: null, remaining: null, reset: null, keyValid: true,
    }, { id: 'volcengine' });
    assert.equal(snap.available, true);
    assert.equal(snap.windows.length, 0);
    assert.match(snap.warning, /AccessKey|arkcli/);
  });

  it('有配额头时出请求窗口', () => {
    const snap = mapVolcengineUsage({
      limit: 100, remaining: 40, reset: '2026-08-11T12:00:00Z', keyValid: true,
    }, { id: 'volcengine' });
    assert.equal(snap.windows[0].usedPercent, 60);
  });
});

describe('resolveVolcAkSk', () => {
  it('从 credentials 读取', () => {
    const ak = resolveVolcAkSk({
      credentials: { access_key_id: 'AKLTabc', secret_access_key: 'sec' },
    });
    assert.deepEqual(ak, { accessKeyId: 'AKLTabc', secretAccessKey: 'sec' });
  });

  it('token 写成 AK:SK', () => {
    const ak = resolveVolcAkSk({ token: 'AKLTx:secret-value' });
    assert.equal(ak.accessKeyId, 'AKLTx');
    assert.equal(ak.secretAccessKey, 'secret-value');
  });
});

describe('normalizeUsageKey', () => {
  it('api-volcengine → volcengine', () => {
    assert.equal(normalizeUsageKey('api-volcengine'), 'volcengine');
  });
  it('volcengine-ark 保持按量 key', () => {
    assert.equal(normalizeUsageKey('volcengine-ark'), 'volcengine-ark');
  });
});

describe('fetchViaAkSk 不含余额', () => {
  it('withWindows 可无 credits', () => {
    const { withWindows } = require('../usage/volcengine');
    const snap = withWindows({ id: 'volcengine' }, {
      windows: [{ id: 'five_hour', title: '5 小时', usedPercent: 10, usageKnown: true }],
      plan: 'Coding Plan',
      source: 'openapi-coding',
      credits: null,
    });
    assert.equal(snap.credits, null);
    assert.equal(snap.windows.length, 1);
    assert.equal(snap.plan, 'Coding Plan');
  });
});
