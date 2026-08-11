'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapAgnesUsage,
  resolveAgnesBase,
  detectRegion,
  INTL_BASE,
  CN_BASE,
} = require('../usage/agnes');
const { normalizeUsageKey } = require('../usage');

describe('agnes region / base', () => {
  it('中国站 base_url → cn + api.agnes-ai.cn', () => {
    const p = { base_url: 'https://api.agnes-ai.cn/v1' };
    assert.equal(detectRegion(p.base_url), 'cn');
    assert.equal(resolveAgnesBase(p), 'https://api.agnes-ai.cn/v1');
  });

  it('国际站 base_url → intl + apihub', () => {
    const p = { base_url: 'https://apihub.agnes-ai.com/v1' };
    assert.equal(detectRegion(p.base_url), 'intl');
    assert.equal(resolveAgnesBase(p), INTL_BASE);
  });

  it('无 /v1 时自动补全', () => {
    assert.equal(resolveAgnesBase({ base_url: 'https://api.agnes-ai.cn' }), CN_BASE);
  });

  it('默认走国际站', () => {
    assert.equal(resolveAgnesBase({}), INTL_BASE);
  });
});

describe('agnes mapAgnesUsage', () => {
  it('有限额度：美分 → USD，计算剩余', () => {
    const snap = mapAgnesUsage({
      subscription: { soft_limit_usd: 10, hard_limit_usd: 20 },
      usage: { total_usage: 350 }, // $3.50
      region: 'intl',
    }, { id: 'agnes-ai', base_url: 'https://apihub.agnes-ai.com/v1' });
    assert.equal(snap.credits.used, 3.5);
    assert.equal(snap.credits.total, 20);
    assert.equal(snap.credits.remaining, 16.5);
    assert.equal(snap.credits.currency, 'USD');
    assert.equal(snap.credits.unlimited, false);
    assert.ok(Math.abs(snap.credits.usedPercent - 17.5) < 1e-6);
    assert.equal(snap.plan, null);
    assert.equal(snap.region, 'intl');
    assert.equal(snap.source, 'dashboard-billing');
  });

  it('无限额度哨兵 100000000', () => {
    const snap = mapAgnesUsage({
      subscription: { hard_limit_usd: 100000000 },
      usage: { total_usage: 1250 },
      region: 'cn',
    }, { id: 'agnes-ai', base_url: 'https://api.agnes-ai.cn/v1' });
    assert.equal(snap.credits.unlimited, true);
    assert.equal(snap.credits.used, 12.5);
    assert.equal(snap.credits.remaining, null);
    assert.equal(snap.credits.total, null);
    assert.equal(snap.plan, 'Token · 无限');
    assert.equal(snap.region, 'cn');
    assert.equal(snap.windows.length, 0);
  });
});

describe('agnes normalizeUsageKey', () => {
  it('别名归一', () => {
    assert.equal(normalizeUsageKey('agnes-ai'), 'agnes-ai');
    assert.equal(normalizeUsageKey('api-agnes-ai'), 'agnes-ai');
    assert.equal(normalizeUsageKey('agnes'), 'agnes-ai');
  });
});
