'use strict';
// 闲置 Skill 判定：超过 N 天无活动则进入清理候选
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSkillKey,
  listIdleSkills,
  DEFAULT_IDLE_DAYS,
} = require('../resource-skill-cleanup');

test('normalizeSkillKey 去掉前缀', () => {
  assert.equal(normalizeSkillKey('superpowers:brainstorming'), 'brainstorming');
  assert.equal(normalizeSkillKey('dbs/action'), 'action');
  assert.equal(normalizeSkillKey('Hello'), 'hello');
});

test('listIdleSkills 把未调用 skill 列入候选；纳管/磁盘改动不算使用', () => {
  const now = Date.UTC(2026, 6, 12); // 2026-07-12
  const day = 24 * 60 * 60 * 1000;
  const resources = [
    {
      id: 'old-1',
      type: 'skill',
      name: 'ancient-skill',
      display_name: 'Ancient',
      created_at: now - 40 * day,
      projections: [],
      metadata: {},
    },
    {
      id: 'managed-today',
      type: 'skill',
      name: 'just-managed',
      display_name: 'Just Managed',
      // 今天刚纳管，但从未会话调用 → 仍应进入闲置候选
      created_at: now - 1 * day,
      projections: [],
      metadata: {},
    },
    {
      id: 'prompt-1',
      type: 'prompt',
      name: 'not-a-skill',
      created_at: now - 40 * day,
    },
  ];

  const result = listIdleSkills(resources, { days: DEFAULT_IDLE_DAYS, now });
  assert.equal(result.days, DEFAULT_IDLE_DAYS);
  assert.equal(result.totalManaged, 2);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(i => i.id).sort(), ['managed-today', 'old-1']);
  assert.equal(result.items.find(i => i.id === 'old-1').lastActivitySource, 'never');
});

test('listIdleSkills 近期 SKILL.md mtime 仍可算闲置（磁盘≠使用）', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-skill-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: fresh-fs\n---\n');
  const resources = [{
    id: 'fs-1',
    type: 'skill',
    name: 'fresh-fs',
    created_at: now - 40 * day,
    projections: [],
    metadata: { authorityPath: dir },
  }];
  try {
    const result = listIdleSkills(resources, { days: 14, now });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, 'fs-1');
    assert.ok(result.items[0].fileActivityAt > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
