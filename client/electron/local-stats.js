// client/electron/local-stats.js
// Per-device request statistics stored in SQLite.
// Call init(dbDir) once before record() or queryDashboard().
'use strict';

let db = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    api_key     TEXT,
    model       TEXT,
    provider_id TEXT,
    tier        TEXT,
    tokens      INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ts      ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_api_key ON requests(api_key, ts);
  CREATE INDEX IF NOT EXISTS idx_model   ON requests(model, ts);
`;

/** @param {string} dbDir  Directory that will hold local-stats.db */
function init(dbDir) {
  if (db) return;
  const fs       = require('fs');
  const path     = require('path');
  const Database = require('better-sqlite3');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  db = new Database(path.join(dbDir, 'local-stats.db'));
  db.pragma('journal_mode = WAL');  // safer concurrent reads
  db.exec(SCHEMA);
}

/** Insert one request row. Silently ignored if init() hasn't been called. */
function record({ api_key, model, provider_id, tier, tokens } = {}) {
  if (!db) return;
  db.prepare(
    'INSERT INTO requests (ts, api_key, model, provider_id, tier, tokens) VALUES (?,?,?,?,?,?)'
  ).run(
    Math.floor(Date.now() / 1000),
    api_key     || null,
    model       || null,
    provider_id || null,
    tier        || null,
    tokens      || 0,
  );
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
  if (db) { db.close(); db = null; }
}

module.exports = { init, record, queryDashboard, close };
