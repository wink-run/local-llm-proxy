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

const GIT_DIFF_SAMPLE = `diff --git a/src/auth.js b/src/auth.js
index abc..def 100644
--- a/src/auth.js
+++ b/src/auth.js
@@ -1,3 +1,4 @@
 function check() {
+  if (!token) return false;
-  return true;
 }`;

test('compressBody applies RTK to Claude tool_result block', async () => {
  const body = {
    model: 'claude-3-5',
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', content: GIT_DIFF_SAMPLE + '\n'.repeat(400) }],
    }],
  };
  const r = await compressBody(body, { enabled: true });
  const block = r.body.messages[0].content[0];
  const inputLen = (GIT_DIFF_SAMPLE + '\n'.repeat(400)).length;
  assert.ok(r.rtkHits && r.rtkHits.length > 0, 'should have rtk hits');
  assert.ok(block.content.length < inputLen, 'diff should be compressed');
});

test('compressBody applies RTK to OpenAI role:tool message', async () => {
  // Must be long enough (> MIN_COMPRESS_SIZE=500 chars) to trigger RTK
  const longDiff = GIT_DIFF_SAMPLE + '\n+line\n-line'.repeat(30);
  const body = {
    model: 'gpt-4',
    messages: [{ role: 'tool', content: longDiff }],
  };
  const r = await compressBody(body, { enabled: true });
  assert.ok(r.rtkHits && r.rtkHits.length > 0, 'should have rtk hits');
});

test('compressBody does not apply RTK to regular user messages', async () => {
  const body = {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello\n'.repeat(300) }],
  };
  const r = await compressBody(body, { enabled: true });
  assert.equal((r.rtkHits || []).length, 0, 'plain user content should not trigger RTK');
});
