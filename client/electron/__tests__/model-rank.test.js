'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isRankableModelName, filterRankableModels } = require('../../shared/model-rank');

test('isRankableModelName rejects tool names and combos', () => {
  assert.equal(isRankableModelName('Grep'), false);
  assert.equal(isRankableModelName('Read'), false);
  assert.equal(isRankableModelName('Read · Grep'), false);
  assert.equal(isRankableModelName('已为 Cursor 用量明细增加…'), false);
});

test('isRankableModelName accepts real model ids', () => {
  assert.equal(isRankableModelName('gpt-5.4-mini'), true);
  assert.equal(isRankableModelName('gemini-2.0-flash'), true);
  assert.equal(isRankableModelName('minimax-m2.5'), true);
  assert.equal(isRankableModelName('cursor-agent'), true);
});

test('isRankableModelName rejects claude mask models', () => {
  const masked = new Set(['claude-opus-4-8', 'claude-sonnet-4-6']);
  assert.equal(isRankableModelName('claude-opus-4-8', { maskedModels: masked }), false);
  assert.equal(isRankableModelName('gpt-5.4-mini', { maskedModels: masked }), true);
});

test('filterRankableModels', () => {
  const masked = new Set(['claude-opus-4-8']);
  const out = filterRankableModels([
    { model: 'Grep', calls: 1 },
    { model: 'claude-opus-4-8', calls: 3 },
    { model: 'gpt-5', calls: 2 },
  ], { maskedModels: masked });
  assert.equal(out.length, 1);
  assert.equal(out[0].model, 'gpt-5');
});
