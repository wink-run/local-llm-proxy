'use strict';
// 回归：聚合入口派发的子任务，必须在「刚开新会话」的子 Agent 标签里显示，
// 不能被 isFreshAgentSession / skipHistoryRecover 守卫吞掉。
const test = require('node:test');
const assert = require('node:assert');

let S;
test.before(async () => {
  S = await import('../../src/lib/debug-agent-store.js');
});

test('运行中的派发：子标签刚开新会话时，切过去仍能镜像出执行过程', async () => {
  const agents = [{ id: 'assistant:res-poem', name: '写诗专家', type: 'assistant', resourceId: 'res-poem' }];
  const child = 'assistant:res-poem';

  // 用户在子 Agent 标签点了「新会话」→ 该标签变为 fresh
  S.clearSessionTaskState(child);
  assert.equal(S.isFreshAgentSession(S.getStoreSession(child)), true, '前置：应为 fresh 会话');

  // hub 当前会话派发一个仍在运行的子任务给该 Agent
  S.beginSessionInstance('__hub__');
  const hubInstance = S.getStoreSession('__hub__').sessionInstanceId;
  S.patchDelegation('__hub__', 'd1', {
    agentId: child,
    prompt: '写首诗',
    steps: [{ stepType: 'output', content: '床前明月光' }],
    status: 'running',
    sessionInstanceId: hubInstance,
  });

  // 切到子 Agent 标签 → 应把派发镜像补显到「新会话」
  const ok = S.syncDelegatedMirrorToAgentTab(child, agents);
  const sess = S.getStoreSession(child);

  assert.equal(ok, true, 'syncDelegatedMirrorToAgentTab 应返回 true（已镜像）');
  assert.equal(sess.executing, true, '新会话应处于执行中');
  assert.ok((sess.taskSteps || []).some(s => /床前明月光/.test(s.content)), '新会话应显示派发步骤');
});

test('已完成的派发：mergeTaskIntoStore 应把完成结果归档进子 Agent 标签（即便刚开新会话）', async () => {
  const child = 'assistant:res-poem2';
  S.clearSessionTaskState(child);

  const completed = {
    id: 'd2',
    agent_id: child,
    prompt: '写首诗',
    status: 'completed',
    context: { parentTaskId: 'phub', sessionKey: '__hub__', sessionInstanceId: 'Hx' },
    steps: [{ step_number: 0, step_type: 'output', content: '《观棋》' }],
    result: { summary: '《观棋》' },
    completed_at: Date.now(),
  };
  S.mergeTaskIntoStore(completed);

  const sess = S.getStoreSession(child);
  assert.ok((sess.conversationTurns || []).some(tn => tn.taskId === 'd2'),
    '完成的派发应归档为该标签的一轮对话');
});
