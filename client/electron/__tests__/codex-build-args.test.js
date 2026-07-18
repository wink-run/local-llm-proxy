'use strict';

const assert = require('assert');

// 与 agent-executor.js 中 codex.buildArgs 保持一致
function buildCodexArgs(prompt, { workingDir, continueSession, cliSessionId } = {}) {
  const base = ['exec'];
  if (workingDir) base.push('--cd', workingDir);
  // exec 无 --ask-for-approval；OPTIONS 须在 resume 之前
  base.push(
    '--dangerously-bypass-approvals-and-sandbox',
    '--json', '--skip-git-repo-check',
  );
  if (continueSession) {
    base.push('resume');
    if (cliSessionId) base.push(String(cliSessionId));
    else base.push('--last');
  }
  base.push(prompt);
  return base;
}

assert.deepStrictEqual(
  buildCodexArgs('hello', { workingDir: '/tmp/proj' }),
  ['exec', '--cd', '/tmp/proj', '--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check', 'hello'],
);

assert.deepStrictEqual(
  buildCodexArgs('continue task', { workingDir: '/tmp/proj', continueSession: true }),
  ['exec', '--cd', '/tmp/proj', '--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check', 'resume', '--last', 'continue task'],
);

assert.deepStrictEqual(
  buildCodexArgs('fix tests', {
    workingDir: '/tmp/proj',
    continueSession: true,
    cliSessionId: 'thr_abc123',
  }),
  ['exec', '--cd', '/tmp/proj', '--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check', 'resume', 'thr_abc123', 'fix tests'],
);

console.log('codex-build-args.test.js OK');

// 编排模式：resume 必须在全部 exec OPTIONS（含 -p）之后
function injectCodexResumeArgs(extraArgs, { continueSession, cliSessionId } = {}) {
  if (!continueSession) return extraArgs;
  const out = [...extraArgs];
  out.push('resume', cliSessionId || '--last');
  return out;
}

function buildCodexOrchArgs(prompt, { workingDir, profileName, continueSession, cliSessionId } = {}) {
  const extra = ['exec'];
  if (workingDir) extra.push('--cd', workingDir);
  extra.push(
    '--dangerously-bypass-approvals-and-sandbox',
    '--json', '--skip-git-repo-check', '-p', profileName,
  );
  return [...injectCodexResumeArgs(extra, { continueSession, cliSessionId }), prompt];
}

assert.deepStrictEqual(
  buildCodexOrchArgs('hello', { workingDir: '/tmp/proj', profileName: 'tokenbank-orch-task_1' }),
  ['exec', '--cd', '/tmp/proj', '--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check', '-p', 'tokenbank-orch-task_1', 'hello'],
);

assert.deepStrictEqual(
  buildCodexOrchArgs('continue', {
    workingDir: '/tmp/proj',
    profileName: 'tokenbank-orch-task_1',
    continueSession: true,
    cliSessionId: 'thr_abc',
  }),
  ['exec', '--cd', '/tmp/proj', '--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check', '-p', 'tokenbank-orch-task_1', 'resume', 'thr_abc', 'continue'],
);

console.log('codex-orchestrator-args-order.test OK');
