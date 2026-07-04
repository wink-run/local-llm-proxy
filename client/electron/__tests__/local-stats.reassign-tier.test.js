'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const localStats = require('../local-stats');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-stats-'));
}

test('reassignProviderTier updates tier and zeroes cost for free', () => {
  const dir = tmpDir();
  try {
    localStats.init(dir);
    localStats.record({
      provider_id: 'agnes-ai',
      model: 'gpt-4o',
      tier: 'paid',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.01,
      data_source: 'proxy',
      billing_type: 'api-key',
    });
    const r = localStats.reassignProviderTier('agnes-ai', 'free');
    assert.ok(r.updated >= 1);

    const dash = localStats.queryDashboard(30);
    assert.equal(dash.tiers.free, 1);
    assert.equal(dash.tiers.paid, 0);
    const prov = dash.providers.find(p => p.id === 'agnes-ai');
    assert.ok(prov);
    assert.equal(prov.tier, 'free');
    assert.equal(prov.cost_usd, 0);
  } finally {
    localStats.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reassignProviderTier paid restores cost_usd column', () => {
  const dir = tmpDir();
  try {
    localStats.init(dir);
    localStats.record({
      provider_id: 'test-prov',
      model: 'gpt-4o-mini',
      tier: 'free',
      input_tokens: 200,
      output_tokens: 100,
      cost_usd: 0,
      data_source: 'proxy',
      billing_type: 'api-key',
    });
    localStats.reassignProviderTier('test-prov', 'paid');
    const dash = localStats.queryDashboard(30);
    assert.equal(dash.tiers.paid, 1);
    assert.equal(dash.tiers.free, 0);
  } finally {
    localStats.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectProviderIdVariants keeps acct-* isolated', () => {
  const ids = localStats.collectProviderIdVariants('acct-abc123');
  assert.deepEqual(ids, ['acct-abc123']);
});
