'use strict';
// tokenbank-models: 查询网关可用模型 / 动态解析替代模型
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../models-mcp');

const SAMPLE = [
  { id: 'gpt-4.1', owned_by: 'openai', model_type: 'chat' },
  { id: 'flux-schnell', owned_by: 'personal', model_type: 'image' },
  { id: 'text-embedding-3-small', owned_by: 'openai', model_type: 'embedding' },
];

test('TOOLS 暴露 tb_list_models 与 tb_resolve_model', () => {
  const names = mcp.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['tb_list_models', 'tb_resolve_model']);
});

test('initialize 返回 serverInfo.name=tokenbank-models', () => {
  const sent = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { sent.push(String(s)); return true; };
  try {
    mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  } finally {
    process.stdout.write = origWrite;
  }
  const msg = JSON.parse(sent[0]);
  assert.equal(msg.result.serverInfo.name, 'tokenbank-models');
});

test('tb_list_models 可按 type 过滤', async () => {
  mcp.setListModelsImpl(async () => SAMPLE);
  try {
    const all = await mcp.handleToolCall('tb_list_models', {});
    assert.equal(all.isError, false);
    assert.ok(all.content[0].text.includes('flux-schnell'));
    assert.ok(all.content[0].text.includes('gpt-4.1'));

    const images = await mcp.handleToolCall('tb_list_models', { type: 'image' });
    assert.ok(images.content[0].text.includes('flux-schnell'));
    assert.ok(!images.content[0].text.includes('gpt-4.1'));
  } finally {
    mcp.setListModelsImpl(null);
  }
});

test('tb_resolve_model: 首选存在 → 直接采用', async () => {
  mcp.setListModelsImpl(async () => SAMPLE);
  try {
    const r = await mcp.handleToolCall('tb_resolve_model', { preferred: 'flux-schnell' });
    assert.equal(r.isError, false);
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.available, true);
    assert.equal(body.model, 'flux-schnell');
  } finally {
    mcp.setListModelsImpl(null);
  }
});

test('tb_resolve_model: skill 硬编码模型不存在 → 切换同模态可用模型', async () => {
  mcp.setListModelsImpl(async () => SAMPLE);
  try {
    const r = await mcp.handleToolCall('tb_resolve_model', {
      preferred: 'gpt-image-2',
      type: 'image',
    });
    assert.equal(r.isError, false);
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.available, false);
    assert.equal(body.model, 'flux-schnell');
    assert.ok(body.message.includes('已切换'));
  } finally {
    mcp.setListModelsImpl(null);
  }
});

test('inferModelTypeFromName 识别 image / embedding', () => {
  assert.equal(mcp.inferModelTypeFromName('gpt-image-2'), 'image');
  assert.equal(mcp.inferModelTypeFromName('text-embedding-3-large'), 'embedding');
  assert.equal(mcp.inferModelTypeFromName('claude-sonnet-4'), 'chat');
});
