'use strict';
// 按 client 过滤的 prompt 可见性:投射给谁,谁才能列出/取回
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');

/** 用假 DB 桩掉 _getDb:按 SQL 关键字分发到预置结果 */
function withFakeDb(handlers, fn) {
  const origGetDb = resourceManager._getDb;
  const origInit = resourceManager.init;
  resourceManager.init = () => {};
  resourceManager._getDb = () => ({
    prepare: (sql) => ({
      all: (...args) => handlers.all(sql, args),
      get: (...args) => handlers.get(sql, args),
    }),
  });
  try { return fn(); } finally {
    resourceManager._getDb = origGetDb;
    resourceManager.init = origInit;
  }
}

test('listPromptsForClient: 只列投射给该 client 的 prompt', () => {
  const rows = [{ id: 'res-p-a', name: 'a', display_name: 'A', description: '' }];
  const r = withFakeDb({
    all: (sql, args) => {
      assert.ok(sql.includes('resource_projections'), 'clientId 非空应联表投射');
      assert.deepEqual(args, ['claude-code']);
      return rows;
    },
    get: () => null,
  }, () => resourceManager.listPromptsForClient('claude-code'));
  assert.deepEqual(r, rows);
});

test('listPromptsForClient: clientId 为空 → 返回全部 prompt(不联投射表)', () => {
  const r = withFakeDb({
    all: (sql) => {
      assert.ok(!sql.includes('resource_projections'), '空 clientId 不应联投射表');
      return [{ id: 'res-p-a', name: 'a', display_name: 'A', description: '' }];
    },
    get: () => null,
  }, () => resourceManager.listPromptsForClient(''));
  assert.equal(r.length, 1);
});

test('hasPromptProjections: 有行 → true,无行 → false', () => {
  const yes = withFakeDb({ all: () => [], get: () => ({ 1: 1 }) },
    () => resourceManager.hasPromptProjections('codex'));
  assert.equal(yes, true);
  const no = withFakeDb({ all: () => [], get: () => undefined },
    () => resourceManager.hasPromptProjections('codex'));
  assert.equal(no, false);
});

test('resolvePromptForClient: 已投射 → 返回正文;未投射 → found:false', () => {
  const origResolve = resourceManager.resolvePrompt;
  resourceManager.resolvePrompt = (ref, args) => ({ found: true, id: 'res-p-a', name: ref, text: `[${ref}] ${args}` });
  try {
    const hit = withFakeDb({ all: () => [], get: () => ({ 1: 1 }) },
      () => resourceManager.resolvePromptForClient('代码审查', 'auth.js', 'claude-code'));
    assert.equal(hit.found, true);
    assert.equal(hit.text, '[代码审查] auth.js');

    const miss = withFakeDb({ all: () => [], get: () => undefined },
      () => resourceManager.resolvePromptForClient('代码审查', '', 'codex'));
    assert.deepEqual(miss, { found: false });
  } finally { resourceManager.resolvePrompt = origResolve; }
});

test('resolvePromptForClient: clientId 为空 → 不校验投射,直接透传 resolvePrompt', () => {
  const origResolve = resourceManager.resolvePrompt;
  resourceManager.resolvePrompt = () => ({ found: true, id: 'x', name: 'x', text: 'T' });
  try {
    const r = withFakeDb({
      all: () => { throw new Error('不应查库'); },
      get: () => { throw new Error('不应查库'); },
    }, () => resourceManager.resolvePromptForClient('x', '', ''));
    assert.equal(r.text, 'T');
  } finally { resourceManager.resolvePrompt = origResolve; }
});
