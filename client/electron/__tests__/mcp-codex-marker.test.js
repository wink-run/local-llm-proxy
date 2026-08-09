'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncCodexClient, stripCodexManagedMcpBlock } = require('../mcp-client-sync');

const srv = {
  id: 's1', name: 'demo', status: 'active',
  command: 'npx', args: ['-y', 'demo-mcp'],
};

test('stripCodexManagedMcpBlock：清成对块 + 孤儿开/闭标记', () => {
  const dirty = [
    'model = "x"',
    '# >>> tokenbank-mcp managed >>>',
    '# >>> tokenbank-mcp managed >>>',
    '# >>> tokenbank-mcp managed >>>',
    '[mcp_servers.old]',
    'command = "x"',
    '# <<< tokenbank-mcp managed <<<',
    '# <<< tokenbank-mcp managed <<<',
    '',
    '[model_providers.tokenbank]',
    'name = "Tokenbank"',
    '',
  ].join('\n');
  const cleaned = stripCodexManagedMcpBlock(dirty);
  assert.ok(!cleaned.includes('tokenbank-mcp managed'), cleaned);
  assert.ok(cleaned.includes('model = "x"'));
  assert.ok(cleaned.includes('[model_providers.tokenbank]'));
});

test('syncCodexClient：残留开标记不会叠加', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-marker-'));
  const file = path.join(dir, 'config.toml');
  try {
    // 模拟历史故障：只有开标记、无闭标记
    fs.writeFileSync(file, [
      'model = "gpt"',
      '# >>> tokenbank-mcp managed >>>',
      '# >>> tokenbank-mcp managed >>>',
      '# >>> tokenbank-mcp managed >>>',
      '[mcp_servers.demo]',
      'command = "old"',
      'args = []',
      '',
    ].join('\n'), 'utf8');

    syncCodexClient('codex', file, [srv], ['demo'], { allowCreate: true });
    syncCodexClient('codex', file, [srv], ['demo'], { allowCreate: true });
    syncCodexClient('codex', file, [srv], ['demo'], { allowCreate: true });

    const text = fs.readFileSync(file, 'utf8');
    const opens = (text.match(/# >>> tokenbank-mcp managed >>>/g) || []).length;
    const closes = (text.match(/# <<< tokenbank-mcp managed <<</g) || []).length;
    assert.equal(opens, 1, `opens=${opens}\n${text}`);
    assert.equal(closes, 1, `closes=${closes}\n${text}`);
    assert.equal((text.match(/\[mcp_servers\.demo\]/g) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
