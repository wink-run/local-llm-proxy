'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const localStats = require('../local-stats');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-stats-enrich-'));
}

test('session enrich links proxy row even when tokens are smaller', () => {
  const dir = tmpDir();
  try {
    localStats.init(dir);
    // 网关先落账（OAuth，无 app_id）
    assert.equal(localStats.record({
      request_id: 'msg_test_link',
      api_key: 'sk-ant-oat01-xxx',
      model: 'deepseek-v4-flash',
      tier: 'paid',
      input_tokens: 1000,
      output_tokens: 200,
      data_source: 'proxy',
    }), true);

    // 会话补录同 id，token 更小 → 仍应改 data_source 以便应用明细命中
    assert.equal(localStats.record({
      request_id: 'msg_test_link',
      model: 'deepseek-v4-flash',
      input_tokens: 10,
      output_tokens: 5,
      data_source: 'session-claude',
      session_id: 'sess-1',
    }), true);

    const db = new Database(path.join(dir, 'local-stats.db'), { readonly: true });
    const found = db.prepare(
      'SELECT data_source, session_id, tokens, input_tokens FROM requests WHERE request_id = ?'
    ).get('msg_test_link');
    db.close();

    assert.ok(found);
    assert.equal(found.data_source, 'session-claude');
    assert.equal(found.session_id, 'sess-1');
    // 保留更大的 proxy token
    assert.equal(found.tokens, 1200);
    assert.equal(found.input_tokens, 1000);

    const detail = localStats.queryAppDetail({
      dataSources: ['session-claude'],
      days: 30,
      includeSessionImport: true,
    });
    assert.equal(detail.total.tokens, 1200);
    assert.ok((detail.bySource || []).some(s => s.source === 'session' && s.tokens === 1200));
  } finally {
    localStats.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
