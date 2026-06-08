// client/electron/local-stats.js
// Per-device request statistics stored in SQLite.
// Call init(dbDir) once before record() or queryDashboard().
'use strict';

let db = null;
let _insertStmt = null;
let _getImportStateStmt = null;
let _setImportStateStmt = null;

// 注：tokens 保留为 input+output 之和，让既有 queryDashboard 的 SUM(tokens) 仍然成立；
// input/output 分列让仪表盘以后能展示精细成本；cache_* 反映 Anthropic prompt-cache 命中/写入。
//
// request_id：跨来源去重键。代理拦截用上游响应 id（Anthropic msg_xxx / OpenAI chatcmpl_xxx），
//   JSONL 导入用会话文件里的 message.id（Claude）或合成键（Codex/Gemini）。同一次调用若既走了
//   网关又落进会话文件，两边 request_id 相同 → 部分唯一索引 + INSERT OR IGNORE 保证只记一次。
// data_source：'proxy' = 网关实时拦截；'session-claude' / 'session-codex' / 'session-gemini' = 扫本地会话文件补录。
// status_code/error：非 2xx、异常、断流也落账，保证“不丢账”。
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS requests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  INTEGER NOT NULL,
    api_key             TEXT,
    app_id              TEXT,
    model               TEXT,
    provider_id         TEXT,
    tier                TEXT,
    tokens              INTEGER DEFAULT 0,
    input_tokens        INTEGER DEFAULT 0,
    output_tokens       INTEGER DEFAULT 0,
    cache_create_tokens INTEGER DEFAULT 0,
    cache_read_tokens   INTEGER DEFAULT 0,
    request_id          TEXT,
    data_source         TEXT,
    session_id          TEXT,
    status_code         INTEGER,
    error               TEXT,
    is_streaming        INTEGER DEFAULT 0,
    latency_ms          INTEGER,
    first_token_ms      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ts      ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_api_key ON requests(api_key, ts);
  CREATE INDEX IF NOT EXISTS idx_model   ON requests(model, ts);

  -- 会话文件增量扫描状态：记录每个文件上次导入时的 mtime/size，未变更则跳过。
  CREATE TABLE IF NOT EXISTS import_state (
    path   TEXT PRIMARY KEY,
    mtime  INTEGER,
    size   INTEGER
  );
`;

// 必须在列迁移之后执行：旧库执行 SCHEMA 时 request_id 列还不存在，
// 此时建索引会报错。放到 MIGRATIONS 之后，列已补齐再建部分唯一索引。
// 部分唯一索引：request_id 为 NULL 的行（拿不到上游 id 时）互不冲突，照常插入。
const POST_MIGRATION = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_request_id ON requests(request_id) WHERE request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_app_id ON requests(app_id, ts);
`;

// 已存在 DB 的列迁移（旧库缺这些列）。SQLite 不支持 ADD COLUMN IF NOT EXISTS，
// 已存在时抛 "duplicate column name"，吞掉即可。
const MIGRATIONS = [
  'ALTER TABLE requests ADD COLUMN input_tokens        INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN output_tokens       INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN cache_create_tokens INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN cache_read_tokens   INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN request_id          TEXT',
  'ALTER TABLE requests ADD COLUMN data_source         TEXT',
  'ALTER TABLE requests ADD COLUMN session_id          TEXT',
  'ALTER TABLE requests ADD COLUMN status_code         INTEGER',
  'ALTER TABLE requests ADD COLUMN error               TEXT',
  'ALTER TABLE requests ADD COLUMN is_streaming        INTEGER DEFAULT 0',
  'ALTER TABLE requests ADD COLUMN latency_ms          INTEGER',
  'ALTER TABLE requests ADD COLUMN first_token_ms      INTEGER',
  'ALTER TABLE requests ADD COLUMN app_id              TEXT',
];

/** @param {string} dbDir  Directory that will hold local-stats.db */
function init(dbDir) {
  if (db) return;
  const fs       = require('fs');
  const path     = require('path');
  const Database = require('better-sqlite3');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  try {
    db = new Database(path.join(dbDir, 'local-stats.db'));
    db.pragma('journal_mode = WAL');  // safer concurrent reads
    db.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try { db.exec(sql); } catch (e) {
        if (!/duplicate column name/i.test(e.message)) throw e;
      }
    }
    db.exec(POST_MIGRATION); // 列补齐后再建 request_id 唯一索引
    // INSERT OR IGNORE：命中 request_id 唯一索引时静默跳过（跨来源去重），不报错、不重复计。
    _insertStmt = db.prepare(
      'INSERT OR IGNORE INTO requests ' +
      '(ts, api_key, app_id, model, provider_id, tier, tokens, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, ' +
      ' request_id, data_source, session_id, status_code, error, is_streaming, latency_ms, first_token_ms) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?)'
    );
    _getImportStateStmt = db.prepare('SELECT mtime, size FROM import_state WHERE path = ?');
    _setImportStateStmt = db.prepare(
      'INSERT INTO import_state (path, mtime, size) VALUES (?,?,?) ' +
      'ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size'
    );
  } catch (e) {
    console.error('[local-stats] failed to open DB:', e.message);
    try { db?.close(); } catch {}
    db = null;
    _insertStmt = null;
  }
}

/**
 * Insert one request row. Silently ignored if init() hasn't been called.
 * Returns true if a new row was inserted, false if it was deduped (request_id
 * already present) or on error — lets the session importer count imported vs skipped.
 *
 * New optional fields:
 *   ts            unix seconds; defaults to now (session importer passes the message time)
 *   request_id    cross-source dedup key (upstream msg_/chatcmpl_ id, or synthesized)
 *   data_source   'proxy' | 'session-claude' | 'session-codex' | 'session-gemini'
 *   session_id, status_code, error, is_streaming, latency_ms, first_token_ms
 */
function record({ api_key, app_id, model, provider_id, tier, tokens,
                  input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
                  ts, request_id, data_source, session_id, status_code, error,
                  is_streaming, latency_ms, first_token_ms } = {}) {
  if (!db || !_insertStmt) return false;
  try {
    const inTok   = input_tokens        || 0;
    const outTok  = output_tokens       || 0;
    const total   = (tokens != null) ? tokens : (inTok + outTok);
    const info = _insertStmt.run(
      (ts != null) ? ts : Math.floor(Date.now() / 1000),
      api_key     || null,
      app_id      || null,
      model       || null,
      provider_id || null,
      tier        || null,
      total       || 0,
      inTok,
      outTok,
      cache_create_tokens || 0,
      cache_read_tokens   || 0,
      request_id  || null,
      data_source || null,
      session_id  || null,
      (status_code != null) ? status_code : null,
      error       || null,
      is_streaming ? 1 : 0,
      (latency_ms     != null) ? latency_ms     : null,
      (first_token_ms != null) ? first_token_ms : null,
    );
    return info.changes > 0; // 0 = deduped by request_id unique index
  } catch (e) {
    console.error('[local-stats] record failed:', e.message);
    return false;
  }
}

/** Read incremental-scan state for a session file. Returns {mtime, size} or null. */
function getImportState(filePath) {
  if (!db || !_getImportStateStmt) return null;
  try { return _getImportStateStmt.get(filePath) || null; }
  catch { return null; }
}

/** Persist incremental-scan state for a session file after importing it. */
function setImportState(filePath, mtime, size) {
  if (!db || !_setImportStateStmt) return;
  try { _setImportStateStmt.run(filePath, mtime, size); }
  catch (e) { console.error('[local-stats] setImportState failed:', e.message); }
}

/** Returns aggregated dashboard data for the last `days` calendar days. */
function queryDashboard(days = 1) {
  if (!db) return _empty();

  const DAY_S = 86400;
  const since = Math.floor(Date.now() / 1000) - days * DAY_S;

  // Today's midnight (local time) for hourly trend
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const todaySince = Math.floor(midnight.getTime() / 1000);

  // Total calls + tokens
  const tot = db.prepare(
    'SELECT COUNT(*) AS calls, SUM(tokens) AS tokens FROM requests WHERE ts >= ?'
  ).get(since);

  // Tier breakdown
  const tierRows = db.prepare(
    "SELECT tier, COUNT(*) AS calls FROM requests WHERE ts >= ? GROUP BY tier"
  ).all(since);
  const tiers = { free: 0, p2p: 0, paid: 0 };
  for (const r of tierRows) if (r.tier in tiers) tiers[r.tier] = r.calls;

  // Hourly trend — today only
  const hourlyRows = db.prepare(
    "SELECT CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) AS h, COUNT(*) AS calls " +
    "FROM requests WHERE ts >= ? GROUP BY h"
  ).all(todaySince);
  const hourly = Array(24).fill(0);
  for (const r of hourlyRows) hourly[r.h] = r.calls;

  // Model ranking
  const models = db.prepare(
    'SELECT model, COUNT(*) AS calls, SUM(tokens) AS tokens FROM requests ' +
    'WHERE ts >= ? AND model IS NOT NULL GROUP BY model ORDER BY calls DESC'
  ).all(since);

  // Per-key stats
  const keys = db.prepare(
    'SELECT api_key, COUNT(*) AS calls, SUM(tokens) AS tokens FROM requests ' +
    'WHERE ts >= ? AND api_key IS NOT NULL GROUP BY api_key ORDER BY calls DESC'
  ).all(since);

  // Per-provider with tier (for donut chart)
  const providers = db.prepare(
    'SELECT provider_id, tier, COUNT(*) AS calls FROM requests ' +
    'WHERE ts >= ? AND provider_id IS NOT NULL GROUP BY provider_id ORDER BY calls DESC'
  ).all(since);

  return {
    total_calls:  tot.calls  || 0,
    total_tokens: tot.tokens || 0,
    tiers,
    hourly,
    models:    models.map(r => ({ model: r.model, calls: r.calls, tokens: r.tokens || 0 })),
    keys:      keys.map(r => ({ api_key: r.api_key, calls: r.calls, tokens: r.tokens || 0 })),
    providers: providers.map(r => ({ id: r.provider_id, tier: r.tier, calls: r.calls })),
  };
}

function _empty() {
  return {
    total_calls: 0, total_tokens: 0,
    tiers: { free: 0, p2p: 0, paid: 0 },
    hourly: Array(24).fill(0),
    models: [], keys: [], providers: [],
  };
}

function close() {
  if (db) {
    db.close();
    db = null;
    _insertStmt = null;
    _getImportStateStmt = null;
    _setImportStateStmt = null;
  }
}

/** 按 api_key 查单个应用的统计（api-key 类 app）。*/
function queryByApiKey(apiKey) {
  if (!db || !apiKey) return { calls: 0, tokens: 0, lastTs: null };
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens) AS tokens, MAX(ts) AS lastTs ' +
      'FROM requests WHERE api_key = ?'
    ).get(apiKey);
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

/**
 * 按稳定的 app_id 查单个应用的统计（api-key 类 app）。
 * 统计跟着应用走，不受 api_key 变化 / 取消重新纳管影响（与 shim 用 data_source 同理）。
 * 兼容旧数据：旧行没有 app_id（NULL），用 api_key 兜底匹配（且避免与新行重复计）。
 */
function queryByApp(appId, apiKey) {
  if (!db || (!appId && !apiKey)) return { calls: 0, tokens: 0, lastTs: null };
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens) AS tokens, MAX(ts) AS lastTs ' +
      'FROM requests WHERE app_id = ? OR (app_id IS NULL AND api_key = ?)'
    ).get(appId || null, apiKey || null);
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

/** 按 data_source 查单个工具的统计（shim 类 app 用 session-claude / session-codex 等）。*/
function queryByDataSource(dataSource) {
  if (!db || !dataSource) return { calls: 0, tokens: 0, lastTs: null };
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens) AS tokens, MAX(ts) AS lastTs ' +
      'FROM requests WHERE data_source = ?'
    ).get(dataSource);
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

module.exports = { init, record, queryDashboard, queryByApiKey, queryByApp, queryByDataSource, getImportState, setImportState, close };
