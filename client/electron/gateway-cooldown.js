'use strict';
// 网关失败候选「冷却表」：某候选(源/模型)发生硬失败——429 配额耗尽 / 401·403 鉴权 / 402 欠费——后
// 记入冷却；failover 时把冷却中的候选「下沉」到候选列表末尾（不删除），fresh 的先试、一旦成功即返回，
// 从而避免每次请求都对一个必失败的上游空跑一次往返（省延迟）。全 fresh 失败才轮到冷却项兜底（优雅降级）。
//
// 冷却时长：
//  - 429 且消息带「reset at <时间>」→ 冷却到该时刻(+缓冲)，并持久化到磁盘（reset 可能好几天后，重启不丢）
//  - 429/配额 无 reset      → 默认短冷却（内存）
//  - 401/403 鉴权 / 402 欠费 → 中等冷却（内存）
// 成功一次即清除该键（源恢复/配额提前重置/凭证修好 → 立刻回到正常序）。
// 键的粒度由调用方决定：单账号直连源用 provider.id（整源冷却）；p2p 各 worker 独立，用 provider.id::model。

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.tokenbank', 'gateway-cooldown.json');

const TRANSIENT_MS     = 45_000;               // 瞬时限流(429 但非配额耗尽)：几十秒就恢复，短冷却
const QUOTA_DEFAULT_MS = 10 * 60_000;          // 配额耗尽但拿不到精确 reset
const AUTH_MS          = 30 * 60_000;          // 401/403 鉴权
const CREDIT_MS        = 30 * 60_000;          // 402 欠费
const RESET_BUFFER_MS  = 30_000;               // reset 时刻 + 缓冲，避免边界抖动
const PERSIST_MIN_MS   = 2 * 60_000;           // reset 距今 > 2min 才算配额级并落盘；短 Retry-After 视为瞬时
const MAX_MS           = 35 * 24 * 60 * 60_000; // 冷却上限 35 天，覆盖月度配额 reset，同时防解析出离谱时间把源永久拉黑

const _map = new Map();   // key -> { until, status, reason, persist }

// 从上游错误消息解析配额重置时刻 → epoch ms。识别形如 "reset at 2026-07-15 23:59:59 +0800 CST"。
function parseResetMs(message, now = Date.now()) {
  const m = String(message || '');
  const g = /reset(?:\s+at)?\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})?/i.exec(m);
  if (!g) return null;
  const [, date, time, offH, offM] = g;
  const t = Date.parse(`${date}T${time}${offH}:${offM || '00'}`);
  if (!Number.isFinite(t) || t <= now) return null;
  return Math.min(t, now + MAX_MS);
}

// 解析 openai 风格时长字符串（"6m0s"、"1.5s"、"2h3m"）→ 毫秒。
function _parseDurationMs(s) {
  const g = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(String(s).trim());
  if (!g || (!g[1] && !g[2] && !g[3])) return null;
  return ((+g[1] || 0) * 3600 + (+g[2] || 0) * 60 + (+g[3] || 0)) * 1000;
}

// Retry-After：整数秒(相对) 或 HTTP-date(绝对) → epoch ms。
function _parseRetryAfter(v, now) {
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return now + Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > now ? t : null;
}

// 通用 *-reset 头：RFC3339 时间戳 / unix 秒 / 相对秒 / 时长串 → epoch ms。
function _parseResetHeader(v, now) {
  const s = String(v).trim();
  if (/[T ]\d{2}:\d{2}/.test(s) || /(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s); if (Number.isFinite(t) && t > now) return t;
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e9) return n * 1000;        // unix epoch 秒
    if (n > 0)   return now + n * 1000;  // 相对秒
  }
  const dur = _parseDurationMs(s);
  return dur != null ? now + dur : null;
}

// 从上游响应头解析限流/配额重置时刻 → epoch ms。优先 Retry-After，其次 anthropic/openai 的 *-reset。
function parseResetFromHeaders(headers, now = Date.now()) {
  if (!headers || typeof headers !== 'object') return null;
  const h = {};
  for (const k in headers) h[k.toLowerCase()] = headers[k];
  const order = [
    ['retry-after', _parseRetryAfter],
    ['anthropic-ratelimit-unified-reset', _parseResetHeader],
    ['anthropic-ratelimit-requests-reset', _parseResetHeader],
    ['anthropic-ratelimit-tokens-reset', _parseResetHeader],
    ['x-ratelimit-reset-requests', _parseResetHeader],
    ['x-ratelimit-reset-tokens', _parseResetHeader],
    ['x-ratelimit-reset', _parseResetHeader],
  ];
  for (const [name, fn] of order) {
    if (h[name] != null) { const ms = fn(h[name], now); if (ms) return Math.min(ms, now + MAX_MS); }
  }
  return null;
}

// 判断错误是否属于纳入冷却的「硬失败」，返回 { until, status, reason, persist } 或 null（不冷却）。
// 关键：429 分级——带 reset 时间(响应头/正文)或配额关键词才算「配额耗尽」长冷却；纯瞬时限流只短冷却，
// 避免把突发限流的源误沉底几分钟。reset 距今 > 2min 才落盘（短 Retry-After 视为瞬时，不持久）。
function classify(err, now = Date.now()) {
  const status = err && err.status;
  const msg = String((err && err.message) || '');
  const is = (code) => status === code || new RegExp(`HTTP_${code}\\b`).test(msg);
  const isRate  = is(429) || /rate[\s_-]?limit|too many requests|overloaded/i.test(msg);
  const isQuota = /quota|exceeded your current quota|usage limit|monthly|daily|out of (?:quota|credit)/i.test(msg);
  if (isRate || isQuota) {
    const reset = parseResetFromHeaders(err && err.headers, now) || parseResetMs(msg, now);
    if (reset) {
      const persist = (reset - now) > PERSIST_MIN_MS;   // 远期 reset → 配额级、落盘；近期 → 当瞬时
      return { until: reset + RESET_BUFFER_MS, status: 429, reason: persist ? 'quota-reset' : 'rate-limit', persist };
    }
    if (isQuota) return { until: now + QUOTA_DEFAULT_MS, status: 429, reason: 'quota', persist: false };
    return { until: now + TRANSIENT_MS, status: 429, reason: 'rate-limit', persist: false };
  }
  if (is(401) || is(403) || /invalid[\s_-]*api[\s_-]*key|unauthorized/i.test(msg))
    return { until: now + AUTH_MS, status: status || 401, reason: 'auth', persist: false };
  if (is(402) || /insufficient[\s_-]*credit/i.test(msg))
    return { until: now + CREDIT_MS, status: 402, reason: 'credit', persist: false };
  return null;
}

// 记一次失败。返回冷却 entry（附 _new=该键此前不在冷却，供调用方决定是否打日志）或 null（不纳入冷却）。
function noteFailure(key, err, now = Date.now()) {
  if (!key) return null;
  const c = classify(err, now);
  if (!c) return null;
  const wasCooling = isCooling(key, now);
  const entry = { until: c.until, status: c.status, reason: c.reason, persist: !!c.persist };
  _map.set(key, entry);
  if (entry.persist) _save();
  return { ...entry, _new: !wasCooling };
}

// 记一次「只短瞬时」冷却（社区源用）：无视 reset、不落盘、固定 TRANSIENT_MS。
// 仅当 err 是硬失败(429/鉴权/欠费)才记；5xx/网络等瞬时错误不记（交给单次 failover，且会自愈）。
// 目的：社区池此刻满了时避免连续空跑，但绝不长冷却/拉黑动态池里的 worker。
function noteTransient(key, err, now = Date.now()) {
  if (!key) return null;
  const c = classify(err, now);
  if (!c) return null;
  const wasCooling = isCooling(key, now);
  const entry = { until: now + TRANSIENT_MS, status: c.status, reason: 'transient', persist: false };
  _map.set(key, entry);
  return { ...entry, _new: !wasCooling };
}

function isCooling(key, now = Date.now()) {
  const e = _map.get(key);
  if (!e) return false;
  if (e.until <= now) { _map.delete(key); if (e.persist) _save(); return false; }
  return true;
}

function entryOf(key, now = Date.now()) {
  return isCooling(key, now) ? _map.get(key) : null;
}

// 成功后清除冷却（源已恢复）。
function clear(key) {
  const e = _map.get(key);
  if (!e) return;
  _map.delete(key);
  if (e.persist) _save();
}

// 把冷却中的候选下沉到末尾：返回 [...fresh(保序), ...cooled(保序)]，不删除任何项（保证永远有可试）。
function sink(items, keyFn, now = Date.now()) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length < 2) return arr.slice();
  const fresh = [], cooled = [];
  for (const it of arr) (isCooling(keyFn(it), now) ? cooled : fresh).push(it);
  return cooled.length ? [...fresh, ...cooled] : fresh;
}

// 当前冷却中的条目（供 UI/日志展示）。
function list(now = Date.now()) {
  const out = [];
  for (const [key, e] of _map) if (e.until > now) out.push({ key, until: e.until, status: e.status, reason: e.reason });
  return out;
}

let _loaded = false;
function _load() {
  if (_loaded) return; _loaded = true;
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const now = Date.now();
    if (Array.isArray(arr)) for (const e of arr)
      if (e && e.key && e.until > now) _map.set(e.key, { until: e.until, status: e.status, reason: e.reason, persist: true });
  } catch {}
}
function _save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const now = Date.now();
    const persistArr = [];
    for (const [key, e] of _map) if (e.persist && e.until > now) persistArr.push({ key, until: e.until, status: e.status, reason: e.reason });
    fs.writeFileSync(FILE, JSON.stringify(persistArr));
  } catch {}
}
_load();

module.exports = { noteFailure, noteTransient, isCooling, entryOf, clear, sink, list, parseResetMs, parseResetFromHeaders, classify, FILE };
