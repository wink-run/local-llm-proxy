'use strict';
// tokenbank-prompts:直连会话取回 prompt 的独立 MCP(按 TB_CLIENT_ID 过滤)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');
const mcp = require('../prompt-mcp');

test('TOOLS 暴露 tb_get_prompt 与 tb_list_prompts', () => {
  const names = mcp.TOOLS.map(t => t.name);
  assert.deepEqual(names.sort(), ['tb_get_prompt', 'tb_list_prompts']);
});

test('tb_get_prompt 命中 → 正文;未投射 → isError', async () => {
  const orig = resourceManager.resolvePromptForClient;
  resourceManager.resolvePromptForClient = (ref, args, cid) =>
    cid === 'claude-code' && ref === '代码审查'
      ? { found: true, name: ref, text: `[${ref}] ${args}` }
      : { found: false };
  process.env.TB_CLIENT_ID = 'claude-code';
  try {
    const hit = await mcp.handleToolCall('tb_get_prompt', { name: '代码审查', args: 'auth.js' });
    assert.equal(hit.isError, false);
    assert.equal(hit.content[0].text, '[代码审查] auth.js');

    process.env.TB_CLIENT_ID = 'codex';
    const miss = await mcp.handleToolCall('tb_get_prompt', { name: '代码审查' });
    assert.equal(miss.isError, true);
  } finally {
    resourceManager.resolvePromptForClient = orig;
    delete process.env.TB_CLIENT_ID;
  }
});

test('tb_list_prompts 只列该 client 的投射集', async () => {
  const orig = resourceManager.listPromptsForClient;
  resourceManager.listPromptsForClient = (cid) =>
    cid === 'cursor' ? [{ id: 'r1', name: 'code-review', display_name: '代码审查', description: '结构化审查' }] : [];
  process.env.TB_CLIENT_ID = 'cursor';
  try {
    const r = await mcp.handleToolCall('tb_list_prompts', {});
    assert.equal(r.isError, false);
    assert.ok(r.content[0].text.includes('code-review'));
    assert.ok(r.content[0].text.includes('代码审查'));
  } finally {
    resourceManager.listPromptsForClient = orig;
    delete process.env.TB_CLIENT_ID;
  }
});

test('initialize 返回 serverInfo.name=tokenbank-prompts', () => {
  const sent = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { sent.push(String(s)); return true; };
  try {
    mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  } finally { process.stdout.write = origWrite; }
  const msg = JSON.parse(sent[0]);
  assert.equal(msg.result.serverInfo.name, 'tokenbank-prompts');
});
