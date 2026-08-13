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
  // 以首轮 taskId 为稳定键，不因后来出现 cliSessionId 而改键拆条
  assert.equal(list[0].sessionKey, 'task:a1');
});

test('中断后续跑（首轮是继续）应合并进最近同 Agent 历史', () => {
  global.localStorage = mockLocalStorage();
  H.saveAgentSessionSnapshot('community:video', {
    conversationTurns: [
      { user: '根据文章生成白板动画', taskId: 'orig1', status: 'failed' },
    ],
    sessionWorkingDir: '/tmp/proj',
  });
  H.saveAgentSessionSnapshot('community:video', {
    conversationTurns: [
      { user: '请从上次中断处继续，不要重复已完成的步骤。', taskId: 'c1', status: 'failed' },
      { user: '继续', taskId: 'c2', status: 'completed' },
    ],
    sessionWorkingDir: '/tmp/proj',
  });
  const list = H.listAgentSessionSnapshots('community:video');
  assert.equal(list.length, 1);
  assert.ok(list[0].turnCount >= 3);
  assert.match(list[0].title, /白板动画/);
});

test('CLI session 变化仍归同一历史条', () => {
  global.localStorage = mockLocalStorage();
  H.saveAgentSessionSnapshot('claude-code', {
    conversationTurns: [{ user: '写代码', taskId: 't1' }],
    cliSessionId: 'cli-old',
  });
  H.saveAgentSessionSnapshot('claude-code', {
    conversationTurns: [
      { user: '写代码', taskId: 't1' },
      { user: '继续', taskId: 't2' },
    ],
    cliSessionId: 'cli-new',
  });
  const list = H.listAgentSessionSnapshots('claude-code');
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionKey, 'task:t1');
  assert.equal(list[0].turnCount, 2);
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

test('同 cliSessionId 的跟聊碎片应合并', () => {
  global.localStorage = mockLocalStorage();
  H.saveAgentSessionSnapshot('community:video', {
    conversationTurns: [
      { user: '根据文章生成白板动画', taskId: 'orig1' },
      { user: '加字幕', taskId: 't2' },
    ],
    sessionWorkingDir: '/tmp/vid',
    cliSessionId: 'cli-same',
  });
  // 内存丢失后只剩跟聊一轮，但 CLI session 相同
  H.saveAgentSessionSnapshot('community:video', {
    conversationTurns: [{ user: 'skil中的这支笔里的江哥去掉', taskId: 't3' }],
    sessionWorkingDir: '/tmp/vid',
    cliSessionId: 'cli-same',
  });
  const list = H.listAgentSessionSnapshots('community:video');
  assert.equal(list.length, 1);
  assert.equal(list[0].turnCount, 3);
  assert.match(list[0].title, /白板动画/);
});

test('同工作目录的单轮碎片应并入多轮会话', () => {
  global.localStorage = mockLocalStorage();
  H.saveAgentSessionSnapshot('community:video', {
    conversationTurns: [
      { user: '根据文章生成白板动画', taskId: 'a1' },
      { user: '二', taskId: 'a2' },
      { user: '三', taskId: 'a3' },
    ],
    sessionWorkingDir: '/tmp/proj',
  });
  H.saveAgentSessionSnapshot('community:video', {
    conversationTurns: [{ user: '视频增加字幕及关键要点文字', taskId: 'b1' }],
    sessionWorkingDir: '/tmp/proj',
  });
  const list = H.listAgentSessionSnapshots('community:video');
  assert.equal(list.length, 1);
  assert.ok(list[0].turnCount >= 4);
  assert.match(list[0].title, /白板动画/);
});

test('findAgentSessionForContinue 按目录命中', () => {
  global.localStorage = mockLocalStorage();
  H.saveAgentSessionSnapshot('claude-code', {
    conversationTurns: [{ user: '写代码', taskId: 'x1' }],
    sessionWorkingDir: '/tmp/code',
    cliSessionId: 'cli-x',
  });
  const hit = H.findAgentSessionForContinue('claude-code', { workingDir: '/tmp/code/' });
  assert.ok(hit);
  assert.equal(hit.cliSessionId, 'cli-x');
});

test('list 时治愈同目录短时拆开的单轮碎片', () => {
  global.localStorage = mockLocalStorage();
  const now = Date.now();
  const raw = {
    version: 1,
    items: [
      {
        id: 'h1', agentKey: 'community:video', title: 'skil中的这支笔里的江哥去掉',
        savedAt: now, turnCount: 1, sessionWorkingDir: '/tmp/vid',
        conversationTurns: [{ user: 'skil中的这支笔里的江哥去掉', taskId: 'f1', timestamp: now }],
      },
      {
        id: 'h2', agentKey: 'community:video', title: '视频增加字幕',
        savedAt: now - 1000, turnCount: 1, sessionWorkingDir: '/tmp/vid',
        conversationTurns: [{ user: '视频增加字幕', taskId: 'f2', timestamp: now - 1000 }],
      },
      {
        id: 'h3', agentKey: 'community:video', title: '根据文章生成白板动画',
        savedAt: now - 120000, turnCount: 5, sessionWorkingDir: '/tmp/vid',
        sessionKey: 'task:orig1',
        conversationTurns: [
          { user: '根据文章生成白板动画', taskId: 'orig1', timestamp: now - 120000 },
          { user: '二', taskId: 'a2', timestamp: now - 100000 },
          { user: '三', taskId: 'a3', timestamp: now - 80000 },
          { user: '四', taskId: 'a4', timestamp: now - 60000 },
          { user: '五', taskId: 'a5', timestamp: now - 40000 },
        ],
      },
    ],
  };
  localStorage.setItem('tokenbank.debug.agentSessions', JSON.stringify(raw));
  const list = H.listAgentSessionSnapshots('community:video');
  assert.equal(list.length, 1);
  assert.ok(list[0].turnCount >= 7);
  assert.match(list[0].title, /白板动画/);
  // 时间线顺序：原稿 → … → 字幕 → 去江哥
  const users = list[0].conversationTurns.map((t) => t.user);
  assert.equal(users[0], '根据文章生成白板动画');
  assert.equal(users[users.length - 2], '视频增加字幕');
  assert.equal(users[users.length - 1], 'skil中的这支笔里的江哥去掉');
});

test('合并碎片后按 timestamp 纠正乱序', () => {
  global.localStorage = mockLocalStorage();
  H.saveAgentSessionSnapshot('community:video', {
    conversationTurns: [
      { user: '后发', taskId: 't2', timestamp: 2000 },
      { user: '先发', taskId: 't1', timestamp: 1000 },
    ],
    sessionWorkingDir: '/tmp/vid',
    historyThreadId: 'task:t1',
  });
  const list = H.listAgentSessionSnapshots('community:video');
  assert.deepEqual(list[0].conversationTurns.map((t) => t.user), ['先发', '后发']);
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
