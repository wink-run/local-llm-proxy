// client/electron/session-import.js
// YAML 驱动的会话用量解释器：补录「不走本网关、直连官方」的用量。
//
// 解析规则全部来自 config-loader 的 session_sources（见 tokenbank.default.yaml）。
// 新增一个工具的会话统计 = 加一段 YAML（声明式：路径/glob/字段映射/去重键），
// 不用改这里的代码。仅两类过程式逻辑由内置开关处理：
//   - accumulate：token_count 事件携带「累计」用量 → 取相邻增量（Codex）。
//   - meta：JSONL 里的元信息行更新运行中的 model / session_id（Codex）。
//
// 去重：每条记录带 request_id，写库走 INSERT OR IGNORE。Claude 用 message.id
// （= 走网关时上游响应 id），所以「走过网关 + 又落进会话文件」的同一次调用只记一次；
// Codex/Gemini 用合成键，保证重复扫描同一文件不会重复计。
//
// 增量：用 local-stats 的 import_state 表记录每个文件的 mtime/size，未变更则跳过。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── 通用辅助 ────────────────────────────────────────────────────────────────

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 递归列出 dir 下满足 matchFn(relPath) 的文件（relPath 用 / 分隔、相对 root）。
function walk(root, matchFn) {
  const out = [];
  function rec(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) rec(full);
        else if (ent.isFile()) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (matchFn(rel)) out.push(full);
        }
      } catch { /* 跳过坏链接/权限问题 */ }
    }
  }
  rec(root);
  return out;
}

// glob → 正则：** 跨目录、* 单段（不含 /）。
function globToRe(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

function unchanged(localStats, filePath, st) {
  const prev = localStats.getImportState(filePath);
  return !!prev && prev.mtime === Math.floor(st.mtimeMs) && prev.size === st.size;
}
function markDone(localStats, filePath, st) {
  localStats.setImportState(filePath, Math.floor(st.mtimeMs), st.size);
}

function tsSeconds(isoOrMs) {
  if (isoOrMs == null) return Math.floor(Date.now() / 1000);
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function eachJsonlLine(filePath, fn) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  let idx = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    fn(obj, idx++);
  }
}

// 取 dot-path 值；pathOrList 为数组时按序取第一个「已定义」的。
function getPath(obj, pathOrList) {
  if (pathOrList == null) return undefined;
  const list = Array.isArray(pathOrList) ? pathOrList : [pathOrList];
  for (const p of list) {
    if (p == null) continue;
    const parts = String(p).split('.');
    let cur = obj, ok = true;
    for (const k of parts) {
      if (cur != null && typeof cur === 'object' && k in cur) cur = cur[k];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined) return cur;
  }
  return undefined;
}
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const isEmpty = (v) => v === undefined || v === null || v === '';

// record_filter / meta.filter 匹配。支持 { field, equals } / { field, in:[...] }，
// in 配合 allow_missing:true 时「字段缺省」也算命中。
function matchFilter(obj, f) {
  if (!f) return true;
  const v = getPath(obj, f.field);
  if ('equals' in f) return v === f.equals;
  if ('in' in f) {
    if (f.allow_missing && isEmpty(v)) return true;
    return Array.isArray(f.in) && f.in.includes(v);
  }
  if ('present' in f) return !isEmpty(v);
  return true;
}

// 模板 request_id：{session_id} {index} {seq}，其余 {x} 从当前记录按 dot-path 取。
function fillTemplate(tpl, ctx, rec) {
  return String(tpl).replace(/\{([^}]+)\}/g, (_, key) => {
    if (key === 'session_id') return ctx.session_id != null ? String(ctx.session_id) : '';
    if (key === 'index') return String(ctx.index);
    if (key === 'seq')   return String(ctx.seq);
    const v = getPath(rec, key);
    return v != null ? String(v) : '';
  });
}

// ── 单条记录的构建与写入（jsonl/json 共用）────────────────────────────────────
// rec=当前对象，ctx={ model, session_id, seq, index, prev } ，doc=整文件级回退源（json）。
// 返回 true=写入了一行新数据。
function emitRecord(localStats, src, rec, ctx, doc) {
  const f = src.fields || {};

  // 必需字段
  for (const need of (src.require_fields || [])) {
    if (getPath(rec, need) === undefined) return false;
  }

  // token 数：accumulate（累计→增量）或直接取字段
  let inTok, outTok, cCreate = 0, cRead;
  if (src.accumulate) {
    const a = src.accumulate;
    const vi = getPath(rec, a.input), vo = getPath(rec, a.output), vc = getPath(rec, a.cached);
    if (vi === undefined && vo === undefined && vc === undefined) return false;  // 无累计用量 → 不动 prev、跳过
    const cur = { input: num(vi), output: num(vo), cached: num(vc) };
    inTok = Math.max(0, cur.input  - ctx.prev.input);
    outTok = Math.max(0, cur.output - ctx.prev.output);
    cRead = Math.max(0, cur.cached - ctx.prev.cached);
    ctx.prev = cur;
  } else {
    inTok  = num(getPath(rec, f.input_tokens));
    outTok = num(getPath(rec, f.output_tokens));
    if (f.output_extra) outTok += num(getPath(rec, f.output_extra));   // 如 OpenCode 的 reasoning 并入输出
    cCreate = num(getPath(rec, f.cache_create_tokens));
    cRead  = num(getPath(rec, f.cache_read_tokens));
  }
  if (src.skip_if_zero && inTok === 0 && outTok === 0 && cCreate === 0 && cRead === 0) return false;

  // model / session_id / ts（逐级回退：当前对象 → 运行上下文 → 整文件级）
  let model = f.model ? getPath(rec, f.model) : undefined;
  if (model === undefined) model = ctx.model;
  if (model === undefined && src.doc_fallback) model = getPath(doc, src.doc_fallback.model);

  let session_id = f.session_id ? getPath(rec, f.session_id) : undefined;
  if (session_id === undefined) session_id = ctx.session_id;

  let tsv = f.ts ? getPath(rec, f.ts) : undefined;
  if (tsv === undefined && src.doc_fallback) tsv = getPath(doc, src.doc_fallback.ts);

  // request_id：模板 or 字段路径
  ctx.session_id = session_id;
  let request_id;
  if (typeof src.request_id === 'string' && src.request_id.includes('{')) {
    request_id = fillTemplate(src.request_id, ctx, rec);
  } else if (src.request_id) {
    request_id = getPath(rec, src.request_id);
  }
  if (src.require_request_id && isEmpty(request_id)) return false;

  // 按记录字段(如 entrypoint)路由 data_source：命中 skip 列表的不导入（如 sdk-cli 内部转发）；
  // 命中 map 的归到对应 data_source；否则用 default / 源默认 data_source。
  let dataSource = src.data_source;
  const dsm = src.data_source_map;
  if (dsm && dsm.field) {
    const ev = getPath(rec, dsm.field);
    if (ev != null && Array.isArray(dsm.skip) && dsm.skip.includes(ev)) return false;
    dataSource = (ev != null && dsm.map && (ev in dsm.map)) ? dsm.map[ev] : (dsm.default || src.data_source);
  }

  const ok = localStats.record({
    ts:                  tsSeconds(tsv),
    api_key:             null,
    model:               model != null ? model : null,
    provider_id:         src.provider_id || null,
    tier:                src.tier || 'paid',
    input_tokens:        inTok,
    output_tokens:       outTok,
    cache_create_tokens: cCreate,
    cache_read_tokens:   cRead,
    request_id:          request_id != null ? request_id : null,
    data_source:         dataSource,
    session_id:          session_id != null ? session_id : null,
    status_code:         200,
    is_streaming:        false,
  });
  if (ok) ctx.seq++;   // 仅写入成功才推进 seq（与旧逻辑一致）
  return ok;
}

// ── SQLite 源（如 OpenCode：~/.local/share/opencode/opencode.db）──────────────
// query 取行；json_column 那列是 JSON，解析后套用 fields/filter；行内其它标量列
// 并入记录对象（供 session_id/message_id 等字段与 request_id 模板引用）。
function importSqliteSource(localStats, src) {
  const dbPath = expandHome(src.db || '');
  let st; try { st = fs.statSync(dbPath); } catch { return { source: src.id, imported: 0, skipped: 0, files_scanned: 0 }; }
  // WAL 模式：新提交先落 -wal，主库 mtime 不变 → 取 db / -wal / -shm 的最大 mtime。
  let mtimeMs = st.mtimeMs;
  for (const ext of ['-wal', '-shm']) { try { mtimeMs = Math.max(mtimeMs, fs.statSync(dbPath + ext).mtimeMs); } catch {} }
  const synthSt = { mtimeMs, size: 0 };
  if (unchanged(localStats, dbPath, synthSt)) return { source: src.id, imported: 0, skipped: 0, files_scanned: 1 };

  let odb;
  try { odb = new (require('better-sqlite3'))(dbPath, { readonly: true, fileMustExist: true }); }
  catch (e) { return { source: src.id, imported: 0, skipped: 0, files_scanned: 1, error: e.message }; }

  let imported = 0;
  try {
    const rows = odb.prepare(src.query).all();
    const ctx = { model: undefined, session_id: undefined, seq: 0, index: 0, prev: { input: 0, output: 0, cached: 0 } };
    rows.forEach((row, idx) => {
      let rec;
      if (src.json_column) { try { rec = JSON.parse(row[src.json_column] || 'null'); } catch { return; } }
      else rec = row;
      if (rec == null || typeof rec !== 'object') return;
      // 把行里非 JSON 的标量列并进记录（不覆盖 JSON 已有键）
      for (const [k, v] of Object.entries(row)) { if (k !== src.json_column && !(k in rec)) rec[k] = v; }
      if (!matchFilter(rec, src.record_filter)) return;
      ctx.index = idx;
      if (emitRecord(localStats, src, rec, ctx, null)) imported++;
    });
  } catch (e) {
    try { odb.close(); } catch {}
    return { source: src.id, imported, skipped: 0, files_scanned: 1, error: e.message };
  }
  try { odb.close(); } catch {}
  markDone(localStats, dbPath, synthSt);
  return { source: src.id, imported, skipped: 0, files_scanned: 1 };
}

// ── 单个 source 的扫描 ────────────────────────────────────────────────────────
function importSource(localStats, src) {
  if (src.format === 'sqlite') return importSqliteSource(localStats, src);
  const root = expandHome(src.root || '');
  const re   = globToRe(src.glob || '**/*');
  const files = root ? walk(root, rel => re.test(rel)) : [];
  let imported = 0, skipped = 0, files_scanned = 0;

  for (const file of files) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (unchanged(localStats, file, st)) { skipped++; continue; }
    files_scanned++;

    const baseId = path.basename(file).replace(/\.[^.]+$/, '');

    if ((src.format || 'jsonl') === 'json') {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { markDone(localStats, file, st); continue; }
      const session_id = getPath(doc, src.doc_session_id) || baseId;
      const arr = getPath(doc, src.iterate);
      const items = Array.isArray(arr) ? arr : [];
      const ctx = { model: undefined, session_id, seq: 0, index: 0, prev: { input: 0, output: 0, cached: 0 } };
      items.forEach((item, idx) => {
        if (!matchFilter(item, src.record_filter)) return;
        ctx.index = idx;
        ctx.session_id = session_id;   // json 每条都用整文件级 session
        if (emitRecord(localStats, src, item, ctx, doc)) imported++;
      });
    } else {
      // jsonl：逐行；维护运行上下文（meta 行更新 model/session_id；accumulate 累计 prev）
      const ctx = {
        model: undefined,
        session_id: src.session_id_from === 'filename' ? baseId : undefined,
        seq: 0, index: 0, prev: { input: 0, output: 0, cached: 0 },
      };
      eachJsonlLine(file, (e, idx) => {
        ctx.index = idx;
        // meta 行：更新上下文，不产记录
        let consumed = false;
        for (const m of (src.meta || [])) {
          if (matchFilter(e, m.filter)) {
            if (m.set) for (const [k, p] of Object.entries(m.set)) {
              const v = getPath(e, p);
              if (v !== undefined) ctx[k] = v;
            }
            consumed = true;
            break;
          }
        }
        if (consumed) return;
        if (!matchFilter(e, src.record_filter)) return;
        if (emitRecord(localStats, src, e, ctx, null)) imported++;
      });
    }

    markDone(localStats, file, st);
  }
  return { source: src.id || src.data_source, imported, skipped, files_scanned };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

// 扫描 config-loader.session_sources 配置的所有来源并补录到 local-stats。
function run(localStats) {
  if (!localStats || typeof localStats.record !== 'function') {
    return { ok: false, error: 'local-stats not ready', imported: 0, sources: [] };
  }
  let defs = [];
  try { defs = require('./config-loader').sessionSources() || []; } catch {}
  const sources = [];
  for (const src of defs) {
    try { sources.push(importSource(localStats, src)); }
    catch (e) { sources.push({ source: src && src.id, imported: 0, error: e.message }); }
  }
  const imported = sources.reduce((s, r) => s + (r.imported || 0), 0);
  if (imported > 0) console.log('[session-import]', JSON.stringify(sources));
  return { ok: true, imported, sources };
}

module.exports = { run, importSource, emitRecord, matchFilter, getPath };
