// client/electron/local-stats.js
// Per-device request statistics stored in SQLite.
// Call init(dbDir) once before record() or queryDashboard().
'use strict';

let db = null;
let _insertStmt = null;
let _getImportStateStmt = null;
let _setImportStateStmt = null;

// 盘点费用口径：仅 api-key 计费 + provider 刊例价（无刊例价则为 0）
const { estimatePaygCost, estimateCost } = require('./pricing');
const { resolvePricingProviderId } = require('./billing-config');

/** 按 provider/model 聚合 token 后重算按量刊例价（不读库内 cost_usd，避免全局兜底价） */
function _queryPaygCostMaps(where, params) {
  const empty = { total: 0, byModel: {}, byProviderTier: {} };
  if (!db) return empty;
  try {
    const rows = db.prepare(
      `SELECT provider_id, tier, model,
        SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok,
        SUM(cache_create_tokens) AS cCreate, SUM(cache_read_tokens) AS cRead
       FROM requests WHERE ${where} AND billing_type = 'api-key'
       GROUP BY provider_id, tier, model`
    ).all(params);
    const byModel = {};
    const byProviderTier = {};
    let total = 0;
    for (const r of rows) {
      const c = estimatePaygCost(
        r.model, r.inTok || 0, r.outTok || 0, r.cCreate || 0, r.cRead || 0,
        resolvePricingProviderId(r.provider_id),
      );
      total += c;
      if (r.model) byModel[r.model] = (byModel[r.model] || 0) + c;
      if (r.provider_id != null) {
        const key = `${r.provider_id}|${r.tier || ''}`;
        byProviderTier[key] = (byProviderTier[key] || 0) + c;
      }
    }
    return { total, byModel, byProviderTier };
  } catch (e) {
    console.error('[local-stats] _queryPaygCostMaps failed:', e.message);
    return empty;
  }
}

// 注：展示用「token 总量」= input+output+cache_create+cache_read（与 cc-switch real_total 一致）。
// Claude 重度用 prompt-cache 时量都在 cache_read，只算 input+output 会显示成 0/极小，故求和必须含 cache_*。
// tokens 列仍存 input+output（历史兼容），但所有展示查询改为按四列实时求和。
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

  -- 会话管理叠加层：收藏 / 标签 / 备注 / 归档（不碰 agent 原始 JSONL）。
  CREATE TABLE IF NOT EXISTS session_meta (
    agent_id   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    favorite   INTEGER DEFAULT 0,
    tags       TEXT DEFAULT '',
    note       TEXT DEFAULT '',
    archived   INTEGER DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (agent_id, session_id)
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
  'ALTER TABLE requests ADD COLUMN cost_usd     REAL',
  'ALTER TABLE requests ADD COLUMN billing_type TEXT',
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
      ' request_id, data_source, session_id, status_code, error, is_streaming, latency_ms, first_token_ms, cost_usd, billing_type) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?)'
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
                  is_streaming, latency_ms, first_token_ms,
                  cost_usd, billing_type } = {}) {
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
      (cost_usd       != null) ? cost_usd       : null,
      billing_type  || null,
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

/** 不参与「模型排行」的 data_source（Cursor 等无真实 model，只有工具标签） */
function dataSourcesWithoutModelStats() {
  try {
    return (require('./config-loader').sessionSources() || [])
      .filter(s => s.model_stats === false || s.record_label === 'assistant_tools')
      .map(s => s.data_source)
      .filter(Boolean);
  } catch { return []; }
}

/** Returns aggregated dashboard data for the last `days` calendar days. */
function queryDashboard(days = 1) {
  if (!db) return _empty();

  const DAY_S = 86400;
  const todaySince = todaySinceTs();
  // days=1 对齐「今日」口径（本地 0 点至今），与应用列表 apps:stats 一致；多日仍用滚动窗口
  const since = days === 1 ? todaySince : Math.floor(Date.now() / 1000) - days * DAY_S;

  // Total calls + tokens
  const tot = db.prepare(
    'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests WHERE ts >= ?'
  ).get(since);

  // Cost total for period
  const costRow = db.prepare(
    'SELECT SUM(cost_usd) AS total_cost FROM requests WHERE ts >= ?'
  ).get(since);

  // Agent/tool source breakdown by data_source
  const agentRows = db.prepare(
    "SELECT data_source, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests " +
    "WHERE ts >= ? AND data_source IS NOT NULL GROUP BY data_source ORDER BY calls DESC"
  ).all(since);

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

  // Model ranking（排除 Cursor 等无 model 的会话源，避免 Read/Shell 等工具名误入）
  const excludeModelDs = dataSourcesWithoutModelStats();
  let modelSql =
    'SELECT model, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests ' +
    'WHERE ts >= ? AND model IS NOT NULL';
  if (excludeModelDs.length) {
    modelSql += ` AND (data_source IS NULL OR data_source NOT IN (${excludeModelDs.map(() => '?').join(',')}))`;
  }
  modelSql += ' GROUP BY model ORDER BY calls DESC';
  const models = db.prepare(modelSql).all(since, ...excludeModelDs);

  // Models that have ANY proxy request → 网关; others → 直连
  const modelGwSql =
    "SELECT DISTINCT model FROM requests WHERE ts >= ? AND model IS NOT NULL AND data_source = 'proxy'";
  const modelGwSet = new Set(db.prepare(modelGwSql).all(since).map(r => r.model));

  // 按量刊例价：仅 api-key + provider 有配置刊例价才计入
  let paygWhere = 'ts >= ?';
  const paygParams = { since };
  let paygModelWhere = 'ts >= ? AND model IS NOT NULL';
  const paygModelParams = [since];
  if (excludeModelDs.length) {
    const dsClause = ` AND (data_source IS NULL OR data_source NOT IN (${excludeModelDs.map(() => '?').join(',')}))`;
    paygModelWhere += dsClause;
    paygModelParams.push(...excludeModelDs);
  }
  const paygAll = _queryPaygCostMaps('ts >= @since', paygParams);
  const paygModels = _queryPaygCostMaps(paygModelWhere, paygModelParams);

  // Per-key stats
  const keys = db.prepare(
    'SELECT api_key, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests ' +
    'WHERE ts >= ? AND api_key IS NOT NULL GROUP BY api_key ORDER BY calls DESC'
  ).all(since);

  // Per-provider with tier + 按量费用（仅 provider 刊例价）
  const providers = db.prepare(
    'SELECT provider_id, tier, COUNT(*) AS calls, ' +
    'SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens ' +
    'FROM requests ' +
    'WHERE ts >= ? AND provider_id IS NOT NULL GROUP BY provider_id, tier ORDER BY calls DESC'
  ).all(since);

  return {
    total_calls:  tot.calls  || 0,
    total_tokens: tot.tokens || 0,
    total_cost:    costRow.total_cost || 0,
    agent_sources: agentRows.map(r => ({ source: r.data_source, calls: r.calls, tokens: r.tokens || 0 })),
    tiers,
    hourly,
    models:    models.map(r => ({
      model: r.model, calls: r.calls, tokens: r.tokens || 0,
      cost_usd: paygModels.byModel[r.model] || 0,
      tier: modelGwSet.has(r.model) ? 'proxy' : null,
    })),
    keys:      keys.map(r => ({ api_key: r.api_key, calls: r.calls, tokens: r.tokens || 0 })),
    providers: providers.map(r => ({
      id: r.provider_id, tier: r.tier, calls: r.calls, tokens: r.tokens || 0,
      cost_usd: paygAll.byProviderTier[`${r.provider_id}|${r.tier || ''}`] || 0,
    })),
    payg_usage_cost: paygAll.total,
  };
}

function _empty() {
  return {
    total_calls: 0, total_tokens: 0, total_cost: 0,
    tiers: { free: 0, p2p: 0, paid: 0 },
    hourly: Array(24).fill(0),
    models: [], keys: [], providers: [], agent_sources: [],
    payg_usage_cost: 0,
  };
}

/**
 * 单个应用的用量明细（合并 proxy 实时 + session-* 会话补录，靠 request_id 已在写入时去重）。
 * 归属规则（与 queryByApp 一致，三路 OR、互不重复计）：
 *   - app_id 命中（新数据，最准）
 *   - 旧数据按 api_key 兜底（app_id 为空）
 *   - shim 应用「不走网关、直连官方」的部分按 data_source（session-claude/codex/gemini）
 * 返回：总计 / 来源拆分(网关 vs 会话) / 按模型 / 按会话(session_id) / 最近明细。
 */
function queryAppDetail({ appId, apiKey, dataSource, days = 30, limit = 50 } = {}) {
  const empty = { total: { calls: 0, tokens: 0, inTok: 0, outTok: 0, lastTs: null, totalCost: 0 }, bySource: [], byModel: [], sessions: [], recent: [] };
  if (!db) return empty;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const where =
    '(' +
    '(@appId IS NOT NULL AND app_id = @appId) OR ' +
    '(@apiKey IS NOT NULL AND app_id IS NULL AND api_key = @apiKey) OR ' +
    '(@dataSource IS NOT NULL AND data_source = @dataSource)' +
    ') AND ts >= @since';
  const p = { appId: appId || null, apiKey: apiKey || null, dataSource: dataSource || null, since };
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, MAX(ts) AS lastTs, ` +
      `SUM(cost_usd) AS totalCost FROM requests WHERE ${where}`
    ).get(p);
    const bySource = db.prepare(
      `SELECT CASE WHEN data_source='proxy' THEN 'proxy' ELSE 'session' END AS src, ` +
      `COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests WHERE ${where} GROUP BY src`
    ).all(p);
    const byModel = db.prepare(
      `SELECT model, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens FROM requests ` +
      `WHERE ${where} AND model IS NOT NULL GROUP BY model ORDER BY calls DESC`
    ).all(p);
    const sessions = db.prepare(
      `SELECT session_id, COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM requests ` +
      `WHERE ${where} AND session_id IS NOT NULL GROUP BY session_id ORDER BY lastTs DESC LIMIT @lim`
    ).all({ ...p, lim: limit });
    const recent = db.prepare(
      `SELECT ts, model, input_tokens AS inTok, output_tokens AS outTok, (input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `data_source AS source, status_code, session_id, provider_id, cost_usd, billing_type, latency_ms FROM requests ` +
      `WHERE ${where} ORDER BY ts DESC LIMIT @lim`
    ).all({ ...p, lim: limit });
    return {
      total: { calls: total.calls || 0, tokens: total.tokens || 0, inTok: total.inTok || 0, outTok: total.outTok || 0, lastTs: total.lastTs || null, totalCost: total.totalCost || 0 },
      bySource: bySource.map(r => ({ source: r.src, calls: r.calls, tokens: r.tokens || 0 })),
      byModel: byModel.map(r => ({ model: r.model, calls: r.calls, tokens: r.tokens || 0 })),
      sessions: sessions.map(r => ({ session_id: r.session_id, calls: r.calls, tokens: r.tokens || 0, firstTs: r.firstTs, lastTs: r.lastTs })),
      recent: recent.map(r => ({ ts: r.ts, model: r.model, inTok: r.inTok || 0, outTok: r.outTok || 0, tokens: r.tokens || 0, source: r.source, status_code: r.status_code, session_id: r.session_id, provider_id: r.provider_id, cost_usd: r.cost_usd || 0, billing_type: r.billing_type || null, latency_ms: r.latency_ms || null })),
    };
  } catch (e) { console.error('[local-stats] queryAppDetail failed:', e.message); return empty; }
}

/** 单会话 DB 汇总（Trace 顶栏 Token / 持续时间 / 费用补全） */
function querySessionDetail(sessionId) {
  if (!db || !sessionId) return null;
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS calls, SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ` +
      `SUM(cache_read_tokens) AS cached, MIN(ts) AS firstTs, MAX(ts) AS lastTs ` +
      `FROM requests WHERE session_id = @sid`
    ).get({ sid: sessionId });
    if (!row) return null;
    const costRows = db.prepare(
      `SELECT model, provider_id, SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ` +
      `SUM(cache_create_tokens) AS cCreate, SUM(cache_read_tokens) AS cRead, SUM(cost_usd) AS storedCost ` +
      `FROM requests WHERE session_id = @sid GROUP BY model, provider_id`
    ).all({ sid: sessionId });
    let cost_usd = 0;
    for (const r of costRows) cost_usd += _sessionCostPart(r);
    return { ...row, cost_usd };
  } catch (e) {
    console.error('[local-stats] querySessionDetail failed:', e.message);
    return null;
  }
}

/** 按 session_id + model 聚合 token 估算费用（库内 cost_usd 为 0 时用刊例价重算） */
function _sessionCostPart(row) {
  const stored = row.storedCost || 0;
  if (stored > 0) return stored;
  return estimateCost(
    row.model,
    row.inTok || 0,
    row.outTok || 0,
    row.cCreate || 0,
    row.cRead || 0,
    resolvePricingProviderId(row.provider_id),
  );
}

/** 全库按 session_id 聚合用量与费用（供会话列表合并 DB 统计） */
function querySessionStatsMap() {
  if (!db) return {};
  try {
    const agg = db.prepare(
      `SELECT session_id, COUNT(*) AS calls, ` +
      `SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `MAX(ts) AS lastTs FROM requests WHERE session_id IS NOT NULL GROUP BY session_id`
    ).all();
    const costRows = db.prepare(
      `SELECT session_id, model, provider_id, ` +
      `SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ` +
      `SUM(cache_create_tokens) AS cCreate, SUM(cache_read_tokens) AS cRead, ` +
      `SUM(cost_usd) AS storedCost ` +
      `FROM requests WHERE session_id IS NOT NULL ` +
      `GROUP BY session_id, model, provider_id`
    ).all();
    const costBySid = {};
    for (const r of costRows) {
      if (!r.session_id) continue;
      costBySid[r.session_id] = (costBySid[r.session_id] || 0) + _sessionCostPart(r);
    }
    const out = {};
    for (const r of agg) {
      if (!r.session_id) continue;
      out[r.session_id] = {
        calls: r.calls || 0,
        tokens: r.tokens || 0,
        lastTs: r.lastTs || null,
        cost_usd: costBySid[r.session_id] || 0,
      };
    }
    return out;
  } catch (e) {
    console.error('[local-stats] querySessionStatsMap failed:', e.message);
    return {};
  }
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
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, MAX(ts) AS lastTs ' +
      'FROM requests WHERE api_key = ?'
    ).get(apiKey);
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

/**
 * 按稳定的 app_id 查单个应用的统计（api-key 类 app）。
 * 统计跟着应用走，不受 api_key 变化 / 取消重新纳管影响（与 shim 用 data_source 同理）。
 * 兼容旧数据：旧行没有 app_id（NULL），用 api_key 兜底匹配（且避免与新行重复计）。
 * dataSource 可选：并入该应用的会话补录用量（如 Claude Desktop 的 Cowork/Code 本地用量
 * = session-claude-desktop）。三路 OR 互斥、SQL 一行只计一次，不会重复计。
 */
function queryByApp(appId, apiKey, dataSource) {
  if (!db || (!appId && !apiKey && !dataSource)) return { calls: 0, tokens: 0, lastTs: null };
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, MAX(ts) AS lastTs ' +
      'FROM requests WHERE app_id = @appId OR (app_id IS NULL AND api_key = @apiKey)' +
      (dataSource ? ' OR data_source = @ds' : '')
    ).get({ appId: appId || null, apiKey: apiKey || null, ds: dataSource || null });
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

/** 本地时区当天 0 点（unix 秒） */
function todaySinceTs() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.floor(midnight.getTime() / 1000);
}

/** 今日 Token 汇总（上行 input / 下行 output），供托盘与状态栏轻量查询 */
function queryTodaySummary() {
  const empty = { inTok: 0, outTok: 0, totalTokens: 0, calls: 0 };
  if (!db) return empty;
  try {
    const since = todaySinceTs();
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok, ' +
      'SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS totalTokens ' +
      'FROM requests WHERE ts >= ?'
    ).get(since);
    return {
      inTok: r.inTok || 0,
      outTok: r.outTok || 0,
      totalTokens: r.totalTokens || 0,
      calls: r.calls || 0,
    };
  } catch (e) {
    console.error('[local-stats] queryTodaySummary failed:', e.message);
    return empty;
  }
}

/** 时间窗口内单个应用用量（与 queryAppDetail / apps:stats 归属规则一致） */
function queryAppStatsInPeriod({ appId, apiKey, dataSource, days = 30, since: sinceTs } = {}) {
  const empty = {
    calls: 0, tokens: 0, cost: 0, lastTs: null,
    proxyCalls: 0, sessionCalls: 0, proxyTokens: 0, sessionTokens: 0,
  };
  if (!db || (!appId && !apiKey && !dataSource)) return empty;
  const since = sinceTs != null ? sinceTs : Math.floor(Date.now() / 1000) - days * 86400;
  const where =
    '(' +
    '(@appId IS NOT NULL AND app_id = @appId) OR ' +
    '(@apiKey IS NOT NULL AND app_id IS NULL AND api_key = @apiKey) OR ' +
    '(@dataSource IS NOT NULL AND data_source = @dataSource)' +
    ') AND ts >= @since';
  const p = { appId: appId || null, apiKey: apiKey || null, dataSource: dataSource || null, since };
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, ` +
      `MAX(ts) AS lastTs FROM requests WHERE ${where}`
    ).get(p);
    const paygCost = _queryPaygCostMaps(`${where}`, p).total;
    const bySource = db.prepare(
      `SELECT CASE WHEN data_source='proxy' THEN 'proxy' ELSE 'session' END AS src, ` +
      `COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens ` +
      `FROM requests WHERE ${where} GROUP BY src`
    ).all(p);
    const proxy = bySource.find(r => r.src === 'proxy') || {};
    const session = bySource.find(r => r.src === 'session') || {};
    return {
      calls: total.calls || 0,
      tokens: total.tokens || 0,
      cost: paygCost,
      lastTs: total.lastTs || null,
      proxyCalls: proxy.calls || 0,
      sessionCalls: session.calls || 0,
      proxyTokens: proxy.tokens || 0,
      sessionTokens: session.tokens || 0,
    };
  } catch (e) {
    console.error('[local-stats] queryAppStatsInPeriod failed:', e.message);
    return empty;
  }
}

/** 当天（本地 0 点至今）请求/Token；lastTs 为历史最近使用时间（不限当天） */
function queryAppStatsToday({ appId, apiKey, dataSource } = {}) {
  const today = queryAppStatsInPeriod({ appId, apiKey, dataSource, since: todaySinceTs() });
  let lastTs = null;
  if (db && (appId || apiKey || dataSource)) {
    try {
      const where =
        '(' +
        '(@appId IS NOT NULL AND app_id = @appId) OR ' +
        '(@apiKey IS NOT NULL AND app_id IS NULL AND api_key = @apiKey) OR ' +
        '(@dataSource IS NOT NULL AND data_source = @dataSource)' +
        ')';
      const p = { appId: appId || null, apiKey: apiKey || null, dataSource: dataSource || null };
      const r = db.prepare(`SELECT MAX(ts) AS lastTs FROM requests WHERE ${where}`).get(p);
      lastTs = r.lastTs || null;
    } catch { /* ignore */ }
  }
  return { calls: today.calls, tokens: today.tokens, lastTs };
}

/** 按 data_source 查单个工具的统计（shim 类 app 用 session-claude / session-codex 等）。*/
function queryByDataSource(dataSource) {
  if (!db || !dataSource) return { calls: 0, tokens: 0, lastTs: null };
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS calls, SUM(input_tokens+output_tokens+cache_create_tokens+cache_read_tokens) AS tokens, MAX(ts) AS lastTs ' +
      'FROM requests WHERE data_source = ?'
    ).get(dataSource);
    return { calls: r.calls || 0, tokens: r.tokens || 0, lastTs: r.lastTs || null };
  } catch { return { calls: 0, tokens: 0, lastTs: null }; }
}

// 一次性迁移用：删除指定 data_source 的会话记录 + 清掉匹配文件的导入状态，
// 让 session-import 重扫这些文件、按新规则（entrypoint）重新归属。proxy 实时记录不受影响。
function resetSessionData(dataSources, pathLike) {
  if (!db) return;
  try {
    if (Array.isArray(dataSources) && dataSources.length) {
      const ph = dataSources.map(() => '?').join(',');
      db.prepare(`DELETE FROM requests WHERE data_source IN (${ph})`).run(...dataSources);
    }
    if (pathLike) db.prepare('DELETE FROM import_state WHERE path LIKE ?').run(pathLike);
  } catch (e) { console.error('[local-stats] resetSessionData failed:', e.message); }
}

/** 列出所有会话叠加层元数据（供聚合 left-join）。 */
function listSessionMeta() {
  if (!db) return [];
  try {
    return db.prepare(
      'SELECT agent_id, session_id, favorite, tags, note, archived FROM session_meta'
    ).all();
  } catch (e) {
    console.error('[local-stats] listSessionMeta failed:', e.message);
    return [];
  }
}

/** 读取单条会话元数据。 */
function getSessionMeta(agent_id, session_id) {
  if (!db) return null;
  try {
    return db.prepare(
      'SELECT agent_id, session_id, favorite, tags, note, archived FROM session_meta WHERE agent_id = ? AND session_id = ?'
    ).get(agent_id, session_id) || null;
  } catch (e) {
    console.error('[local-stats] getSessionMeta failed:', e.message);
    return null;
  }
}

/** Upsert 会话元数据；仅写入传入的字段，其余沿用旧值。返回合并后的行。 */
function setSessionMeta({ agent_id, session_id, favorite, tags, note, archived } = {}) {
  if (!db || !agent_id || !session_id) return null;
  try {
    const prev = getSessionMeta(agent_id, session_id) || {};
    const next = {
      favorite: favorite != null ? (favorite ? 1 : 0) : (prev.favorite || 0),
      tags:     tags != null ? (Array.isArray(tags) ? tags.join(',') : String(tags)) : (prev.tags || ''),
      note:     note != null ? String(note) : (prev.note || ''),
      archived: archived != null ? (archived ? 1 : 0) : (prev.archived || 0),
    };
    db.prepare(
      'INSERT INTO session_meta (agent_id, session_id, favorite, tags, note, archived, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?) ' +
      'ON CONFLICT(agent_id, session_id) DO UPDATE SET ' +
      'favorite=excluded.favorite, tags=excluded.tags, note=excluded.note, ' +
      'archived=excluded.archived, updated_at=excluded.updated_at'
    ).run(agent_id, session_id, next.favorite, next.tags, next.note, next.archived, Date.now());
    return getSessionMeta(agent_id, session_id);
  } catch (e) {
    console.error('[local-stats] setSessionMeta failed:', e.message);
    return null;
  }
}

module.exports = {
  init, record, queryDashboard, queryTodaySummary, queryByApiKey, queryByApp, queryByDataSource,
  queryAppDetail, queryAppStatsInPeriod, queryAppStatsToday, querySessionDetail, querySessionStatsMap,
  getImportState, setImportState, resetSessionData, close,
  listSessionMeta, getSessionMeta, setSessionMeta,
};
