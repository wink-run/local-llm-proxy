'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expandEntity, defaultUserCapabilities, loadDoc, applyCloudConfig } = require('../app-handlers');
const {
  listSkillProjectableAgentIds,
  listAssistantProjectableAgentIds,
  listPromptProjectableAgentIds,
  AGENT_RESOURCE_TARGETS,
} = require('../resource-agent-targets');
const { resolveAppsRuntime } = require('../apps-compiler');

test('defaultUserCapabilities enables resource_project when handler declares it', () => {
  const doc = loadDoc();
  assert.equal(defaultUserCapabilities(doc.handlers['claude-code-cli']).resource_project, true);
  assert.equal(defaultUserCapabilities(doc.handlers['kimi-code-cli']).resource_project, true);
  assert.equal(defaultUserCapabilities(doc.handlers['hermes-cli']).resource_project, true);
  assert.equal(defaultUserCapabilities(doc.handlers['openclaw-api']).resource_project, true);
  assert.equal(defaultUserCapabilities(doc.handlers['workbuddy-stats']).resource_project, false);
});

test('expandEntity exposes resource_project from vars/handler defaults', () => {
  const on = expandEntity({
    id: 'claude-code',
    handler: 'claude-code-cli',
    vars: { capabilities: { gateway_proxy: true, resource_project: true } },
  });
  assert.equal(on.resource_project, true);

  const off = expandEntity({
    id: 'claude-code',
    handler: 'claude-code-cli',
    vars: { capabilities: { gateway_proxy: true, resource_project: false } },
  });
  assert.equal(off.resource_project, false);

  // vars 未写 resource_project 时回落 handler 默认（开启）
  const def = expandEntity({
    id: 'claude-code',
    handler: 'claude-code-cli',
    vars: { capabilities: { gateway_proxy: true } },
  });
  assert.equal(def.resource_project, true);
});

test('default_entities projectable set matches product defaults', () => {
  applyCloudConfig(null);
  const fallback = (loadDoc().default_entities || []).filter(e => e?.id && e?.handler);
  const rt = resolveAppsRuntime({ app_entities: fallback });
  const allowed = new Set(
    (rt.entities_expanded || [])
      .filter(e => e.resource_project)
      .map(e => e.id),
  );
  for (const id of ['claude-code', 'codex', 'cursor', 'kimi-code', 'opencode', 'hermes', 'openclaw']) {
    assert.ok(allowed.has(id), `expected ${id} projectable`);
    assert.ok(AGENT_RESOURCE_TARGETS[id], `expected skill target for ${id}`);
  }
  assert.equal(allowed.has('workbuddy'), false);
});

test('skill/prompt vs assistant projection filters differ', () => {
  applyCloudConfig(null);
  const fallback = (loadDoc().default_entities || []).filter(e => e?.id && e?.handler);
  const rt = resolveAppsRuntime({ app_entities: fallback });
  const cl = require('../config-loader');
  const targets = require('../resource-agent-targets');
  const origExpanded = cl.appEntitiesExpanded;
  const origEntities = cl.appEntities;
  const origInstalled = targets.isAgentInstalled;
  cl.appEntitiesExpanded = () => rt.entities_expanded;
  cl.appEntities = () => rt.app_entities;
  // 已装：claude-code / kimi-code / workbuddy（后者无 resource_project）
  targets.isAgentInstalled = (id) => ['claude-code', 'kimi-code', 'workbuddy'].includes(id);
  try {
    // Skill：已安装即可（不看 resource_project）
    const skillIds = listSkillProjectableAgentIds();
    assert.ok(skillIds.includes('claude-code'));
    assert.ok(skillIds.includes('kimi-code'));
    assert.ok(skillIds.includes('workbuddy'));
    assert.ok(!skillIds.includes('hermes')); // 未装

    // 智能体：需 resource_project + 已安装
    const assistantIds = listAssistantProjectableAgentIds();
    assert.ok(assistantIds.includes('claude-code'));
    assert.ok(assistantIds.includes('kimi-code'));
    assert.ok(!assistantIds.includes('workbuddy'));
    assert.ok(!assistantIds.includes('hermes'));

    // Prompt：与 Skill 一致（已安装即可）
    const promptIds = listPromptProjectableAgentIds();
    assert.deepEqual(promptIds, skillIds);
  } finally {
    cl.appEntitiesExpanded = origExpanded;
    cl.appEntities = origEntities;
    targets.isAgentInstalled = origInstalled;
  }
});

test('isAgentInstalled uses detect_command when present', () => {
  const shim = require('../shim-installer');
  const orig = shim.resolveRealCommand;
  shim.resolveRealCommand = (cmd) => (cmd === 'kimi' ? '/tmp/fake-kimi' : null);
  try {
    const { isAgentInstalled } = require('../resource-agent-targets');
    assert.equal(typeof isAgentInstalled('kimi-code'), 'boolean');
  } finally {
    shim.resolveRealCommand = orig;
  }
});
