'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readBoundedLines, createTraceCache, traceCacheKey,
} = require('../session-trace/shared');

function tmp(content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-')), 'wire.jsonl');
  fs.writeFileSync(p, content);
  return p;
}

test('readBoundedLines: 过滤空行、统计非空行数与错误行', () => {
  const p = tmp('{"a":1}\n\n{"is_error":true}\n {"b":2} \n');
  const r = readBoundedLines(p);
  assert.equal(r.lineCount, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.rawErrorCount, 1);
  assert.deepEqual(r.lines, ['{"a":1}', '{"is_error":true}', ' {"b":2} ']);
});

test('readBoundedLines: 超过 maxLines 截断并置 truncated', () => {
  const p = tmp(Array.from({ length: 100 }, (_, i) => `{"i":${i}}`).join('\n') + '\n');
  const r = readBoundedLines(p, { maxLines: 10 });
  assert.equal(r.truncated, true);
  assert.equal(r.lineCount, 10);
});

test('readBoundedLines: 超过 maxBytes 截断', () => {
  const big = 'x'.repeat(2000);
  const p = tmp(Array.from({ length: 50 }, () => `{"v":"${big}"}`).join('\n') + '\n');
  const r = readBoundedLines(p, { maxLines: 1000, maxBytes: 10 * 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.lineCount < 50);
});

test('createTraceCache: 命中返回等价结果，且改写副本 tokens 不污染缓存', () => {
  const cache = createTraceCache(2);
  const val = { steps: [1, 2], stats: { tokens: { input: 5 } } };
  const set = cache.set('k1', val);
  set.stats.tokens.input = 999; // 改写返回副本
  const got = cache.get('k1');
  assert.equal(got.stats.tokens.input, 5);
  assert.deepEqual(got.steps, [1, 2]);
});

test('createTraceCache: 超过容量淘汰最旧项（LRU）', () => {
  const cache = createTraceCache(2);
  cache.set('a', { stats: {} });
  cache.set('b', { stats: {} });
  cache.get('a');                 // 触碰 a → b 变最旧
  cache.set('c', { stats: {} });  // 淘汰 b
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), null);
  assert.ok(cache.get('c'));
});

test('traceCacheKey: 随 mtime/size 变化', () => {
  assert.notEqual(
    traceCacheKey('/f', { mtimeMs: 1, size: 10 }),
    traceCacheKey('/f', { mtimeMs: 2, size: 10 }),
  );
  assert.equal(
    traceCacheKey('/f', { mtimeMs: 1, size: 10 }),
    traceCacheKey('/f', { mtimeMs: 1, size: 10 }),
  );
});
