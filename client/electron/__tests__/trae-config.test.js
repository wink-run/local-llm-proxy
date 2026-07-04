'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  toTraeModelEntry, isManagedEntry, applyTraeModels, revertTraeModels,
} = require('../trae-config');

test('toTraeModelEntry builds OpenAI custom model shape', () => {
  const m = toTraeModelEntry({
    name: 'tokenbank-gpt-4o',
    display_name: 'My Route',
    custom_model_id: 'gpt-4o',
    base_url: 'http://127.0.0.1:11430/v1/chat/completions',
    ak: 'sk-test',
  });
  assert.ok(m);
  assert.equal(m.name, 'gpt-4o');
  assert.equal(m.custom_model_id, 'gpt-4o');
  assert.equal(m.is_preset, false);
  assert.equal(m.client_connect, true);
  assert.equal(m.provider, 'openai');
  assert.equal(m.ak, 'sk-test');
  assert.ok(m.base_url.includes('/v1/chat/completions'));
  assert.ok(isManagedEntry(m));
});

test('applyTraeModels merges and reverts via backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-db-'));
  const dbPath = path.join(dir, 'state.vscdb');
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const preset = [{
    name: 'claude3.5', display_name: 'Claude', is_preset: true, ak: null, base_url: null,
  }];
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    .run('AI.agent.modelList', JSON.stringify(preset));
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    .run('AI.model', 'claude3.5');
  db.close();

  try {
    applyTraeModels(dbPath, [{
      name: 'tokenbank-deepseek',
      display_name: 'DeepSeek',
      custom_model_id: 'deepseek-v4-flash',
      base_url: 'http://127.0.0.1:11430/v1/chat/completions',
      ak: 'sk-gw',
    }]);

    const db2 = new Database(dbPath, { readonly: true });
    const list = JSON.parse(db2.prepare('SELECT value FROM ItemTable WHERE key = ?').get('AI.agent.modelList').value);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'claude3.5');
    assert.equal(list[1].custom_model_id, 'deepseek-v4-flash');
    assert.equal(db2.prepare('SELECT value FROM ItemTable WHERE key = ?').get('AI.model').value, 'deepseek-v4-flash');
    db2.close();

    revertTraeModels(dbPath);
    const db3 = new Database(dbPath, { readonly: true });
    const list2 = JSON.parse(db3.prepare('SELECT value FROM ItemTable WHERE key = ?').get('AI.agent.modelList').value);
    assert.equal(list2.length, 1);
    assert.equal(list2[0].name, 'claude3.5');
    assert.equal(db3.prepare('SELECT value FROM ItemTable WHERE key = ?').get('AI.model').value, 'claude3.5');
    db3.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
