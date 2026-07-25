'use strict';
// 按 client 过滤的智能体(武将)可见性:投射给谁,谁才能列出/取回
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');

function withFakeDb(handlers, fn) {
  const origGetDb = resourceManager._getDb;
  const origInit = resourceManager.init;
  resourceManager.init = () => {};
  resourceManager._getDb = () => ({
    prepare: (sql) => ({
      all: (...args) => handlers.all(sql, args),
      get: (...args) => handlers.get(sql, args),
      run: (...args) => (handlers.run ? handlers.run(sql, args) : { changes: 1 }),
    }),
  });
  try { return fn(); } finally {
    resourceManager._getDb = origGetDb;
    resourceManager.init = origInit;
  }
}

test('listAssistantsForClient: 只列投射给该 client 的 assistant', () => {
  const rows = [{ id: 'res-a', name: 'writer', display_name: '写作助手', description: '' }];
  const r = withFakeDb({
    all: (sql, args) => {
      assert.ok(sql.includes('resource_projections'), 'clientId 非空应联表投射');
      assert.ok(sql.includes("type = 'assistant'") || sql.includes('type = ?') || sql.includes("r.type = 'assistant'"));
      assert.deepEqual(args, ['cursor']);
      return rows;
    },
    get: () => null,
  }, () => resourceManager.listAssistantsForClient('cursor'));
  assert.deepEqual(r, rows);
});

test('listAssistantsForClient: clientId 为空 → 返回全部 assistant', () => {
  const r = withFakeDb({
    all: (sql) => {
      assert.ok(!sql.includes('resource_projections'), '空 clientId 不应联投射表');
      return [{ id: 'res-a', name: 'writer', display_name: '写作助手', description: '' }];
    },
    get: () => null,
  }, () => resourceManager.listAssistantsForClient(''));
  assert.equal(r.length, 1);
});

test('hasAssistantProjections: 有行 → true,无行 → false', () => {
  const yes = withFakeDb({ all: () => [], get: () => ({ 1: 1 }) },
    () => resourceManager.hasAssistantProjections('claude-code'));
  assert.equal(yes, true);
  const no = withFakeDb({ all: () => [], get: () => undefined },
    () => resourceManager.hasAssistantProjections('claude-code'));
  assert.equal(no, false);
});

test('resolveAssistantForClient: 已投射 → 返回出战正文;未投射 → found:false', () => {
  const resource = {
    id: 'res-a',
    type: 'assistant',
    name: 'writer',
    content: JSON.stringify({ soul: '你是写作助手', skills: [], prompts: [] }),
  };
  const origFind = resourceManager._findByTypeName;
  const origGet = resourceManager.getResource;
  resourceManager._findByTypeName = (type, name) =>
    (type === 'assistant' && name === 'writer' ? resource : null);
  resourceManager.getResource = () => resource;
  try {
    const hit = withFakeDb({
      all: () => [],
      get: (sql) => {
        if (sql.includes('resource_projections')) return { 1: 1 };
        return null;
      },
    }, () => resourceManager.resolveAssistantForClient('writer', 'cursor'));
    assert.equal(hit.found, true);
    assert.ok(String(hit.text || '').includes('你是写作助手'));

    const miss = withFakeDb({
      all: () => [],
      get: () => undefined,
    }, () => resourceManager.resolveAssistantForClient('writer', 'codex'));
    assert.deepEqual(miss, { found: false });
  } finally {
    resourceManager._findByTypeName = origFind;
    resourceManager.getResource = origGet;
  }
});

test('resolveAssistantForClient: clientId 为空 → 不校验投射', () => {
  const resource = {
    id: 'res-a',
    type: 'assistant',
    name: 'writer',
    content: JSON.stringify({ soul: 'SOUL', skills: [], prompts: [] }),
  };
  const origFind = resourceManager._findByTypeName;
  resourceManager._findByTypeName = () => resource;
  try {
    const r = withFakeDb({
      all: () => { throw new Error('不应查库'); },
      get: () => { throw new Error('不应查库'); },
    }, () => resourceManager.resolveAssistantForClient('writer', ''));
    assert.equal(r.found, true);
    assert.ok(r.text.includes('SOUL'));
  } finally {
    resourceManager._findByTypeName = origFind;
  }
});
