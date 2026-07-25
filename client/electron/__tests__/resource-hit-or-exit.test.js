'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyLifecycle,
  listLifecycleNudges,
  lifecycleSortRank,
  THRESHOLDS,
} = require('../resource-hit-or-exit');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function res(partial) {
  return {
    id: 'r1',
    type: 'assistant',
    name: 'writer',
    display_name: '写作',
    created_at: Date.UTC(2026, 6, 1),
    use_count: 0,
    last_used_at: null,
    projections: [{ agentId: 'cursor', createdAt: Date.UTC(2026, 6, 1) }],
    ...partial,
  };
}

test('classifyLifecycle: 有命中 → active', () => {
  const life = classifyLifecycle(res({ use_count: 2, last_used_at: Date.UTC(2026, 6, 10) }), Date.UTC(2026, 6, 12));
  assert.equal(life.layer, 'active');
  assert.equal(life.nudge, null);
});

test('classifyLifecycle: 已投射 0 命中 <48h → pending 无轻推', () => {
  const enabled = Date.UTC(2026, 6, 12, 10);
  const life = classifyLifecycle(res({
    created_at: enabled,
    projections: [{ agentId: 'cursor', createdAt: enabled }],
  }), enabled + 12 * HOUR);
  assert.equal(life.layer, 'pending');
  assert.equal(life.nudge, null);
});

test('classifyLifecycle: 48h+ 0 命中 → pending + invoke', () => {
  const enabled = Date.UTC(2026, 6, 10);
  const life = classifyLifecycle(res({
    projections: [{ agentId: 'cursor', createdAt: enabled }],
  }), enabled + THRESHOLDS.nudgeHours * HOUR + 1);
  assert.equal(life.layer, 'pending');
  assert.equal(life.nudge, 'invoke');
});

test('classifyLifecycle: 7 日 0 命中 → dormant + unproject', () => {
  const enabled = Date.UTC(2026, 6, 1);
  const life = classifyLifecycle(res({
    projections: [{ agentId: 'cursor', createdAt: enabled }],
  }), enabled + THRESHOLDS.dormantDays * DAY);
  assert.equal(life.layer, 'dormant');
  assert.equal(life.nudge, 'unproject');
});

test('classifyLifecycle: 30 日 0 命中 → cold', () => {
  const enabled = Date.UTC(2026, 5, 1);
  const life = classifyLifecycle(res({
    projections: [{ agentId: 'cursor', createdAt: enabled }],
  }), enabled + THRESHOLDS.coldDays * DAY);
  assert.equal(life.layer, 'cold');
  assert.equal(life.nudge, 'cold_letter');
});

test('classifyLifecycle: 无投射 → shelf', () => {
  const life = classifyLifecycle(res({ projections: [] }), Date.UTC(2026, 6, 20));
  assert.equal(life.layer, 'shelf');
});

test('listLifecycleNudges 按年龄倒序截断', () => {
  const now = Date.UTC(2026, 6, 20);
  const items = listLifecycleNudges([
    res({ id: 'a', name: 'a', projections: [{ agentId: 'c', createdAt: now - 3 * DAY }] }),
    res({ id: 'b', name: 'b', projections: [{ agentId: 'c', createdAt: now - 10 * DAY }] }),
    res({ id: 'c', name: 'c', use_count: 1, projections: [{ agentId: 'c', createdAt: now - 40 * DAY }] }),
  ], { now, limit: 5 });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'b');
  assert.equal(items[0].nudge, 'unproject');
  assert.equal(items[1].id, 'a');
  assert.equal(items[1].nudge, 'invoke');
});

test('classifyLifecycle: 内置智能体 → exempt，不轻推', () => {
  const life = classifyLifecycle(res({
    source: 'builtin',
    name: 'resource-installer',
    projections: [{ agentId: 'cursor', createdAt: Date.UTC(2026, 0, 1) }],
  }), Date.UTC(2026, 6, 20));
  assert.equal(life.layer, 'exempt');
  assert.equal(life.nudge, null);
});

test('listLifecycleNudges 跳过内置智能体', () => {
  const now = Date.UTC(2026, 6, 20);
  const items = listLifecycleNudges([
    res({
      id: 'builtin-1',
      name: 'resource-finder',
      source: 'builtin',
      projections: [{ agentId: 'c', createdAt: now - 10 * DAY }],
    }),
    res({ id: 'user-1', name: 'writer', projections: [{ agentId: 'c', createdAt: now - 10 * DAY }] }),
  ], { now, limit: 5 });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'user-1');
});

test('lifecycleSortRank active 最前', () => {
  assert.ok(lifecycleSortRank('active') < lifecycleSortRank('pending'));
  assert.ok(lifecycleSortRank('pending') < lifecycleSortRank('cold'));
});
