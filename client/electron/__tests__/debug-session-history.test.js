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

test('同线程多轮应更新同一条，而非每轮新增', () => {
  global.localStorage = mockLocalStorage();
  H.saveAgentSessionSnapshot('__hub__', {
    conversationTurns: [{ user: '任务A', taskId: 'a1' }],
  });
  H.saveAgentSessionSnapshot('__hub__', {
    conversationTurns: [
      { user: '任务A', taskId: 'a1' },
      { user: '任务B', taskId: 'b1' },
    ],
  });
  H.saveAgentSessionSnapshot('__hub__', {
    conversationTurns: [
      { user: '任务A', taskId: 'a1' },
      { user: '任务B', taskId: 'b1' },
      { user: '任务C', taskId: 'c1' },
    ],
    cliSessionId: 'cli-xyz',
  });
  const list = H.listAgentSessionSnapshots('__hub__');
  assert.equal(list.length, 1);
  assert.equal(list[0].turnCount, 3);
  assert.equal(list[0].sessionKey, 'cli:cli-xyz');
});

test('不同首轮 taskId 仍是独立会话', () => {
  global.localStorage = mockLocalStorage();
  H.saveAgentSessionSnapshot('codex', {
    conversationTurns: [{ user: '一', taskId: 't1' }],
  });
  H.saveAgentSessionSnapshot('codex', {
    conversationTurns: [{ user: '二', taskId: 't2' }],
  });
  assert.equal(H.listAgentSessionSnapshots('codex').length, 2);
});

test('list 时合并旧版每轮重复残留', () => {
  global.localStorage = mockLocalStorage();
  // 模拟旧数据：无指纹、无 sessionKey，同线程多条
  const raw = {
    version: 1,
    items: [
      {
        id: 'h1', agentKey: 'claude', title: '安装 skill', fingerprint: 'a1',
        savedAt: 1, turnCount: 1,
        conversationTurns: [{ user: '安装 skill', taskId: 'a1' }],
      },
      {
        id: 'h2', agentKey: 'claude', title: '安装 skill', fingerprint: 'a1|b1',
        savedAt: 2, turnCount: 2,
        conversationTurns: [
          { user: '安装 skill', taskId: 'a1' },
          { user: '继续', taskId: 'b1' },
        ],
      },
      {
        id: 'h3', agentKey: 'claude', title: '安装 skill', fingerprint: 'a1|b1|c1',
        savedAt: 3, turnCount: 3,
        conversationTurns: [
          { user: '安装 skill', taskId: 'a1' },
          { user: '继续', taskId: 'b1' },
          { user: '再问', taskId: 'c1' },
        ],
      },
    ],
  };
  localStorage.setItem('tokenbank.debug.agentSessions', JSON.stringify(raw));
  const list = H.listAgentSessionSnapshots('claude');
  assert.equal(list.length, 1);
  assert.equal(list[0].turnCount, 3);
  assert.equal(list[0].id, 'h3');
});
