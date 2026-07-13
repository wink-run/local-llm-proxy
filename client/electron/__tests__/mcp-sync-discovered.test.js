'use strict';
// 扫描即纳管：客户端配置 MCP 文案与来源标记
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mcpClientSync = require('../mcp-client-sync');

test('inferClientMcpDescription 标注客户端自配且不含「未纳管」', () => {
  const withPkg = mcpClientSync.inferClientMcpDescription({
    command: 'npx',
    args: ['-y', '@example/foo-mcp'],
  });
  assert.match(withPkg, /客户端自配/);
  assert.doesNotMatch(withPkg, /未纳管/);

  const fallback = mcpClientSync.inferClientMcpDescription({ command: 'node', args: [] });
  assert.equal(fallback, '客户端自配 · node');
  assert.doesNotMatch(fallback, /未纳管/);

  const empty = mcpClientSync.inferClientMcpDescription({});
  assert.equal(empty, '客户端自配 MCP');
});
