'use strict';
const test = require('node:test');
const assert = require('node:assert');

// 简易 localStorage mock
function mockLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

let H;
test.before(async () => {
  global.localStorage = mockLocalStorage();
  H = await import('../../src/lib/debug-session-history.js');
});

test('saveAgentSessionSnapshot 写入并可列出', () => {
  const turns = [{ user: '写一首诗', taskId: 't1', steps: [], status: 'completed' }];
  const entry = H.saveAgentSessionSnapshot('assistant:poem', {
    conversationTurns: turns,
    sessionWorkingDir: '/tmp',
  });
  assert.ok(entry?.id);
  const list = H.listAgentSessionSnapshots('assistant:poem');
  assert.equal(list.length, 1);
  assert.match(list[0].title, /写一首诗/);
});

test('相同轮次指纹会更新而非重复', () => {
  H.saveAgentSessionSnapshot('__hub__', {
    conversationTurns: [{ user: '任务A', taskId: 'a1' }],
  });
  H.saveAgentSessionSnapshot('__hub__', {
    conversationTurns: [
      { user: '任务A', taskId: 'a1' },
      { user: '任务B', taskId: 'b1' },
    ],
  });
  const list = H.listAgentSessionSnapshots('__hub__');
  assert.equal(list.length, 2);
});
