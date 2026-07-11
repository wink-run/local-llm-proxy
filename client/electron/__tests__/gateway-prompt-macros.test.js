'use strict';
// expandPromptMacros：网关转发前，在最新 user 消息里把 @tbp:<ref> [参数] 展开为提示词正文
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expandPromptMacros } = require('../local-gateway');

// 假 resolve：只认「代码审查」，正文含 $ARGUMENTS
function fakeResolve(ref, args) {
  if (ref === '代码审查' || ref === '#res-cr') {
    return { found: true, text: args ? `审查：${args}` : '审查代码' };
  }
  return { found: false };
}

test('展开最新 user 消息中的 @tbp: token（字符串 content）', () => {
  const msgs = [
    { role: 'user', content: '看下 @tbp:代码审查 auth.js' },
  ];
  expandPromptMacros(msgs, fakeResolve);
  assert.equal(msgs[0].content, '看下 审查：auth.js');
});

test('无参数时按无 $ARGUMENTS 分支展开', () => {
  const msgs = [{ role: 'user', content: '@tbp:代码审查' }];
  expandPromptMacros(msgs, fakeResolve);
  assert.equal(msgs[0].content, '审查代码');
});

test('#id 形式可解析', () => {
  const msgs = [{ role: 'user', content: '@tbp:#res-cr auth.js' }];
  expandPromptMacros(msgs, fakeResolve);
  assert.equal(msgs[0].content, '审查：auth.js');
});

test('只展开最新一轮 user，历史 user / assistant 不动', () => {
  const msgs = [
    { role: 'user', content: '历史里也有 @tbp:代码审查 old.js' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '现在 @tbp:代码审查 new.js' },
  ];
  expandPromptMacros(msgs, fakeResolve);
  assert.equal(msgs[0].content, '历史里也有 @tbp:代码审查 old.js', '历史 user 不动');
  assert.equal(msgs[2].content, '现在 审查：new.js', '最新 user 展开');
});

test('数组 content：仅处理 text 块，非文本块保留', () => {
  const msgs = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '@tbp:代码审查 a.js' },
        { type: 'image_url', image_url: { url: 'x' } },
      ],
    },
  ];
  expandPromptMacros(msgs, fakeResolve);
  assert.equal(msgs[0].content[0].text, '审查：a.js');
  assert.deepEqual(msgs[0].content[1], { type: 'image_url', image_url: { url: 'x' } });
});

test('未找到的 token 原样保留，不报错', () => {
  const msgs = [{ role: 'user', content: '用 @tbp:不存在 x 和 @tbp:代码审查 y' }];
  expandPromptMacros(msgs, fakeResolve);
  assert.ok(msgs[0].content.includes('@tbp:不存在 x'), '未命中原样保留');
  assert.ok(msgs[0].content.includes('审查：y'), '命中的仍展开');
});

test('无 user 消息 / 非数组：安全返回', () => {
  assert.doesNotThrow(() => expandPromptMacros([{ role: 'assistant', content: 'hi' }], fakeResolve));
  assert.doesNotThrow(() => expandPromptMacros(null, fakeResolve));
});
