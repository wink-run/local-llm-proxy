'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { autoDetectFilter } = require('../rtk/autodetect');
const { safeApply } = require('../rtk/applyFilter');

test('autoDetectFilter returns null for short plain text', () => {
  assert.equal(autoDetectFilter('hello world'), null);
});

test('autoDetectFilter detects git diff', () => {
  const diff = 'diff --git a/foo.js b/foo.js\n@@ -1,3 +1,4 @@\n context\n+added\n-removed\n context2\n context3';
  const fn = autoDetectFilter(diff);
  assert.ok(fn !== null);
  assert.equal(fn.filterName, 'git-diff');
  const out = safeApply(fn, diff);
  assert.ok(typeof out === 'string');
  assert.ok(out.length > 0);
});

test('autoDetectFilter detects grep output', () => {
  const grep = 'src/foo.js:12:function bar() {\nsrc/foo.js:15:  return bar;\nsrc/baz.py:3:def bar():';
  const fn = autoDetectFilter(grep);
  assert.ok(fn !== null);
  assert.equal(fn.filterName, 'grep');
  const out = safeApply(fn, grep);
  assert.ok(out.includes('matches'));
});

test('autoDetectFilter detects find output', () => {
  const find = './src/a.js\n./src/b.js\n./src/c.js\n./test/d.js\n./test/e.js';
  const fn = autoDetectFilter(find);
  assert.ok(fn !== null);
  assert.equal(fn.filterName, 'find');
  const out = safeApply(fn, find);
  assert.ok(out.includes('files'));
});

test('autoDetectFilter detects tree output', () => {
  const tree = 'src\n├── a.js\n└── b.js\n2 directories, 5 files';
  const fn = autoDetectFilter(tree);
  assert.ok(fn !== null);
  assert.equal(fn.filterName, 'tree');
  const out = safeApply(fn, tree);
  assert.ok(!out.includes('directories, 5 files'));
});

test('safeApply catches filter errors and returns original', () => {
  const badFilter = () => { throw new Error('boom'); };
  badFilter.filterName = 'bad';
  const result = safeApply(badFilter, 'original text');
  assert.equal(result, 'original text');
});

test('safeApply returns original if filter output is empty', () => {
  const emptyFilter = () => '';
  emptyFilter.filterName = 'empty';
  const result = safeApply(emptyFilter, 'original text');
  assert.equal(result, 'original text');
});
