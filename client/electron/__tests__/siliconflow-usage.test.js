'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapSiliconFlowUsage,
  mapWalletFinancialInfo,
  resolveUserInfoUrl,
  scaleBalance,
  BALANCE_SCALE,
} = require('../usage/siliconflow');

describe('mapSiliconFlowUsage', () => {
  it('解析 totalBalance / chargeBalance / balance', () => {
    const snap = mapSiliconFlowUsage({
      code: 20000,
      status: true,
      data: {
        email: 'a@b.com',
        balance: '0.88',
        chargeBalance: '10.00',
        totalBalance: '10.88',
      },
    }, { id: 'siliconflow' });
    assert.equal(snap.provider, 'siliconflow');
    assert.equal(snap.credits.currency, 'CNY');
    assert.equal(snap.credits.total, 10.88);
    assert.equal(snap.credits.remaining, 10.88);
    assert.equal(snap.credits.granted, 0.88);
    assert.equal(snap.credits.toppedUp, 10);
    assert.equal(snap.email, 'a@b.com');
    assert.equal(snap.windows.length, 0);
  });

  it('仅 balance 时回退', () => {
    const snap = mapSiliconFlowUsage({
      data: { balance: '1.5' },
    }, { id: 'siliconflow' });
    assert.equal(snap.credits.remaining, 1.5);
  });
});

describe('mapWalletFinancialInfo', () => {
  it('按 1e12 缩放，对齐控制台 14.8879', () => {
    const snap = mapWalletFinancialInfo({
      balance: '14887933110000',
      available: '14887933110000',
      recharged: '100000000000000',
      used: '85112066890000',
      lineOfCredit: '0',
      remainingCreditLine: '0',
    }, { id: 'siliconflow' });
    assert.ok(snap);
    assert.equal(snap.source, 'walletd-peek');
    assert.equal(snap.credits.currency, 'CNY');
    // 14.88793311 → 展示侧 toFixed(4) 为 14.8879
    assert.ok(Math.abs(snap.credits.remaining - 14.88793311) < 1e-9);
    assert.equal(snap.credits.toppedUp, 100);
    assert.equal(snap.credits.creditLimit, 0);
    assert.ok(Math.abs(snap.credits.used - 85.11206689) < 1e-9);
  });
});

describe('scaleBalance', () => {
  it('除以 BALANCE_SCALE', () => {
    assert.equal(BALANCE_SCALE, 1e12);
    assert.equal(scaleBalance('1000000000000'), 1);
    assert.equal(scaleBalance(null), null);
  });
});

describe('resolveUserInfoUrl', () => {
  it('拼接 base_url', () => {
    assert.equal(
      resolveUserInfoUrl({ base_url: 'https://api.siliconflow.cn/v1/' }),
      'https://api.siliconflow.cn/v1/user/info',
    );
  });
});
