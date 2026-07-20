'use strict';
// 网关失败候选冷却：硬失败(429/401/403/402)记冷却；429 带 reset 时间精确到重置点；
// sink 把冷却候选下沉末尾（不删除）；成功 clear 恢复。
const { test } = require('node:test');
const assert = require('node:assert');
const cd = require('../gateway-cooldown');

const NOW = Date.parse('2026-07-12T00:00:00+08:00');   // 固定基准（reset 前 3 天，贴近真实场景）

test('parseResetMs：解析 "reset at 2026-07-15 23:59:59 +0800 CST"', () => {
  const msg = 'HTTP_429: You have exceeded the monthly usage quota. It will reset at 2026-07-15 23:59:59 +0800 CST. Request id: x';
  const ms = cd.parseResetMs(msg, NOW);
  assert.equal(ms, Date.parse('2026-07-15T23:59:59+08:00'));
});

test('parseResetMs：无 reset 文本 → null；过去时间 → null', () => {
  assert.equal(cd.parseResetMs('HTTP_429: rate limited', NOW), null);
  assert.equal(cd.parseResetMs('reset at 2000-01-01 00:00:00 +0000', NOW), null);
});

test('classify：429 带 reset → persist=quota-reset + until≈reset(+缓冲)', () => {
  const withReset = cd.classify({ status: 429, message: 'quota. It will reset at 2026-07-15 23:59:59 +0800' }, NOW);
  assert.equal(withReset.persist, true);
  assert.equal(withReset.reason, 'quota-reset');
  assert.ok(withReset.until > Date.parse('2026-07-15T23:59:59+08:00'));   // +缓冲
});

test('classify：429 分级——配额关键词 vs 纯瞬时限流', () => {
  // 有配额关键词、无 reset → quota 10min，不持久
  const quota = cd.classify({ status: 429, message: 'HTTP_429: you exceeded the monthly usage quota' }, NOW);
  assert.equal(quota.reason, 'quota');
  assert.equal(quota.persist, false);
  assert.equal(quota.until, NOW + 10 * 60_000);
  // 纯突发限流(无配额词、无 reset) → 瞬时 45s，不误当配额长冷却
  const burst = cd.classify({ status: 429, message: 'HTTP_429: rate limit, too many requests' }, NOW);
  assert.equal(burst.reason, 'rate-limit');
  assert.equal(burst.until, NOW + 45_000);
});

test('classify：优先读响应头 Retry-After / *-ratelimit-*-reset', () => {
  // Retry-After 整数秒(远期) → 落盘配额级
  const ra = cd.classify({ status: 429, message: 'HTTP_429', headers: { 'retry-after': '600' } }, NOW);
  assert.equal(ra.until, NOW + 600_000 + 30_000);   // +缓冲
  assert.equal(ra.persist, true);
  // anthropic RFC3339 reset 头
  const iso = '2026-07-12T02:00:00+08:00';
  const an = cd.classify({ status: 429, message: 'HTTP_429', headers: { 'anthropic-ratelimit-unified-reset': iso } }, NOW);
  assert.equal(an.until, Date.parse(iso) + 30_000);
  // 短 Retry-After(几秒) → 视为瞬时，不落盘
  const shortRa = cd.classify({ status: 429, message: 'HTTP_429', headers: { 'retry-after': '3' } }, NOW);
  assert.equal(shortRa.persist, false);
  assert.equal(shortRa.reason, 'rate-limit');
});

test('parseResetFromHeaders：openai 时长串 / unix 秒', () => {
  assert.equal(cd.parseResetFromHeaders({ 'x-ratelimit-reset-requests': '6m0s' }, NOW), NOW + 6 * 60_000);
  const unix = Math.floor(Date.parse('2026-07-13T00:00:00+08:00') / 1000);
  assert.equal(cd.parseResetFromHeaders({ 'x-ratelimit-reset': String(unix) }, NOW), unix * 1000);
});

test('classify：401/403 → auth；402 → credit；5xx/超时 → null(不冷却)', () => {
  assert.equal(cd.classify({ status: 401, message: 'HTTP_401: unauthorized' }, NOW).reason, 'auth');
  assert.equal(cd.classify({ status: 403, message: 'HTTP_403' }, NOW).reason, 'auth');
  assert.equal(cd.classify({ status: 402, message: 'insufficient credits' }, NOW).reason, 'credit');
  assert.equal(cd.classify({ status: 500, message: 'HTTP_500: boom' }, NOW), null);
  assert.equal(cd.classify({ status: 504, message: 'timeout' }, NOW), null);
});

test('noteFailure + isCooling：冷却期内命中，过期后自动清', () => {
  const k = 'prov-a';
  const e = cd.noteFailure(k, { status: 401, message: 'HTTP_401' }, NOW);
  assert.equal(e._new, true);
  assert.ok(cd.isCooling(k, NOW + 60_000));            // 30min 内仍冷却
  assert.ok(!cd.isCooling(k, NOW + 60 * 60_000));      // 1h 后已过期
});

test('noteFailure：非硬失败(500)不纳入冷却', () => {
  assert.equal(cd.noteFailure('prov-500', { status: 500, message: 'boom' }, NOW), null);
  assert.ok(!cd.isCooling('prov-500', NOW));
});

test('sink：冷却候选下沉末尾、保序，不删除任何项', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  cd.noteFailure('b', { status: 429, message: 'HTTP_429' }, NOW);
  const out = cd.sink(items, (it) => it.id, NOW + 1000);
  assert.deepEqual(out.map(x => x.id), ['a', 'c', 'b']);   // b 下沉，a/c 保序
  assert.equal(out.length, 3);                              // 不删除
  cd.clear('b');
});

test('clear：成功后清除，候选回到原序', () => {
  const items = [{ id: 'x' }, { id: 'y' }];
  cd.noteFailure('y', { status: 429, message: 'HTTP_429' }, NOW);
  assert.deepEqual(cd.sink(items, (it) => it.id, NOW + 1000).map(x => x.id), ['x', 'y']);   // 已在末尾
  cd.clear('y');
  assert.ok(!cd.isCooling('y', NOW + 1000));
});

test('sink：全部冷却也不返回空（保证永远有可试的兜底）', () => {
  const items = [{ id: 'p' }, { id: 'q' }];
  cd.noteFailure('p', { status: 429, message: 'HTTP_429' }, NOW);
  cd.noteFailure('q', { status: 429, message: 'HTTP_429' }, NOW);
  const out = cd.sink(items, (it) => it.id, NOW + 1000);
  assert.equal(out.length, 2);
  cd.clear('p'); cd.clear('q');
});
