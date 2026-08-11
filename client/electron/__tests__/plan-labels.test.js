'use strict';
/**
 * 订阅计划标签：对齐 token-monitor limitPlanLabels 行为。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  claudePlanLabelFromParts,
  codexPlanLabelFromParts,
} = require('../usage/plan-labels');
const { inferClaudePlan } = require('../usage/claude');
const { mapCodexUsage } = require('../usage/codex');

describe('claudePlanLabelFromParts', () => {
  it('Max + rate_limit_tier 保留倍率', () => {
    assert.equal(claudePlanLabelFromParts('max', 'default_claude_max_20x'), 'Max 20x');
    assert.equal(claudePlanLabelFromParts('max', 'default_claude_max_5x'), 'Max 5x');
  });

  it('Team 不因 max 字样的 tier 误标成 Max', () => {
    assert.equal(claudePlanLabelFromParts('team', 'default_claude_max_5x'), 'Team');
  });

  it('仅有 tier 时可回退', () => {
    assert.equal(claudePlanLabelFromParts('', 'default_claude_max_5x'), 'Max 5x');
    assert.equal(claudePlanLabelFromParts('pro', ''), 'Pro');
  });
});

describe('inferClaudePlan', () => {
  it('has_claude_max + rate_limit_tier → Max 20x', () => {
    assert.equal(inferClaudePlan({
      account: { has_claude_max: true },
      organization: { rate_limit_tier: 'default_claude_max_20x' },
    }), 'Max 20x');
  });

  it('has_claude_pro → Pro', () => {
    assert.equal(inferClaudePlan({
      account: { has_claude_pro: true },
      organization: {},
    }), 'Pro');
  });
});

describe('codexPlanLabelFromParts', () => {
  it('pro / prolite 映射倍率名', () => {
    assert.equal(codexPlanLabelFromParts('pro'), 'Pro 20x');
    assert.equal(codexPlanLabelFromParts('prolite'), 'Pro 5x');
    assert.equal(codexPlanLabelFromParts('Codex Pro Lite'), 'Pro 5x');
  });

  it('企业档位压成短词', () => {
    assert.equal(codexPlanLabelFromParts('free'), 'Free');
    assert.equal(codexPlanLabelFromParts('enterprise_cbp_usage_based'), 'Enterprise');
    assert.equal(codexPlanLabelFromParts('self_serve_business_usage_based'), 'Business');
  });
});

describe('mapCodexUsage plan', () => {
  it('归一 plan_type', () => {
    const snap = mapCodexUsage({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1717200000, limit_window_seconds: 18000 },
      },
    }, { id: 'codex' });
    assert.equal(snap.plan, 'Pro 20x');
  });
});
