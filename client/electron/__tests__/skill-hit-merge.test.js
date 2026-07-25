'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const resourceManager = require('../resource-manager');
const { classifyLifecycle } = require('../resource-hit-or-exit');

test('_mergeSkillCallHits：会话调用抬升 use_count / last_used_at', () => {
  const resource = {
    type: 'skill',
    name: 'apple-design',
    display_name: 'apple-design',
    use_count: 0,
    last_used_at: null,
    projections: [{ agentId: 'cursor', createdAt: Date.UTC(2026, 0, 1) }],
  };
  const map = new Map([
    ['apple-design', { count: 3, lastTs: Date.UTC(2026, 6, 25, 14) }],
  ]);
  resourceManager._mergeSkillCallHits(resource, map);
  assert.equal(resource.use_count, 3);
  assert.equal(resource.last_used_at, Date.UTC(2026, 6, 25, 14));
  const life = classifyLifecycle(resource, Date.UTC(2026, 6, 25, 15));
  assert.equal(life.layer, 'active');
  assert.equal(life.nudge, null);
});

test('_mergeSkillCallHits：不降低已有更高命中', () => {
  const resource = {
    type: 'skill',
    name: 'canvas',
    use_count: 10,
    last_used_at: Date.UTC(2026, 6, 20),
  };
  resourceManager._mergeSkillCallHits(resource, new Map([
    ['canvas', { count: 2, lastTs: Date.UTC(2026, 6, 10) }],
  ]));
  assert.equal(resource.use_count, 10);
  assert.equal(resource.last_used_at, Date.UTC(2026, 6, 20));
});
