'use strict';

// DeepSeek Harness（cordis-mcp-client）写盘/扫描/删除的 round-trip 测试。
// 用非 builtin server 走 serverToEntry 通用路径，避开 electron launcher，可纯 node 运行。

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sync = require('../mcp-client-sync');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dsh-'));
  return path.join(dir, 'cordis.patch.yml');
}

const stdioServer = {
  id: 'srv-1', name: 'tokenbank-res-test', status: 'active',
  command: 'node', args: ['resources-mcp.js'], env: { TB_CLIENT_ID: 'deepseek-harness' },
};
const httpServer = {
  id: 'srv-2', name: 'remote-mcp', status: 'active',
  url: 'http://127.0.0.1:11430/mcp/deepseek-harness', type: 'http',
  headers: { Authorization: 'Bearer tok' },
};

describe('cordis-mcp-client sync', () => {
  let file;
  beforeEach(() => { file = tmpFile(); });

  it('writes a dsh-mcp-client row and round-trips stdio config', () => {
    const res = sync.syncCordisClient('deepseek-harness', file, [stdioServer], [], { allowCreate: true });
    assert.equal(res.synced.length, 1);
    assert.equal(res.keys[0], 'tokenbank-res-test');

    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /# >>> tokenbank-mcp managed >>>/);
    assert.match(text, /@deepseek-ai\/dsh-mcp-client/);
    assert.match(text, /serverName: tokenbank-res-test/);
    assert.match(text, /transport: stdio/);

    const parsed = sync.parseCordisMcpClientSections(text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].clientKey, 'tokenbank-res-test');
    assert.equal(parsed[0].entry.command, 'node');
    assert.deepEqual(parsed[0].entry.args, ['resources-mcp.js']);
    assert.equal(parsed[0].entry.env.TB_CLIENT_ID, 'deepseek-harness');
  });

  it('maps url servers to streamable-http transport', () => {
    sync.syncCordisClient('deepseek-harness', file, [httpServer], [], { allowCreate: true });
    const parsed = sync.parseCordisMcpClientSections(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].entry.url, 'http://127.0.0.1:11430/mcp/deepseek-harness');
    assert.equal(parsed[0].entry.headers.Authorization, 'Bearer tok');
  });

  it('preserves user content with !!js custom tags outside the managed block', () => {
    const userDoc = [
      '- insert:',
      "    - id: user-plugin",
      "      name: '@me/plugin'",
      '      config:',
      "        mode: !!js process.env.X ?? 'y'",
      '',
    ].join('\n');
    fs.writeFileSync(file, userDoc, 'utf8');

    sync.syncCordisClient('deepseek-harness', file, [stdioServer], [], { allowCreate: true });
    const text = fs.readFileSync(file, 'utf8');
    // 用户的 !!js 内容原样保留（没有被 YAML round-trip 破坏）
    assert.match(text, /mode: !!js process\.env\.X/);
    assert.match(text, /id: user-plugin/);
    // 我们的托管块也在
    assert.match(text, /serverName: tokenbank-res-test/);
  });

  it('re-sync replaces the managed block rather than appending a second one', () => {
    sync.syncCordisClient('deepseek-harness', file, [stdioServer], [], { allowCreate: true });
    sync.syncCordisClient('deepseek-harness', file, [stdioServer], ['tokenbank-res-test'], { allowCreate: true });
    const text = fs.readFileSync(file, 'utf8');
    const opens = (text.match(/# >>> tokenbank-mcp managed >>>/g) || []).length;
    assert.equal(opens, 1, 'exactly one managed block');
    assert.equal(sync.parseCordisMcpClientSections(text).length, 1);
  });

  it('stripCordisMcpKey removes a single row and drops the block when empty', () => {
    sync.syncCordisClient('deepseek-harness', file, [stdioServer, httpServer], [], { allowCreate: true });
    let text = fs.readFileSync(file, 'utf8');
    assert.equal(sync.parseCordisMcpClientSections(text).length, 2);

    text = sync.stripCordisMcpKey(text, 'tokenbank-res-test');
    let parsed = sync.parseCordisMcpClientSections(text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].clientKey, 'remote-mcp');

    text = sync.stripCordisMcpKey(text, 'remote-mcp');
    assert.equal(sync.parseCordisMcpClientSections(text).length, 0);
    assert.doesNotMatch(text, /# >>> tokenbank-mcp managed >>>/);
  });
});
