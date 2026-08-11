'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapCodexRpcUsage, mapCodexUsage } = require('../usage/codex');
const { codexCommandCandidates } = require('../usage/codex-rpc');

describe('mapCodexRpcUsage', () => {
  it('解析 app-server primary 月度窗 + planType', () => {
    const snap = mapCodexRpcUsage({
      account: { email: 'a@b.com', planType: 'free' },
      rateLimits: {
        primary: { usedPercent: 21, windowDurationMins: 43200, resetsAt: 1787825256 },
        secondary: null,
        planType: 'free',
      },
      sourceDetail: 'app',
    }, { id: 'codex' });
    assert.equal(snap.plan, 'Free');
    assert.equal(snap.email, 'a@b.com');
    assert.equal(snap.source, 'rpc');
    assert.equal(snap.windows[0].id, 'monthly');
    assert.equal(snap.windows[0].title, '本月额度');
    assert.equal(snap.windows[0].usedPercent, 21);
    assert.ok(snap.windows[0].resetsAt);
  });

  it('5h 窗标为会话', () => {
    const snap = mapCodexRpcUsage({
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1787825256 },
        secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1787900000 },
        planType: 'pro',
      },
    });
    assert.equal(snap.plan, 'Pro 20x');
    assert.equal(snap.windows[0].id, 'five_hour');
    assert.equal(snap.primary.id, 'five_hour');
  });
});

describe('mapCodexUsage wham', () => {
  it('兼容旧 wham 形状', () => {
    const snap = mapCodexUsage({
      plan_type: 'prolite',
      rate_limit: {
        primary_window: { used_percent: 12, reset_at: 1717200000, limit_window_seconds: 18000 },
      },
    }, { id: 'codex' });
    assert.equal(snap.plan, 'Pro 5x');
    assert.equal(snap.windows[0].id, 'five_hour');
  });
});

describe('codexCommandCandidates', () => {
  it('darwin 含 ChatGPT.app 路径', () => {
    const list = codexCommandCandidates({ HOME: '/tmp' }, 'darwin');
    assert.ok(list.includes('/Applications/ChatGPT.app/Contents/Resources/codex'));
    assert.ok(list.includes('codex'));
  });
});
