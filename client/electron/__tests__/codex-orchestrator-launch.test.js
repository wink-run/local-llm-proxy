'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildCodexOrchestratorProfileToml,
  writeBridgeMcpLauncher,
} = require('../mcp-manager');

const servers = [
  { id: 'tokenbank-agent-bridge', name: 'tokenbank-agent-bridge' },
  { name: 'context7' },
];

const mcpDir = path.join(os.tmpdir(), `tb-orch-test-${Date.now()}`);
fs.mkdirSync(mcpDir, { recursive: true });

const ctx = {
  taskId: 'task_test_1',
  workingDir: '/tmp/proj',
  mainAgentId: 'codex',
  sessionKey: 'sess_a',
  sessionInstanceId: 'inst_b',
  bridgeLauncher: writeBridgeMcpLauncher({
    taskId: 'task_test_1',
    workingDir: '/tmp/proj',
    mainAgentId: 'codex',
    sessionKey: 'sess_a',
    sessionInstanceId: 'inst_b',
    mcpDir,
  }),
};

const launcherText = fs.readFileSync(ctx.bridgeLauncher, 'utf8');
assert.ok(launcherText.includes('export ELECTRON_RUN_AS_NODE=1'));
assert.ok(launcherText.includes('TB_PARENT_TASK_ID'));
assert.ok(launcherText.includes('agent-dispatch-mcp.js'));

const buildRuntime = (srv) => {
  if (srv.name === 'tokenbank-agent-bridge') {
    return {
      command: ctx.bridgeLauncher,
      args: [],
      env: {},
    };
  }
  return {
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: { API_KEY: 'secret' },
  };
};

const toml = buildCodexOrchestratorProfileToml(servers, ctx, buildRuntime);

assert.ok(toml.includes(`command = ${JSON.stringify(ctx.bridgeLauncher)}`));
assert.ok(toml.includes('args = []'));
assert.ok(!toml.includes('[mcp_servers.tokenbank-agent-bridge.env]'));
assert.ok(toml.includes('enabled = true'));
assert.ok(toml.includes('required = true'));
assert.ok(toml.includes('[mcp_servers.context7.env]'));
assert.ok(!toml.includes('--enable'));

try { fs.unlinkSync(ctx.bridgeLauncher); } catch {}
try { fs.rmdirSync(mcpDir); } catch {}

console.log('codex-orchestrator-launch.test.js OK');
