'use strict';

// dsh 凭证：独立 apiKeyEnv，避免继承 Codex 写入 shell 的 TOKENBANK_API_KEY。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const dsh = require('../dsh-config');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cfg-'));
}

test('syncDshGatewayKey writes unique env into credentials and settings', () => {
  const home = tmpHome();
  const settings = path.join(home, 'settings.yaml');
  fs.writeFileSync(settings, yaml.dump({
    'llm-pi-ai': { providers: { tokenbank: { apiKeyEnv: 'TOKENBANK_API_KEY', api: 'openai-completions' } } },
  }), 'utf8');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), yaml.dump({ TOKENBANK_API_KEY: 'sk-old' }), { encoding: 'utf8', mode: 0o600 });

  const r = dsh.syncDshGatewayKey(settings, 'sk-dsh-own');
  assert.equal(r.changed, true);

  const cred = yaml.load(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'));
  assert.equal(cred.TOKENBANK_DSH_API_KEY, 'sk-dsh-own');
  assert.equal(cred.TOKENBANK_API_KEY, undefined);

  const doc = yaml.load(fs.readFileSync(settings, 'utf8'));
  assert.equal(doc['llm-pi-ai'].providers.tokenbank.apiKeyEnv, 'TOKENBANK_DSH_API_KEY');
  assert.equal(doc['llm-pi-ai'].providers.tokenbank.api, 'openai-completions');
});

test('syncDshGatewayKey is idempotent when already unique', () => {
  const home = tmpHome();
  const settings = path.join(home, 'settings.yaml');
  fs.writeFileSync(settings, yaml.dump({
    'llm-pi-ai': { providers: { tokenbank: { apiKeyEnv: 'TOKENBANK_DSH_API_KEY' } } },
  }), 'utf8');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), yaml.dump({ TOKENBANK_DSH_API_KEY: 'sk-dsh-own' }), { encoding: 'utf8', mode: 0o600 });

  const r = dsh.syncDshGatewayKey(settings, 'sk-dsh-own');
  assert.equal(r.changed, false);
});

test('revertDshCredentials removes gateway keys and keeps unrelated secrets', () => {
  const home = tmpHome();
  const credFile = path.join(home, '.credentials.yaml');
  fs.writeFileSync(credFile, yaml.dump({
    TOKENBANK_DSH_API_KEY: 'sk-dsh',
    TOKENBANK_API_KEY: 'sk-legacy',
    OTHER_KEY: 'keep-me',
  }), { encoding: 'utf8', mode: 0o600 });

  dsh.revertDshCredentials(home);
  const cred = yaml.load(fs.readFileSync(credFile, 'utf8'));
  assert.equal(cred.OTHER_KEY, 'keep-me');
  assert.equal(cred.TOKENBANK_DSH_API_KEY, undefined);
  assert.equal(cred.TOKENBANK_API_KEY, undefined);
});
