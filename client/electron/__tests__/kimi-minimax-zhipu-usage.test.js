'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapKimiCodeUsage, usedPercentFromDetail } = require('../usage/kimi-code');
const { mapMiniMaxUsage, mapBalanceCredits, mapModelRemain } = require('../usage/minimax');
const { mapZhipuUsage, mapQuotaLimits } = require('../usage/zhipu');
const { normalizeUsageKey } = require('../usage');

describe('kimi-code mapKimiCodeUsage', () => {
  it('映射周配额与 5h 窗', () => {
    const snap = mapKimiCodeUsage({
      user: { membership: { level: 'LEVEL_ADVANCED' } },
      usage: { limit: '2048', used: '214', remaining: '1834', resetTime: '2026-01-09T15:23:13.716839300Z' },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '200', used: '50', remaining: '150', resetTime: '2026-01-06T13:33:02Z' },
      }],
    }, { id: 'kimi-code' });
    assert.equal(snap.plan, 'Moderato');
    assert.equal(snap.windows.length, 2);
    assert.ok(Math.abs(snap.windows[0].usedPercent - (214 / 2048) * 100) < 1e-6);
    assert.equal(snap.windows[1].id, 'five_hour');
    assert.equal(snap.windows[1].usedPercent, 25);
  });

  it('仅 remaining 时推算已用百分比', () => {
    assert.equal(usedPercentFromDetail({ limit: '100', remaining: '40' }), 60);
  });
});

describe('minimax map', () => {
  it('query_balance → credits', () => {
    const c = mapBalanceCredits({
      available_amount: '12.34',
      cash_balance: '10.00',
      voucher_balance: '2.34',
      credit_balance: '0',
    });
    assert.equal(c.remaining, 12.34);
    assert.equal(c.toppedUp, 10);
    assert.equal(c.currency, 'CNY');
  });

  it('remaining percent 反转为已用', () => {
    const w = mapModelRemain({
      model_name: 'general',
      current_interval_remaining_percent: 80,
      start_time: 0,
      end_time: 5 * 3600 * 1000,
    });
    assert.equal(w.usedPercent, 20);
    assert.equal(w.id.startsWith('five_hour'), true);
  });

  it('合并 remains + balance', () => {
    const snap = mapMiniMaxUsage({
      remains: {
        model_remains: [{
          model_name: 'MiniMax-M2.5',
          current_interval_total_count: 100,
          current_interval_usage_count: 70,
          start_time: Date.now(),
          end_time: Date.now() + 5 * 3600 * 1000,
        }],
        base_resp: { status_code: 0 },
      },
      balance: { available_amount: '1.5', cash_balance: '1.5', base_resp: { status_code: 0 } },
    }, { id: 'minimax' });
    assert.ok(snap.windows.length >= 1);
    assert.equal(snap.credits.remaining, 1.5);
  });
});

describe('zhipu map', () => {
  it('Coding Plan limits → 5h / 周 / MCP', () => {
    const { windows, plan } = mapQuotaLimits({
      level: 'pro',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12, nextResetTime: Date.now() + 3600000 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40, nextResetTime: Date.now() + 86400000 },
        { type: 'TIME_LIMIT', usage: 1000, currentValue: 100, remaining: 900, percentage: 10 },
      ],
    });
    assert.match(plan, /pro/i);
    assert.equal(windows.find((w) => w.id === 'five_hour').usedPercent, 12);
    assert.equal(windows.find((w) => w.id === 'seven_day').usedPercent, 40);
    assert.equal(windows.find((w) => w.id === 'mcp_monthly').usedPercent, 10);
  });

  it('仅余额', () => {
    const snap = mapZhipuUsage({ quota: null, balance: 98.754 }, { id: 'zhipu' });
    assert.equal(snap.credits.remaining, 98.754);
    assert.equal(snap.windows.length, 0);
  });
});

describe('normalizeUsageKey aliases', () => {
  it('映射三家别名', () => {
    assert.equal(normalizeUsageKey('api-kimi-code'), 'kimi-code');
    assert.equal(normalizeUsageKey('api-minimax'), 'minimax');
    assert.equal(normalizeUsageKey('zhipuai'), 'zhipu');
    assert.equal(normalizeUsageKey('bigmodel'), 'zhipu');
  });
});
