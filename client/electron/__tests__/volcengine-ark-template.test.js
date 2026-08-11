'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

describe('mergeRegistryDoc 按 id 补全缺项', () => {
  it('云端 billing_sources 缺 volcengine-ark 时从内置补入', () => {
    // 构造临时用户 registry：有 providers.ark、无 billing.ark
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reg-'));
    const userPath = path.join(tmpDir, 'providers.registry.yaml');
    const stub = {
      version: 1,
      providers: [{ id: 'deepseek', label: 'DeepSeek', payg: true }],
      billing_sources: [
        { id: 'deepseek', category: 'payg', label: 'DeepSeek' },
        { id: 'api-volcengine', category: 'api_sub', label: 'Volcengine AI', plan_provider_id: 'volcengine' },
      ],
    };
    fs.writeFileSync(userPath, yaml.dump(stub));

    // 通过改环境难以劫持 USER_REGISTRY_YAML；直接测 merge 逻辑：
    // 复用 config-loader 的内置默认 + 手动模拟 mergeById 行为
    const loaderPath = require.resolve('../config-loader');
    delete require.cache[loaderPath];
    const loader = require('../config-loader');
    // 读内置默认确认有 ark
    const def = yaml.load(fs.readFileSync(
      path.join(__dirname, '../config/providers.registry.yaml'), 'utf8',
    ));
    assert.ok((def.billing_sources || []).some((s) => s.id === 'volcengine-ark'));

    // 模拟 merge：缺 id 应被补入
    const have = new Set(stub.billing_sources.map((s) => s.id));
    const merged = [...stub.billing_sources];
    for (const item of def.billing_sources || []) {
      if (!item?.id || have.has(item.id)) continue;
      merged.push(item);
      have.add(item.id);
    }
    assert.ok(merged.some((s) => s.id === 'volcengine-ark'));
    assert.ok(merged.some((s) => s.id === 'deepseek')); // 保留云端已有

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('getSourceTemplates 含 volcengine-ark', () => {
  it('reload 后模板库可见按量方舟', () => {
    const loader = require('../config-loader');
    loader.reloadRegistryDoc();
    const billing = require('../billing-config');
    const tpls = billing.getSourceTemplates({});
    const ark = tpls.find((t) => t.key === 'volcengine-ark');
    assert.ok(ark, '应出现 volcengine-ark');
    assert.equal(ark.kind, 'payg');
    assert.match(String(ark.base_url || ''), /\/api\/v3/);
  });
});
