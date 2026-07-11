'use strict';

const assert = require('assert');

// 与 agent-executor.js 中 codex.buildArgs 保持一致
function buildCodexArgs(prompt, { workingDir, continueSession, cliSessionId } = {}) {
  const base = ['exec'];
  if (workingDir) base.push('--cd', workingDir);
  if (continueSession) {
    base.push('resume');
    if (cliSessionId) base.push(String(cliSessionId));
    else base.push('--last');
  }
  base.push('--json', '--skip-git-repo-check');
  base.push(prompt);
  return base;
}

assert.deepStrictEqual(
  buildCodexArgs('hello', { workingDir: '/tmp/proj' }),
  ['exec', '--cd', '/tmp/proj', '--json', '--skip-git-repo-check', 'hello'],
);

assert.deepStrictEqual(
  buildCodexArgs('continue task', { workingDir: '/tmp/proj', continueSession: true }),
  ['exec', '--cd', '/tmp/proj', 'resume', '--last', '--json', '--skip-git-repo-check', 'continue task'],
);

assert.deepStrictEqual(
  buildCodexArgs('fix tests', {
    workingDir: '/tmp/proj',
    continueSession: true,
    cliSessionId: 'thr_abc123',
  }),
  ['exec', '--cd', '/tmp/proj', 'resume', 'thr_abc123', '--json', '--skip-git-repo-check', 'fix tests'],
);

console.log('codex-build-args.test.js OK');
