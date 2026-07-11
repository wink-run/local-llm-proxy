'use strict';
// #3 回归：权威目录升级后，复制型（copy）投射应被重刷，而不是永久陈旧。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const resourceManager = require('../resource-manager');

test('_resyncCopyProjections 把权威目录的最新内容重刷到 copy 投射', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-resync-'));
  const authorityDir = path.join(tmp, 'authority', 'demo');
  fs.mkdirSync(authorityDir, { recursive: true });
  fs.writeFileSync(path.join(authorityDir, 'SKILL.md'), '# v2-new\n', 'utf8');
  fs.writeFileSync(path.join(authorityDir, 'extra.txt'), 'new-file\n', 'utf8');

  // 一个陈旧的 copy 投射目标（旧内容、缺 extra.txt）
  const copyTarget = path.join(tmp, 'agent', 'skills', 'demo');
  fs.mkdirSync(copyTarget, { recursive: true });
  fs.writeFileSync(path.join(copyTarget, 'SKILL.md'), '# v1-old\n', 'utf8');

  const resource = {
    type: 'skill',
    name: 'demo',
    metadata: { authorityPath: authorityDir },
    projections: [
      { agentId: 'x', projectionType: 'copy', targetPath: copyTarget },
      { agentId: 'y', projectionType: 'symlink', targetPath: path.join(tmp, 'other') }, // 应被忽略
    ],
  };

  try {
    const { resynced } = resourceManager._resyncCopyProjections(resource);
    assert.equal(resynced, 1, '仅重刷 copy 型');
    assert.equal(fs.readFileSync(path.join(copyTarget, 'SKILL.md'), 'utf8'), '# v2-new\n');
    assert.ok(fs.existsSync(path.join(copyTarget, 'extra.txt')), '新增文件应被带过去');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
