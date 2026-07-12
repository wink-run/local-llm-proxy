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

test('resource-catalog: 缓存优先返回下发项', () => {
  const resCatalog = require('../resource-catalog');
  writeCache({
    version: 1, mcp: [],
    prompts: [{ catalogId: 'srv-prompt', type: 'prompt', name: 'srv-prompt',
      display_name: '服务端提示词', description: 'from server', content: 'X' }],
    skills: [], assistants: [],
  });
  resCatalog.resetCatalogCache();
  const names = resCatalog.listCatalogItems().map(i => i.name);
  assert.ok(names.includes('srv-prompt'), '应含下发 prompt');
  assert.ok(!names.includes('code-review'), '缓存存在时不混入 BUILTIN');
  assert.equal(resCatalog.getCatalogItem('srv-prompt').display_name, '服务端提示词');
  clearCache();
  resCatalog.resetCatalogCache();
});

test('resource-catalog: 无缓存回退 BUILTIN', () => {
  const resCatalog = require('../resource-catalog');
  clearCache();
  resCatalog.resetCatalogCache();
  const names = resCatalog.listCatalogItems().map(i => i.name);
  assert.ok(names.includes('code-review'), '无缓存时用内置');
});
