'use strict';
// resolvePrompt / applyPromptArguments：提示词引用解析 + $ARGUMENTS 智能填充
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');
const { applyPromptArguments } = require('../resource-manager');

// ── 纯函数：$ARGUMENTS 智能填充 ──────────────────────────────
test('applyPromptArguments: 含 $ARGUMENTS 时用参数替换（全部出现处）', () => {
  assert.equal(
    applyPromptArguments('审查 $ARGUMENTS，重点看 $ARGUMENTS', 'auth.js'),
    '审查 auth.js，重点看 auth.js',
  );
});

test('applyPromptArguments: 不含 $ARGUMENTS 且参数非空 → 正文 + 分隔线 + 参数', () => {
  assert.equal(
    applyPromptArguments('你是资深审查员', 'auth.js'),
    '你是资深审查员\n\n---\n\nauth.js',
  );
});

test('applyPromptArguments: 不含 $ARGUMENTS 且参数为空 → 只返回正文', () => {
  assert.equal(applyPromptArguments('你是资深审查员', ''), '你是资深审查员');
  assert.equal(applyPromptArguments('你是资深审查员', '   '), '你是资深审查员');
});

test('applyPromptArguments: 含 $ARGUMENTS 但参数为空 → 占位符替换为空串', () => {
  assert.equal(applyPromptArguments('审查 $ARGUMENTS 完毕', ''), '审查  完毕');
});

// ── resolvePrompt：按 name / #id / display_name 查找（桩掉 DB 访问）───────────
function withStubLookup(fn, { byDisplayName = null } = {}) {
  const origInit = resourceManager.init;
  const origFind = resourceManager._findByTypeName;
  const origGet = resourceManager.getResource;
  const origDb = resourceManager._getDb;
  resourceManager.init = () => {};
  resourceManager._getDb = () => ({
    prepare: (sql) => ({
      get: (...args) => {
        if (!byDisplayName) return null;
        if (String(sql).includes('display_name') && args[0] === byDisplayName.display_name) {
          return { id: byDisplayName.id };
        }
        return null;
      },
    }),
  });
  try { return fn(); } finally {
    resourceManager.init = origInit;
    resourceManager._findByTypeName = origFind;
    resourceManager.getResource = origGet;
    resourceManager._getDb = origDb;
  }
}

test('resolvePrompt: 按 name 命中并展开 $ARGUMENTS', () => {
  withStubLookup(() => {
    resourceManager._findByTypeName = (type, name) =>
      (type === 'prompt' && name === '代码审查')
        ? { id: 'res-prompt-cr', type: 'prompt', name: '代码审查', content: '审查：$ARGUMENTS' }
        : null;
    const r = resourceManager.resolvePrompt('代码审查', 'auth.js');
    assert.deepEqual(
      { found: r.found, name: r.name, id: r.id, text: r.text },
      { found: true, name: '代码审查', id: 'res-prompt-cr', text: '审查：auth.js' },
    );
  });
});

test('resolvePrompt: name 未命中时按 #id 回退查找', () => {
  withStubLookup(() => {
    resourceManager._findByTypeName = () => null;
    resourceManager.getResource = (id) =>
      id === 'res-prompt-cr'
        ? { id: 'res-prompt-cr', type: 'prompt', name: '代码审查', content: '正文' }
        : null;
    const r = resourceManager.resolvePrompt('#res-prompt-cr', '');
    assert.equal(r.found, true);
    assert.equal(r.text, '正文');
  });
});

test('resolvePrompt: 按 display_name（中文名）命中', () => {
  withStubLookup(() => {
    resourceManager._findByTypeName = () => null;
    resourceManager.getResource = (id) =>
      id === 'res-prompt-xiaohei'
        ? { id: 'res-prompt-xiaohei', type: 'prompt', name: 'xiaohei', content: '黑猫正文' }
        : null;
    const r = resourceManager.resolvePrompt('小黑', '');
    assert.equal(r.found, true);
    assert.equal(r.name, 'xiaohei');
    assert.equal(r.text, '黑猫正文');
  }, { byDisplayName: { id: 'res-prompt-xiaohei', display_name: '小黑' } });
});

test('resolvePrompt: 找不到 → found=false，不抛错', () => {
  withStubLookup(() => {
    resourceManager._findByTypeName = () => null;
    resourceManager.getResource = () => null;
    const r = resourceManager.resolvePrompt('不存在的名字', 'x');
    assert.equal(r.found, false);
  });
});

test('resolvePrompt: 空引用 → found=false', () => {
  withStubLookup(() => {
    assert.equal(resourceManager.resolvePrompt('', 'x').found, false);
    assert.equal(resourceManager.resolvePrompt(null, 'x').found, false);
  });
});
