'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  estimateTokens, minifyJsonString, compressMessages, compressBody, compressionRatio,
} = require('../compressor');

test('compressionRatio = saved/before, clamped, 0 when before<=0', () => {
  assert.equal(compressionRatio(100, 70), 0.3);
  assert.equal(compressionRatio(0, 0), 0);
  assert.equal(compressionRatio(50, 80), 0); // after>before → clamped to 0
  assert.equal(compressionRatio(100, 0), 1);
});

const PRETTY = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: 'e' } }, null, 2);
const COMPACT = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: 'e' } });

test('minifyJsonString compacts pretty JSON losslessly', () => {
  const out = minifyJsonString(PRETTY);
  assert.equal(out, COMPACT);
  assert.deepEqual(JSON.parse(out), JSON.parse(PRETTY)); // same data
  assert.ok(out.length < PRETTY.length);
});

test('minifyJsonString leaves non-JSON untouched', () => {
  const prose = 'Please review this code:\n\n  if (x) {\n    do();\n  }';
  assert.equal(minifyJsonString(prose), prose);
  assert.equal(minifyJsonString('just a sentence'), 'just a sentence');
  assert.equal(minifyJsonString('42'), '42');
});

test('minifyJsonString leaves invalid JSON untouched', () => {
  const bad = '{ not: valid json, ';
  assert.equal(minifyJsonString(bad), bad);
});

test('compressMessages shrinks JSON tool content, reports token delta', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: PRETTY },
  ];
  const { messages, before, after } = compressMessages(msgs);
  assert.equal(messages[1].content, COMPACT);
  assert.equal(messages[0], msgs[0]); // untouched message kept by reference
  assert.ok(after < before, `after ${after} should be < before ${before}`);
});

test('compressMessages handles array content blocks', () => {
  const msgs = [{ role: 'tool', content: [{ type: 'text', text: PRETTY }, { type: 'text', text: 'note' }] }];
  const { messages } = compressMessages(msgs);
  assert.equal(messages[0].content[0].text, COMPACT);
  assert.equal(messages[0].content[1].text, 'note');
});

test('compressBody disabled is a no-op', async () => {
  const body = { model: 'gpt-5', messages: [{ role: 'tool', content: PRETTY }] };
  const r = await compressBody(body, { enabled: false });
  assert.equal(r.saved, 0);
  assert.equal(r.body, body); // same reference, untouched
});

test('compressBody enabled saves tokens on JSON-heavy payloads', async () => {
  const body = { model: 'gpt-5', messages: [{ role: 'tool', content: PRETTY }] };
  const r = await compressBody(body, { enabled: true });
  assert.ok(r.saved > 0);
  assert.equal(r.body.messages[0].content, COMPACT);
  assert.notEqual(r.body, body); // new object, original not mutated
  assert.equal(body.messages[0].content, PRETTY);
});

test('compressBody enabled but nothing to save returns saved:0', async () => {
  const body = { model: 'gpt-5', messages: [{ role: 'user', content: 'just prose, no json' }] };
  const r = await compressBody(body, { enabled: true });
  assert.equal(r.saved, 0);
  assert.equal(r.body, body); // unchanged → same reference
});

test('estimateTokens is ~chars/4', () => {
  assert.equal(estimateTokens('x'.repeat(40)), 10);
  assert.equal(estimateTokens(''), 0);
});
