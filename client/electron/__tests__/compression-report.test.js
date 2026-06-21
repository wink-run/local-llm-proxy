'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { summarizeCompressionLog, parseJsonl } = require('../compression-report');

test('summarizeCompressionLog totals, ratio, and per-model breakdown', () => {
  const s = summarizeCompressionLog([
    { model: 'a', before: 100, after: 70 },
    { model: 'a', before: 200, after: 150 },
    { model: 'b', before: 100, after: 90 },
  ]);
  assert.equal(s.count, 3);
  assert.equal(s.before, 400);
  assert.equal(s.after, 310);
  assert.equal(s.saved, 90);
  assert.ok(Math.abs(s.ratio - 0.225) < 1e-9);
  assert.equal(s.models[0].model, 'a'); // sorted by saved desc
  assert.equal(s.models[0].saved, 80);
});

test('summarizeCompressionLog tolerates empty / malformed records', () => {
  const s = summarizeCompressionLog([null, {}, { model: 'x', before: 'oops', after: 1 }]);
  assert.equal(s.count, 0);
  assert.equal(s.ratio, 0);
});

test('parseJsonl skips blank and broken lines', () => {
  const recs = parseJsonl('{"before":10,"after":5}\n\nnot json\n{"before":4,"after":2}\n');
  assert.equal(recs.length, 2);
  assert.equal(recs[1].before, 4);
});
