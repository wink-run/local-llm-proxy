// client/electron/trae-config.js
// Trae IDE 纳管：向 state.vscdb 写入/还原自定义 OpenAI 兼容模型（AI.agent.modelList）。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MARKER = 'tokenbank';
const MODEL_LIST_KEY = 'AI.agent.modelList';
const MODEL_ACTIVE_KEY = 'AI.model';
const MODEL_ACTIVE_V1_KEY = 'AI.agent.model.v1';
const APPLIED_DIR = path.join(os.homedir(), '.tokenbank', 'applied');

/** 各平台 Trae User/globalStorage/state.vscdb 路径 */
function traeStateDbPath() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      'Trae', 'User', 'globalStorage', 'state.vscdb',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(home, '.config', 'Trae', 'User', 'globalStorage', 'state.vscdb');
}

function statePath(dbPath) {
  const tag = crypto.createHash('sha256').update(String(dbPath)).digest('hex').slice(0, 16);
  return path.join(APPLIED_DIR, `trae-${tag}.json`);
}

function isManagedEntry(m) {
  if (!m || typeof m !== 'object') return false;
  if (String(m.name || '').startsWith(`${MARKER}-`)) return true;
  try {
    const cfg = JSON.parse(m.custom_config || '{}');
    return cfg._configManagedBy === MARKER;
  } catch { return false; }
}

/** patch 模板项 → Trae modelList 条目（name 与 custom_model_id 均用真实 model id，供 AI.model 选中） */
function toTraeModelEntry(m) {
  const modelId = String(m.custom_model_id || m.id || '').trim();
  if (!modelId) return null;
  return {
    name: modelId,
    display_name: m.display_name || modelId,
    multimodal: m.multimodal !== false,
    is_default: false,
    custom_config: JSON.stringify({
      apply_file_path: true,
      is_new_pe: true,
      use_v2_process: true,
      _configManagedBy: MARKER,
    }),
    prompt_max_tokens: m.prompt_max_tokens || 45000,
    is_new: null,
    model_type: 'chat_model',
    builder: null,
    is_preset: false,
    client_connect: true,
    provider: m.provider || 'openai',
    icon: m.icon || null,
    ak: m.ak || m.apiKey || '',
    // Trae v3.3.51+ 要求完整 URL（含 /v1/chat/completions）
    base_url: m.base_url || m.url || '',
    status: true,
    custom_model_id: modelId,
  };
}

function openDb(dbPath) {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  return db;
}

function readDbValue(db, key) {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
  if (!row || row.value == null) return null;
  return Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
}

function writeDbValue(db, key, value) {
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function parseModelList(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/**
 * 纳管：合并 tokenbank 自定义模型到 AI.agent.modelList，并设首条为当前模型。
 * @param {string} dbPath state.vscdb 绝对路径
 * @param {object[]} patchModels applyRoute 后的 models[]（含 ak/base_url/custom_model_id）
 */
function applyTraeModels(dbPath, patchModels = []) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error('trae-state-db-not-found');
  }
  const entries = (patchModels || []).map(toTraeModelEntry).filter(Boolean);
  if (!entries.length) throw new Error('trae-no-models');

  if (!fs.existsSync(APPLIED_DIR)) fs.mkdirSync(APPLIED_DIR, { recursive: true });
  const bakPath = statePath(dbPath);
  const db = openDb(dbPath);
  try {
    const prevListRaw = readDbValue(db, MODEL_LIST_KEY);
    const prevActive = readDbValue(db, MODEL_ACTIVE_KEY);
    const prevActiveV1 = readDbValue(db, MODEL_ACTIVE_V1_KEY);
    if (!fs.existsSync(bakPath)) {
      fs.writeFileSync(bakPath, JSON.stringify({
        modelList: prevListRaw,
        active: prevActive,
        activeV1: prevActiveV1,
      }), 'utf8');
    }

    const list = parseModelList(prevListRaw);
    const kept = list.filter(m => !isManagedEntry(m));
    const merged = [...kept, ...entries];
    writeDbValue(db, MODEL_LIST_KEY, JSON.stringify(merged));

    const first = entries[0];
    writeDbValue(db, MODEL_ACTIVE_KEY, first.name);
    writeDbValue(db, MODEL_ACTIVE_V1_KEY, JSON.stringify(first));
    return { count: entries.length, defaultModel: first.name };
  } finally {
    db.close();
  }
}

/** 取消纳管：从备份还原 modelList / 当前模型 */
function revertTraeModels(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return;
  const bakPath = statePath(dbPath);
  const db = openDb(dbPath);
  try {
    if (fs.existsSync(bakPath)) {
      const bak = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
      if (bak.modelList != null) writeDbValue(db, MODEL_LIST_KEY, bak.modelList);
      else {
        const list = parseModelList(readDbValue(db, MODEL_LIST_KEY)).filter(m => !isManagedEntry(m));
        writeDbValue(db, MODEL_LIST_KEY, JSON.stringify(list));
      }
      if (bak.active != null) writeDbValue(db, MODEL_ACTIVE_KEY, bak.active);
      if (bak.activeV1 != null) writeDbValue(db, MODEL_ACTIVE_V1_KEY, bak.activeV1);
      fs.unlinkSync(bakPath);
      return;
    }
    const list = parseModelList(readDbValue(db, MODEL_LIST_KEY)).filter(m => !isManagedEntry(m));
    writeDbValue(db, MODEL_LIST_KEY, JSON.stringify(list));
  } finally {
    db.close();
  }
}

module.exports = {
  MARKER,
  traeStateDbPath,
  toTraeModelEntry,
  isManagedEntry,
  applyTraeModels,
  revertTraeModels,
};
