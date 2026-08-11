'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseContextWindowSuffix,
  resolveContextWindow,
  resolveMaxContextWindow,
  autoCompactWindow,
  FALLBACK_CONTEXT_WINDOW,
} = require('../model-context-window');

test('后缀解析：[1m]/[200k]/纯数字', () => {
  assert.deepEqual(parseContextWindowSuffix('deepseek-v4-pro[1m]'), {
    slug: 'deepseek-v4-pro', window: 1000000,
  });
  assert.deepEqual(parseContextWindowSuffix('glm-5.2[200k]'), {
    slug: 'glm-5.2', window: 200000,
  });
  assert.deepEqual(parseContextWindowSuffix('m[1048576]'), {
    slug: 'm', window: 1048576,
  });
  assert.equal(parseContextWindowSuffix('plain').window, null);
});

test('按模型名族解析，对齐 cc-switch Codex 预设', () => {
  assert.equal(resolveContextWindow('deepseek-v4-flash'), 1048576);
  assert.equal(resolveContextWindow('glm-5.2'), 200000);
  assert.equal(resolveContextWindow('kimi-k2.5'), 262144);
  assert.equal(resolveContextWindow('kimi-k3'), 1048576);
  assert.equal(resolveContextWindow('gpt-5.6-sol'), 272000);
  assert.equal(resolveContextWindow('claude-sonnet-4-5'), 200000);
  assert.equal(resolveContextWindow('MiniMax-M3'), 1000000);
  assert.equal(resolveContextWindow('MiniMaxAI/MiniMax-M2.7'), 200000);
  assert.equal(resolveContextWindow('mimo-v2.5-pro'), 1048576);
  assert.equal(resolveContextWindow('grok-4.5'), 500000);
  assert.equal(resolveContextWindow('LongCat-2.0'), 1048576);
  assert.equal(resolveContextWindow('qwen3-coder-plus'), 1048576);
  assert.equal(resolveContextWindow('totally-unknown-xyz'), FALLBACK_CONTEXT_WINDOW);
});

test('供给源显式 context_window 优先于启发式', () => {
  const providers = [{ models: [{ name: 'custom-x', context_window: 64000 }] }];
  assert.equal(resolveContextWindow('custom-x', providers), 64000);
  assert.equal(resolveContextWindow({ name: 'a', contextWindow: 32000 }), 32000);
});

test('多模型取最大窗口；autoCompact=80%', () => {
  assert.equal(resolveMaxContextWindow(['glm-5.2', 'deepseek-v4-pro']), 1048576);
  assert.equal(autoCompactWindow(262144), Math.floor(262144 * 0.8));
});

test('路由类 model_key（llm-router-*）默认 200k，显式字段仍优先', () => {
  const { ROUTE_CONTEXT_WINDOW } = require('../model-context-window');
  assert.equal(ROUTE_CONTEXT_WINDOW, 200000);
  for (const rk of ['llm-router-auto', 'llm-router-cost', 'llm-router-speed', 'llm-router-design', 'LLM-Router-Free']) {
    assert.equal(resolveContextWindow(rk), 200000, rk + ' 应为默认 200k');
  }
  assert.equal(resolveContextWindow({ name: 'llm-router-auto' }), 200000);
  // 显式 context_window 仍优先（用户/源指定）
  assert.equal(resolveContextWindow({ name: 'llm-router-auto', context_window: 400000 }), 400000);
  // 真实模型不受影响：仍按模型族解析
  assert.equal(resolveContextWindow('deepseek-v4-pro'), 1048576);
  assert.equal(resolveContextWindow('glm-5.1'), 200000);
});

test('resolveMinContextWindow：路由取候选模型最小窗口，感知模型而非一律 128k', () => {
  const { resolveMinContextWindow } = require('../model-context-window');
  // design 候选：glm-5.1(200k) + deepseek-v4-pro(1M)*… → 最小 200k
  assert.equal(resolveMinContextWindow(['glm-5.1', 'deepseek-v4-pro', 'minimax-m3', 'mimo-v2.5']), 200000);
  // 全是大窗口 → 取到大值（不再被压成 128k）
  assert.equal(resolveMinContextWindow(['deepseek-v4-pro', 'mimo-v2.5']), 1048576);
  // 含小窗口 → 取小（安全，落到它也不超）：glm-4(裸)=128k、deepseek-v4-pro=1M → 128k
  assert.equal(resolveMinContextWindow(['deepseek-v4-pro', 'glm-4']), 128000);
  // 空 → null（调用方回退保守默认）
  assert.equal(resolveMinContextWindow([]), null);
});

test('场景钉死具体模型时，上下文取这些模型窗口的最小值', () => {
  const {
    concreteModelsFromScene,
    resolveContextWindowForScene,
    ROUTE_CONTEXT_WINDOW,
  } = require('../model-context-window');

  const withModels = {
    model_key: 'llm-router-chain',
    steps: [{ model: 'glm-5.2' }, { model: 'deepseek-v4-flash' }],
  };
  assert.deepEqual(concreteModelsFromScene(withModels), ['glm-5.2', 'deepseek-v4-flash']);
  // glm 200k < deepseek 1M → 取最小 200k
  assert.equal(resolveContextWindowForScene(withModels), 200000);

  const strategyOnly = {
    model_key: 'llm-router-auto',
    flow: 'auto',
    steps: [{ strategy: 'auto' }],
  };
  assert.deepEqual(concreteModelsFromScene(strategyOnly), []);
  assert.equal(resolveContextWindowForScene(strategyOnly), ROUTE_CONTEXT_WINDOW);

  const withRules = {
    model_key: 'llm-router-r',
    steps: [{ model: 'glm-5.2' }],
    rules: [{ steps: [{ model: 'kimi-k3' }] }],
  };
  assert.equal(resolveContextWindowForScene(withRules), 200000); // glm 200k < kimi-k3 1M
});
