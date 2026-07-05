'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const catalog = require('../mcp-catalog');

describe('mcp-catalog', () => {
  beforeEach(() => {
    catalog.resetCatalogCache();
  });

  it('loads items from config/mcp-catalog.yaml', () => {
    const items = catalog.listCatalogItems();
    assert.ok(items.length > 1, 'catalog should have multiple items');
    const bridge = items.find(i => i.catalogId === 'tokenbank-agent-bridge');
    assert.ok(bridge);
    assert.equal(bridge.alwaysInstalled, true);
  });

  it('groups catalog by categoryGroup', () => {
    const groups = catalog.listCatalogGrouped();
    assert.ok(groups.length > 0);
    const ids = groups.map(g => g.id);
    assert.ok(ids.includes('tokenbank') || ids.includes('official'));
  });

  it('normalizes yaml config_fields', () => {
    const item = catalog.normalizeYamlItem({
      catalog_id: 'test',
      name: 'test',
      display_name: 'Test',
      config_fields: [{
        key: 'dir',
        label: 'Dir',
        type: 'path',
        default_value: '~/projects',
        append_arg: true,
        env_key: 'DIR',
        required: true,
      }],
    });
    assert.equal(item.configFields[0].defaultValue.includes('projects'), true);
    assert.equal(item.configFields[0].appendArg, true);
    assert.equal(item.configFields[0].envKey, 'DIR');
  });

  it('yaml file exists at electron config path', () => {
    const p = path.join(__dirname, '..', 'config', 'mcp-catalog.yaml');
    const fs = require('fs');
    assert.ok(fs.existsSync(p), `missing ${p}`);
  });
});
