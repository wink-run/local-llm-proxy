'use strict';
// 回归：编辑提示词后，已投射的命令文件应被重刷；用户自建的同名命令不被覆盖。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const resourceManager = require('../resource-manager');
const { AGENT_PROMPT_TARGETS } = require('../resource-agent-targets');
const TB_PROMPT_MARKER = 'tokenbank-managed-prompt';

function registerTmpPromptAgent(promptRoot) {
  AGENT_PROMPT_TARGETS['tmp-prompt-agent'] = {
    id: 'tmp-prompt-agent', label: 'TmpP',
    getPromptRoot: () => promptRoot,
    fileName: name => `${name}.md`,
    invoke: name => `/${name}`,
    withFrontmatter: true,
  };
  return () => { delete AGENT_PROMPT_TARGETS['tmp-prompt-agent']; };
}

function withStubDb(fn) {
  const origGetDb = resourceManager._getDb;
  const runs = [];
  resourceManager._getDb = () => ({ prepare: () => ({ run: (...a) => runs.push(a) }) });
  try { return fn(runs); } finally { resourceManager._getDb = origGetDb; }
}

test('_resyncPromptProjections 把编辑后的正文重刷到 TB 命令文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prompt-resync-'));
  const root = path.join(tmp, 'commands');
  fs.mkdirSync(root, { recursive: true });
  const cleanup = registerTmpPromptAgent(root);
  const file = path.join(root, 'refactor.md');
  fs.writeFileSync(file, `---\n${TB_PROMPT_MARKER}: true\n---\n旧正文\n`, 'utf8');

  try {
    const resource = {
      type: 'prompt', name: 'refactor', description: '重构', content: '新正文',
      projections: [{ id: 'p1', agentId: 'tmp-prompt-agent', scope: 'global', projectionType: 'command', targetPath: file }],
    };
    const { resynced } = withStubDb(() => resourceManager._resyncPromptProjections(resource));
    assert.equal(resynced, 1);
    const txt = fs.readFileSync(file, 'utf8');
    assert.ok(txt.includes('新正文') && !txt.includes('旧正文'), 'TB 命令文件应被重刷为新正文');
  } finally {
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('_resyncPromptProjections 不覆盖被用户替换成自建命令的同名文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prompt-resync2-'));
  const root = path.join(tmp, 'commands');
  fs.mkdirSync(root, { recursive: true });
  const cleanup = registerTmpPromptAgent(root);
  const file = path.join(root, 'refactor.md');
  fs.writeFileSync(file, '# 用户自己接管了这个命令\n', 'utf8'); // 无 TB 标记

  try {
    const resource = {
      type: 'prompt', name: 'refactor', description: '重构', content: '新正文',
      projections: [{ id: 'p1', agentId: 'tmp-prompt-agent', scope: 'global', projectionType: 'command', targetPath: file }],
    };
    const { resynced } = withStubDb(() => resourceManager._resyncPromptProjections(resource));
    assert.equal(resynced, 0, '冲突目标不计入重刷');
    assert.equal(fs.readFileSync(file, 'utf8'), '# 用户自己接管了这个命令\n', '用户自建命令不被覆盖');
  } finally {
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
