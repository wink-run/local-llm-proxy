'use strict';
// 纳管智能体时级联纳管其声明的 skill / prompt 依赖。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rm = require('../resource-manager');
const rc = require('../resource-catalog');

// python-expert 依赖 skill: systematic-debugging, prompt: code-review（均在内置目录）
const ASSISTANT = 'python-expert-assistant';
const IDS = ['res-assistant-python-expert', 'res-skill-systematic-debugging', 'res-prompt-code-review'];

function cleanup() {
  const localStats = require('../local-stats');
  const { STATS_DIR } = require('../../shared/telemetry');
  const db = localStats.requireDb(STATS_DIR);
  for (const id of IDS) {
    try { db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(id); } catch {}
    try { db.prepare('DELETE FROM resources WHERE id = ?').run(id); } catch {}
  }
  try { fs.rmSync(path.join(os.homedir(), '.agents', 'skills', 'systematic-debugging'), { recursive: true, force: true }); } catch {}
}

test('纳管智能体级联纳管其 skill / prompt 依赖', () => {
  rc.resetCatalogCache();
  cleanup();
  try {
    const res = rm.installFromCatalog(ASSISTANT);
    assert.equal(res.success, true);
    assert.ok(Array.isArray(res.installedDependencies), 'installedDependencies 应返回数组');

    // 依赖已纳管
    const skill = rm.listResources({ type: 'skill' }).find(r => r.name === 'systematic-debugging');
    const prompt = rm.listResources({ type: 'prompt' }).find(r => r.name === 'code-review');
    assert.ok(skill, 'skill 依赖 systematic-debugging 应被纳管');
    assert.ok(prompt, 'prompt 依赖 code-review 应被纳管');

    // skill 依赖也落盘（可在「已纳管」tab 看到）
    assert.ok(fs.existsSync(path.join(os.homedir(), '.agents', 'skills', 'systematic-debugging', 'SKILL.md')),
      'skill 依赖应物化到磁盘');

    // 幂等：再次纳管不重复安装依赖
    const again = rm.installFromCatalog(ASSISTANT);
    assert.equal(again.alreadyInstalled, true);
  } finally {
    cleanup();
  }
});
