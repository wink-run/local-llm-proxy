'use strict';
// prompt 投射 = MCP 可见性标记:不落盘、不写命令文件
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { projectResource, unprojectResource, verifyProjection } = require('../resource-projector');
const {
  listPromptProjectableAgentIds,
  listSkillProjectableAgentIds,
} = require('../resource-agent-targets');

const prompt = { type: 'prompt', name: 'code-review', content: '审查 $ARGUMENTS' };

test('projectResource(prompt) → projectionType=mcp,不写文件', () => {
  const r = projectResource(prompt, 'cursor', 'global', {});
  assert.equal(r.projectionType, 'mcp');
  assert.equal(r.status, 'active');
  assert.equal(r.targetPath, null);
});

test('unprojectResource(prompt) → removed:true,无文件副作用', () => {
  const r = unprojectResource(prompt, 'cursor', 'mcp', null);
  assert.equal(r.removed, true);
});

test('verifyProjection(prompt, mcp) → healthy', () => {
  const r = verifyProjection(prompt, 'cursor', 'mcp', null);
  assert.equal(r.healthy, true);
});

test('prompt 可投射目标 = 已安装 Agent（与 Skill 一致）', () => {
  assert.deepEqual(listPromptProjectableAgentIds(), listSkillProjectableAgentIds());
});
