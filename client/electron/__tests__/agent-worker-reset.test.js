'use strict';
// 贡献者 worker 回传上游 reset：resetSuffixFromHeaders 从上游响应头解析 reset 并规范成
// " (reset at <ISO+00:00>)"，须能被消费端 gateway-cooldown.parseResetMs 解回同一时刻。
const { test } = require('node:test');
const assert = require('node:assert');
const { resetSuffixFromHeaders } = require('../agent-worker');
const cd = require('../gateway-cooldown');

const NOW = Date.parse('2026-07-12T00:00:00+08:00');

test('绝对 reset 头 → round-trip 精确解回同一时刻（注入 now，与真机时钟无关）', () => {
  // 用 NOW+3 天（在 35 天封顶内）保证是「将来」，不被 parseResetFromHeaders 过滤/封顶
  const iso = '2026-07-15T00:00:00+08:00';   // = NOW + 3 天
  for (const key of ['anthropic-ratelimit-unified-reset', 'anthropic-ratelimit-requests-reset', 'x-ratelimit-reset']) {
    const suffix = resetSuffixFromHeaders({ [key]: iso }, NOW);
    assert.match(suffix, /^ \(reset at .+\)$/, key);
    assert.equal(cd.parseResetMs(`HTTP 429${suffix}`, NOW), Date.parse(iso), key);   // 秒级精确
  }
});

test('相对 reset 头(retry-after/时长串) → round-trip 到 now+delta（注入 now）', () => {
  for (const [headers, deltaMs] of [
    [{ 'retry-after': '600' }, 600_000],
    [{ 'Retry-After': '600' }, 600_000],    // 大小写不敏感
    [{ 'x-ratelimit-reset-requests': '6m0s' }, 6 * 60_000],
  ]) {
    const suffix = resetSuffixFromHeaders(headers, NOW);
    assert.match(suffix, /^ \(reset at .+\)$/);
    assert.equal(cd.parseResetMs(`HTTP 429${suffix}`, NOW), NOW + deltaMs, JSON.stringify(headers));
  }
});

test('无 reset 头 → 空后缀（不影响原错误文本）', () => {
  assert.equal(resetSuffixFromHeaders({}), '');
  assert.equal(resetSuffixFromHeaders({ 'content-type': 'application/json' }), '');
});

test('缺失/异常 headers → 空后缀，绝不抛异常', () => {
  assert.equal(resetSuffixFromHeaders(null), '');
  assert.equal(resetSuffixFromHeaders(undefined), '');
  assert.equal(resetSuffixFromHeaders('not-an-object'), '');
  assert.equal(resetSuffixFromHeaders({ 'retry-after': 'garbage-not-a-number' }), '');
  assert.equal(resetSuffixFromHeaders({ 'retry-after': '' }), '');
});

test('过去时刻的 reset 头 → 不生成后缀（parseResetFromHeaders 已过滤）', () => {
  // 绝对过去时间的 reset 头 → 应被过滤（相对 NOW=2026）
  assert.equal(resetSuffixFromHeaders({ 'anthropic-ratelimit-unified-reset': '2000-01-01T00:00:00+00:00' }, NOW), '');
});
