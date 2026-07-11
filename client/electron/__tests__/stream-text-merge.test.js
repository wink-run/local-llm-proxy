'use strict';

const assert = require('assert');

(async () => {
  const { mergeStreamText, foldStreamSteps } = await import('../../shared/stream-text-merge.js');

  assert.strictEqual(
    foldStreamSteps([
      { content: 'Hi', is_delta: true },
      { content: '! What are you working on?', is_delta: true },
      { content: 'Hi! What are you working on?', is_snapshot: true },
    ]),
    'Hi! What are you working on?',
  );

  assert.strictEqual(
    mergeStreamText('Hi', '! What are you working on?'),
    'Hi! What are you working on?',
  );

  assert.strictEqual(
    mergeStreamText('Hi! What are you working on?', 'Hi! What are you working on?', { isSnapshot: true }),
    'Hi! What are you working on?',
  );

  const mixedDelta = 'The user is just saying hi. I should respond concisely without any fluff, as per their CLAUDE.md instructionsHi';
  const mixedSnap = 'The user is just saying hi. I should respond concisely without any fluff, as per their CLAUDE.md instructions.Hi. What are you working on?';
  assert.strictEqual(
    mergeStreamText(mixedDelta, mixedSnap, { isSnapshot: true }),
    mixedSnap,
    'snapshot should replace delta, not append',
  );

  console.log('stream-text-merge.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
