'use strict';
// Windows MCP：.cmd launcher + 缺省 mcp.json 可创建
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  writeElectronAsNodeLauncher,
  writeBridgeMcpLauncher,
  mcpStdioFromLauncher,
} = require('../mcp-manager');
const { syncJsonClient, syncCodexClient } = require('../mcp-client-sync');

test('writeElectronAsNodeLauncher(platform=win32) 生成 .cmd 并内嵌 ELECTRON_RUN_AS_NODE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-win-'));
  try {
    const launcher = writeElectronAsNodeLauncher({
      name: 'prompts-test',
      scriptPath: path.join(__dirname, '..', 'prompt-mcp.js'),
      env: { TB_CLIENT_ID: 'workbuddy' },
      platform: 'win32',
      mcpDir: dir,
    });
    assert.ok(launcher.endsWith('.cmd'), launcher);
    const body = fs.readFileSync(launcher, 'utf8');
    assert.ok(body.includes('@echo off'));
    assert.ok(body.includes('ELECTRON_RUN_AS_NODE'));
    assert.ok(body.includes('TB_CLIENT_ID'));
    assert.ok(body.includes('prompt-mcp.js'));
    assert.ok(!body.includes('#!/bin/bash'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBridgeMcpLauncher(platform=win32) 生成 bridge-*.cmd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-bridge-'));
  try {
    const launcher = writeBridgeMcpLauncher({
      taskId: 't1',
      workingDir: 'C:\\proj',
      mainAgentId: 'codex',
      sessionKey: 's',
      sessionInstanceId: 'i',
      mcpDir: dir,
      platform: 'win32',
    });
    assert.ok(launcher.endsWith('bridge-t1.cmd'), launcher);
    const body = fs.readFileSync(launcher, 'utf8');
    assert.ok(body.includes('TB_PARENT_TASK_ID'));
    assert.ok(body.includes('agent-dispatch-mcp.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mcpStdioFromLauncher: win32 .cmd → cmd.exe /c', () => {
  const unix = mcpStdioFromLauncher('/tmp/foo.sh', {}, 'darwin');
  assert.equal(unix.command, '/tmp/foo.sh');
  assert.deepEqual(unix.args, []);

  const win = mcpStdioFromLauncher('C:\\Users\\x\\.tokenbank\\mcp\\a.cmd', {}, 'win32');
  assert.match(String(win.command), /cmd\.exe$/i);
  assert.deepEqual(win.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(String(win.args[3]).includes('a.cmd'));
});

test('syncJsonClient: 缺文件且 allowCreate → 新建并写入 MCP', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-json-'));
  const filePath = path.join(dir, 'mcp.json');
  try {
    assert.equal(fs.existsSync(filePath), false);
    const denied = syncJsonClient('workbuddy', filePath, [{
      id: 's1', name: 'demo', status: 'active',
      command: 'npx', args: ['-y', 'demo-mcp'],
    }], { allowCreate: false });
    assert.equal(denied.reason, 'config-missing');
    assert.equal(fs.existsSync(filePath), false);

    const ok = syncJsonClient('workbuddy', filePath, [{
      id: 's1', name: 'demo', status: 'active',
      command: 'npx', args: ['-y', 'demo-mcp'],
    }], { allowCreate: true });
    assert.equal(ok.skipped, undefined);
    assert.equal(ok.synced.length, 1);
    assert.ok(fs.existsSync(filePath));
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(doc.mcpServers.demo || doc.mcpServers['tb-demo'] || Object.keys(doc.mcpServers).length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncCodexClient: 缺 config.toml 且 allowCreate → 新建并写入 mcp_servers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-toml-'));
  const filePath = path.join(dir, 'config.toml');
  try {
    const denied = syncCodexClient('codex', filePath, [{
      id: 's1', name: 'demo', status: 'active',
      command: 'npx', args: ['-y', 'demo-mcp'],
    }], [], { allowCreate: false });
    assert.equal(denied.reason, 'config-missing');

    const ok = syncCodexClient('codex', filePath, [{
      id: 's1', name: 'demo', status: 'active',
      command: 'npx', args: ['-y', 'demo-mcp'],
    }], [], { allowCreate: true });
    assert.ok(fs.existsSync(filePath));
    const text = fs.readFileSync(filePath, 'utf8');
    assert.ok(text.includes('[mcp_servers.demo]') || text.includes('mcp_servers'));
    assert.ok(text.includes('tokenbank-mcp'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
