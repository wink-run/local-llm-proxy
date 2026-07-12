'use strict';
// 社区推荐目录:缓存优先 + 内置 MCP 永不丢失
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const CACHE = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');

function writeCache(doc) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, yaml.dump(doc), 'utf8');
}
function clearCache() {
  try { fs.unlinkSync(CACHE); } catch {}
}

test('mcp-catalog: 缓存项覆盖同 id 且保留内置 MCP', () => {
  const mcpCatalog = require('../mcp-catalog');
  writeCache({
    version: 1,
    mcp: [{
      catalog_id: 'community-demo', id: 'community-demo', name: 'community-demo',
      display_name: 'Community Demo', type: 'stdio', command: 'npx', args: ['-y', 'demo'],
      metadata: { categoryGroup: 'official' }, config_fields: [],
    }],
    prompts: [], skills: [], assistants: [],
  });
  mcpCatalog.resetCatalogCache();
  const ids = new Set(mcpCatalog.listCatalogItems().map(i => i.catalogId));
  assert.ok(ids.has('community-demo'), '缓存项应出现');
  assert.ok(ids.has('tokenbank-agent-bridge'), '内置 bridge 永不丢');
  assert.ok(ids.has('tokenbank-prompts'), '内置 prompts 永不丢');
  clearCache();
  mcpCatalog.resetCatalogCache();
});

test('mcp-catalog: 无缓存时回退本地内置 yaml', () => {
  const mcpCatalog = require('../mcp-catalog');
  clearCache();
  mcpCatalog.resetCatalogCache();
  const ids = new Set(mcpCatalog.listCatalogItems().map(i => i.catalogId));
  assert.ok(ids.has('tokenbank-agent-bridge'));
});
