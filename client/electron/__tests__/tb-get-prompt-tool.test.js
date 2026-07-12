'use strict';
// tb_get_prompt：MCP 工具，让 Agent 主动取回提示词正文（不走网关）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');
const bridge = require('../agent-dispatch-mcp');

test('TOOLS 暴露 tb_get_prompt', () => {
  assert.ok(Array.isArray(bridge.TOOLS));
  assert.ok(bridge.TOOLS.some(t => t.name === 'tb_get_prompt'), 'TOOLS 应含 tb_get_prompt');
});

test('tb_get_prompt 命中 → 返回展开正文，isError=false', async () => {
  const orig = resourceManager.resolvePromptForClient;
  process.env.TB_CLIENT_ID = 'claude-code';
  resourceManager.resolvePromptForClient = (ref, args, cid) => {
    assert.equal(cid, 'claude-code');
    return { found: true, name: ref, text: `[${ref}] ${args}` };
  };
  try {
    const r = await bridge.handleToolCall('tb_get_prompt', { name: '代码审查', args: 'auth.js' });
    assert.equal(r.isError, false);
    assert.equal(r.content[0].text, '[代码审查] auth.js');
  } finally {
    resourceManager.resolvePromptForClient = orig;
    delete process.env.TB_CLIENT_ID;
  }
});

test('tb_get_prompt 未命中/未投射 → isError=true', async () => {
  const orig = resourceManager.resolvePromptForClient;
  resourceManager.resolvePromptForClient = () => ({ found: false });
  try {
    const r = await bridge.handleToolCall('tb_get_prompt', { name: '不存在' });
    assert.equal(r.isError, true);
  } finally { resourceManager.resolvePromptForClient = orig; }
});
