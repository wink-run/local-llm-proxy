'use strict';
// Debug 输入框 @tbp 自动补全的纯逻辑：检测触发 token + 过滤建议
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

// src/lib 是 ESM（.mjs），CJS 测试用动态 import 加载
let detectTbpQuery, filterPromptSuggestions;
before(async () => {
  ({ detectTbpQuery, filterPromptSuggestions } = await import('../../src/lib/tbp-autocomplete.mjs'));
});

test('detectTbpQuery: 光标处正在输入 @tbp: → active，query 为已输入部分', () => {
  const text = '看下 @tbp:代';
  const r = detectTbpQuery(text, text.length);
  assert.equal(r.active, true);
  assert.equal(r.query, '代');
  assert.equal(r.start, text.indexOf('@tbp:'));
});

test('detectTbpQuery: 刚输入 @tbp 或 @tbp: 无内容 → active，query 空（展示全部）', () => {
  assert.deepEqual(pick(detectTbpQuery('@tbp', 4)), { active: true, query: '' });
  assert.deepEqual(pick(detectTbpQuery('@tbp:', 5)), { active: true, query: '' });
});

test('detectTbpQuery: token 后有空格（已结束）→ inactive', () => {
  const text = '@tbp:代码审查 ';
  assert.equal(detectTbpQuery(text, text.length).active, false);
});

test('detectTbpQuery: @tbpx 非触发词 → inactive', () => {
  assert.equal(detectTbpQuery('@tbpx', 5).active, false);
});

test('detectTbpQuery: 只看光标左侧', () => {
  const text = '@tbp:代码 后面还有字';
  // 光标停在 "@tbp:代码" 之后（index 8）应 active，query=代码
  const caret = '@tbp:代码'.length;
  const r = detectTbpQuery(text, caret);
  assert.equal(r.active, true);
  assert.equal(r.query, '代码');
});

test('filterPromptSuggestions: 按 name/display_name 大小写不敏感过滤', () => {
  const prompts = [
    { id: '1', name: '代码审查', display_name: '代码审查' },
    { id: '2', name: 'refactor', display_name: '重构助手' },
    { id: '3', name: 'commit-msg', display_name: '提交信息' },
  ];
  assert.deepEqual(filterPromptSuggestions(prompts, '代码').map(p => p.id), ['1']);
  assert.deepEqual(filterPromptSuggestions(prompts, 'REF').map(p => p.id), ['2']);
  assert.deepEqual(filterPromptSuggestions(prompts, '').map(p => p.id), ['1', '2', '3']);
});

test('filterPromptSuggestions: 限制数量', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `p${i}` }));
  assert.equal(filterPromptSuggestions(many, '', 8).length, 8);
});

function pick(r) { return { active: r.active, query: r.query }; }
