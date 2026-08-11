'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapBalanceAcctResult,
  signBillingGet,
} = require('../usage/volcengine-billing');

describe('mapBalanceAcctResult', () => {
  it('AvailableBalance 对齐控制台余额', () => {
    const c = mapBalanceAcctResult({
      AccountID: 2100123456,
      AvailableBalance: '14.8879',
      CashBalance: '14.8879',
      CreditLimit: '0.0000',
      FreezeAmount: '0',
      ArrearsBalance: '0',
    });
    assert.equal(c.remaining, 14.8879);
    assert.equal(c.cash, 14.8879);
    assert.equal(c.creditLimit, 0);
    assert.equal(c.currency, 'CNY');
  });

  it('缺 AvailableBalance 时回退 CashBalance', () => {
    const c = mapBalanceAcctResult({ CashBalance: '3.5' });
    assert.equal(c.remaining, 3.5);
  });

  it('无金额字段返回 null', () => {
    assert.equal(mapBalanceAcctResult({}), null);
  });
});

describe('signBillingGet', () => {
  it('SignedHeaders 为 host;x-date，scope 含 billing', () => {
    const signed = signBillingGet({
      accessKeyId: 'AKLTtest',
      secretAccessKey: 'secret',
      canonicalQueryStr: 'Action=QueryBalanceAcct&Version=2022-01-01',
      now: new Date('2025-03-29T18:09:37Z'),
    });
    assert.equal(signed.xDate, '20250329T180937Z');
    assert.match(signed.authorization, /\/cn-beijing\/billing\/request/);
    assert.match(signed.authorization, /SignedHeaders=host;x-date/);
  });
});
