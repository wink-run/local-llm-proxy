'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSessionCookieValue,
  formatCursorMembership,
  parseUsageSummary,
  mapCursorUsage,
  jwtSub,
} = require('../usage/cursor');

describe('buildSessionCookieValue', () => {
  it('JWT → userId%3A%3Atoken', () => {
    // header.payload.sig；payload = {"sub":"user_1"}
    const payload = Buffer.from(JSON.stringify({ sub: 'user_1' })).toString('base64url');
    const jwt = `eyJhbGciOiJub25lIn0.${payload}.x`;
    assert.equal(buildSessionCookieValue(jwt), `user_1%3A%3A${jwt}`);
  });

  it('已是 combo 时保持 %3A%3A', () => {
    assert.equal(buildSessionCookieValue('u%3A%3Atok'), 'u%3A%3Atok');
    assert.equal(buildSessionCookieValue('u::tok'), 'u%3A%3Atok');
  });
});

describe('formatCursorMembership', () => {
  it('pro_plus → Pro+', () => {
    assert.equal(formatCursorMembership('pro_plus'), 'Pro+');
    assert.equal(formatCursorMembership('pro'), 'Pro');
  });
});

describe('mapCursorUsage', () => {
  it('有请求额度时标题为会话 · 请求', () => {
    const parsed = parseUsageSummary({
      membershipType: 'pro_plus',
      billingCycleEnd: '2026-08-29T00:00:00.000Z',
      individualUsage: {
        plan: { totalPercentUsed: 18, autoPercentUsed: 20, apiPercentUsed: 0, used: 100, limit: 7000 },
      },
    }, { requestUsage: { 'gpt-4': { numRequestsTotal: 7, maxRequestUsage: 10 } } });
    const snap = mapCursorUsage(parsed, {});
    assert.equal(snap.plan, 'Pro+');
    assert.equal(snap.windows[0].id, 'session_requests');
    assert.equal(snap.windows[0].title, '会话 · 请求');
    assert.equal(snap.windows[0].usedPercent, 70);
  });

  it('无请求额度时回退套餐百分比', () => {
    const parsed = parseUsageSummary({
      membershipType: 'pro',
      individualUsage: { plan: { totalPercentUsed: 42, autoPercentUsed: 10, apiPercentUsed: 20 } },
    });
    const snap = mapCursorUsage(parsed, {});
    assert.equal(snap.windows[0].title, '套餐额度');
    assert.equal(snap.windows[0].usedPercent, 42);
    assert.ok(snap.windows.some(w => w.id === 'auto'));
  });
});

describe('jwtSub', () => {
  it('解析 sub', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'abc' })).toString('base64url');
    assert.equal(jwtSub(`x.${payload}.y`), 'abc');
  });
});
