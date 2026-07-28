'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { iterFileLines, countJsonlLines } = require('../session-import');

function tmp(name, content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'si-')), name);
  fs.writeFileSync(p, content);
  return p;
}

test('iterFileLines: 基本按行切分，含无尾换行的末行', () => {
  const p = tmp('a.jsonl', 'one\ntwo\nthree');
  assert.deepEqual([...iterFileLines(p)], ['one', 'two', 'three']);
});

test('iterFileLines: 保留空行（trim/过滤交给调用方）', () => {
  const p = tmp('b.jsonl', 'x\n\ny\n');
  assert.deepEqual([...iterFileLines(p)], ['x', '', 'y']);
});

test('iterFileLines: 跨块边界的多字节 UTF-8 不产生替换符', () => {
  // 每行 >1MB，强制跨 CHUNK(1MB) 边界，且行内含多字节汉字
  const line1 = '甲'.repeat(600 * 1024);   // ~1.8MB (每字符 3 字节)
  const line2 = '乙'.repeat(600 * 1024);
  const p = tmp('c.jsonl', line1 + '\n' + line2 + '\n');
  const got = [...iterFileLines(p)];
  assert.equal(got.length, 2);
  assert.equal(got[0], line1);
  assert.equal(got[1], line2);
  assert.ok(!got.join('').includes('�'), '不应出现 U+FFFD 替换符');
});

test('countJsonlLines: 与 split().filter(Boolean).length 一致', () => {
  const content = 'a\n\n b \n\nc\n';
  const p = tmp('d.jsonl', content);
  const expected = content.split('\n').map(l => l.trim()).filter(Boolean).length;
  assert.equal(countJsonlLines(p), expected);
  assert.equal(countJsonlLines(p), 3);
});
