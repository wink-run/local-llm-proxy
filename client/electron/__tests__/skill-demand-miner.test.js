'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDigest,
  collectWorkSignals,
  resolveTraceEntities,
  isManagedApp,
  isUsefulUserUtterance,
  extractDialogueFromTrace,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_DIALOGUES,
} = require('../skill-demand-miner');

function mockSessionBrowser(byAgent) {
  return {
    listActivityForEntity(ent) {
      return (byAgent[ent.id] || []).map((r) => ({
        session_id: r.session_id,
        lastTs: r.lastTs || 0,
        project: r.project || '',
        context: r.context || '',
      }));
    },
    getTraceForEntity(ent, sessionId) {
      const row = (byAgent[ent.id] || []).find((r) => r.session_id === sessionId);
      return row?.trace || { error: 'not_found', steps: [] };
    },
  };
}

test('只分析最近 maxSessions 个会话,并抽出对话目标', () => {
  const mk = (id, ts, goal) => ({
    session_id: id,
    lastTs: ts,
    project: 'proxy',
    trace: {
      project: 'proxy',
      steps: [
        { kind: 'user', text: goal },
        { kind: 'tool', tool: 'Bash', input: { command: 'git status' } },
      ],
    },
  });
  const byAgent = {
    'claude-code': [
      mk('s1', 100, '帮我改登录页'),
      mk('s2', 200, '优化 SQL 查询'),
      mk('s3', 300, '写一份周报模板'),
      mk('s4', 400, '修一下支付回调'),
      mk('s5', 500, '搭建一人公司看板'),
    ],
  };
  const sig = collectWorkSignals({
    entities: [{ id: 'claude-code' }],
    sessionBrowser: mockSessionBrowser(byAgent),
    maxSessions: 3,
  });
  assert.equal(sig.sessions, 3);
  assert.equal(sig.dialogues.length, 3);
  assert.equal(sig.dialogues[0].goal, '搭建一人公司看板'); // lastTs 最大优先
  assert.ok(sig.dialogues.every((d) => d.project === 'proxy'));
});

test('默认上限', () => {
  assert.equal(DEFAULT_MAX_SESSIONS, 80);
  assert.equal(DEFAULT_MAX_DIALOGUES, 40);
});

test('跨多个纳管智能体聚合用户对话', () => {
  const byAgent = {
    'claude-code': [{
      session_id: 'c1', lastTs: 10, project: 'proxy',
      trace: {
        project: 'proxy',
        steps: [
          { kind: 'user', text: '帮我实现个性化推荐功能' },
          { kind: 'user', text: '画像要基于对话而不是文件类型' },
        ],
      },
    }],
    cursor: [{
      session_id: 'u1', lastTs: 20, project: 'shop',
      trace: {
        project: 'shop',
        steps: [{ kind: 'user', text: '给电商后台加库存预警' }],
      },
    }],
  };
  const sig = collectWorkSignals({
    entities: [{ id: 'claude-code' }, { id: 'cursor' }],
    sessionBrowser: mockSessionBrowser(byAgent),
  });
  assert.equal(sig.sessions, 2);
  assert.equal(sig.dialogues.length, 2);
  assert.equal(sig.dialogues[0].goal, '给电商后台加库存预警');
  assert.equal(sig.dialogues[1].goal, '帮我实现个性化推荐功能');
  assert.deepEqual(sig.dialogues[1].notes, ['画像要基于对话而不是文件类型']);
  assert.equal(sig.projects.proxy, 1);
  assert.equal(sig.projects.shop, 1);
});

test('buildDigest 以 dialogues 为核心', () => {
  const signals = {
    sessions: 12,
    dialogues: [
      { agent: 'claude-code', project: 'proxy', goal: '做个性化推荐', notes: ['用对话画像'] },
    ],
    projects: { proxy: 8, shop: 2 },
    agents: ['claude-code'],
  };
  const d = buildDigest(signals, { topProjects: 1 });
  assert.equal(d.sessions, 12);
  assert.equal(d.dialogues.length, 1);
  assert.equal(d.dialogues[0].goal, '做个性化推荐');
  assert.deepEqual(d.projects.map((x) => x.name), ['proxy']);
  assert.deepEqual(d.agents, ['claude-code']);
});

test('buildDigest 空信号安全', () => {
  const d = buildDigest({ sessions: 0, dialogues: [], projects: {} });
  assert.equal(d.sessions, 0);
  assert.deepEqual(d.dialogues, []);
  assert.deepEqual(d.projects, []);
  assert.deepEqual(d.agents, []);
});

test('isUsefulUserUtterance 过滤注入与寒暄', () => {
  assert.equal(isUsefulUserUtterance('帮我写一个周报生成器'), true);
  assert.equal(isUsefulUserUtterance('好的'), false);
  assert.equal(isUsefulUserUtterance('<system-reminder>do x</system-reminder>'), false);
  assert.equal(isUsefulUserUtterance('Caveat: The messages below'), false);
});

test('排除个性化推荐自身注入的分析/发现提示词,避免污染画像', () => {
  const { isMetaPromptUtterance, isUsefulUserUtterance } = require('../skill-demand-miner');
  const analyzePrompt = [
    '以下是我与纳管智能体近 80 个会话的对话摘录。',
    '对话只是证据:用来认出「我是谁」。过去做过的具体题/具体功能 ≠ 未来该配什么资源。',
    '## 核心原则(必守)',
    '- 画像看稳定身份,不看最近琐事。',
  ].join('\n');
  const discoverPrompt = [
    '我大概是:一名开发者。我下一步值得投入的方向(请围绕这些方向发现资源,不要退回具体历史任务):',
    '1. 打磨个性化推荐',
    '只输出唯一一个 ```json 代码块',
  ].join('\n');
  assert.equal(isMetaPromptUtterance(analyzePrompt), true);
  assert.equal(isUsefulUserUtterance(analyzePrompt), false);
  assert.equal(isMetaPromptUtterance(discoverPrompt), true);
  assert.equal(isUsefulUserUtterance(discoverPrompt), false);
  // 真人用户谈「个性化推荐」需求本身仍应保留
  assert.equal(isUsefulUserUtterance('资产管理 skill，prompt，agent 个性化推荐要用纳管智能体的 trace 会话'), true);
});

test('extractDialogueFromTrace 取首条为目标、后续为 notes', () => {
  const dlg = extractDialogueFromTrace({
    project: 'p',
    steps: [
      { kind: 'user', text: '实现登录' },
      { kind: 'assistant', text: '好的' },
      { kind: 'user', text: '还要支持 OAuth' },
      { kind: 'user', text: '好的' }, // 寒暄丢弃
    ],
  }, {});
  assert.equal(dlg.goal, '实现登录');
  assert.deepEqual(dlg.notes, ['还要支持 OAuth']);
  assert.equal(dlg.project, 'p');
});

test('isManagedApp：shim 默认纳管；其余须 hosted===true', () => {
  assert.equal(isManagedApp({ link_method: 'shim', hosted: undefined }), true);
  assert.equal(isManagedApp({ link_method: 'shim', hosted: false }), false);
  assert.equal(isManagedApp({ link_method: 'api-key', hosted: true }), true);
  assert.equal(isManagedApp({ link_method: 'session', hosted: true }), true);
  assert.equal(isManagedApp({ draft: true, hosted: true }), false);
});

test('resolveTraceEntities 只保留已纳管且 session_trace 的智能体', () => {
  const fakeLoader = {
    appCapabilities(id) {
      return { 'claude-code': { session_trace: true }, cursor: { session_trace: true }, other: {} }[id] || {};
    },
    appEntityById(id) {
      return { id, session_trace: id !== 'other' };
    },
  };
  const ents = resolveTraceEntities({
    configLoader: fakeLoader,
    apps: [
      { agent_id: 'claude-code', link_method: 'shim', hosted: true },
      { agent_id: 'cursor', link_method: 'direct', hosted: true },
      { agent_id: 'other', link_method: 'api-key', hosted: true },
    ],
  });
  assert.deepEqual(ents.map((e) => e.id).sort(), ['claude-code', 'cursor']);
});
