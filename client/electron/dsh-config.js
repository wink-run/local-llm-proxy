'use strict';

// DeepSeek Harness 网关凭证：必须用独立 env 名。
// dsh credentials-local 优先读进程环境；Codex 纳管会把 TOKENBANK_API_KEY 写进 shell，
// 若 dsh 也声明同名 apiKeyEnv，请求会带着 Codex 的 key 进网关，用量记到 Codex。

const fs = require('fs');
const path = require('path');

const DSH_API_KEY_ENV = 'TOKENBANK_DSH_API_KEY';
const LEGACY_API_KEY_ENV = 'TOKENBANK_API_KEY';
const API_KEY_ENV_DOT = 'llm-pi-ai.providers.tokenbank.apiKeyEnv';

function deepSetDot(obj, dotKey, val) {
  const parts = String(dotKey).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

function loadYaml(file) {
  const yaml = require('js-yaml');
  try {
    if (!fs.existsSync(file)) return {};
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return doc;
  } catch {
    return {};
  }
}

function writeYaml(file, doc, mode) {
  const yaml = require('js-yaml');
  const opts = { encoding: 'utf8' };
  if (mode != null) opts.mode = mode;
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: 120 }), opts);
  if (mode != null) {
    try { fs.chmodSync(file, mode); } catch { /* ignore */ }
  }
}

function credPath(dshHome) {
  return path.join(dshHome, '.credentials.yaml');
}

/** 写独立网关 key，并清掉会与 Codex shell env 撞车的 TOKENBANK_API_KEY */
function writeDshCredentials(dshHome, apiKey) {
  if (!dshHome || !apiKey) return false;
  const file = credPath(dshHome);
  const cred = loadYaml(file);
  let changed = false;
  if (cred[DSH_API_KEY_ENV] !== String(apiKey)) {
    cred[DSH_API_KEY_ENV] = String(apiKey);
    changed = true;
  }
  if (cred[LEGACY_API_KEY_ENV] != null) {
    delete cred[LEGACY_API_KEY_ENV];
    changed = true;
  }
  if (changed) {
    try { fs.mkdirSync(dshHome, { recursive: true }); } catch { /* ignore */ }
    writeYaml(file, cred, 0o600);
  }
  return changed;
}

/** 取消纳管：只删我们写入的网关 key，保留用户其他凭证 */
function revertDshCredentials(dshHome) {
  if (!dshHome) return false;
  const file = credPath(dshHome);
  if (!fs.existsSync(file)) return false;
  const cred = loadYaml(file);
  let changed = false;
  for (const k of [DSH_API_KEY_ENV, LEGACY_API_KEY_ENV]) {
    if (cred[k] != null) { delete cred[k]; changed = true; }
  }
  if (!changed) return false;
  if (Object.keys(cred).length === 0) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  } else {
    writeYaml(file, cred, 0o600);
  }
  return true;
}

/**
 * 已纳管 settings.yaml：apiKeyEnv 改成独立名，并同步 .credentials.yaml。
 * 幂等：已是独立名且 key 一致则不写盘。
 */
function syncDshGatewayKey(settingsFile, apiKey) {
  if (!settingsFile || !apiKey) return { changed: false };
  const dshHome = path.dirname(settingsFile);
  const doc = loadYaml(settingsFile);
  let settingsChanged = false;
  const current = doc?.['llm-pi-ai']?.providers?.tokenbank?.apiKeyEnv;
  if (current !== DSH_API_KEY_ENV) {
    deepSetDot(doc, API_KEY_ENV_DOT, DSH_API_KEY_ENV);
    settingsChanged = true;
  }
  if (settingsChanged) writeYaml(settingsFile, doc);
  const credChanged = writeDshCredentials(dshHome, apiKey);
  return { changed: settingsChanged || credChanged };
}

module.exports = {
  DSH_API_KEY_ENV,
  LEGACY_API_KEY_ENV,
  writeDshCredentials,
  revertDshCredentials,
  syncDshGatewayKey,
};
