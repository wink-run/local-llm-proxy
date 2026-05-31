// client/electron/session-import.js
// 扫描本地 AI 编程工具的会话文件，补录那些「不走本网关、直连官方」的用量。
//
// 数据来源：
//   Claude Code  ~/.claude/projects/<proj>/<session>.jsonl（含 subagents/*.jsonl）
//   Codex        ~/.codex/sessions/YYYY/MM/DD/*.jsonl
//   Gemini CLI   ~/.gemini/tmp/<project_hash>/chats/session-*.json
//
// 去重：每条记录都带 request_id，写库走 INSERT OR IGNORE。
//   - Claude：用 message.id（msg_xxx）——这也正是请求走网关时上游响应的 id，
//     所以「走过网关 + 又落进会话文件」的同一次调用只会被记一次。
//   - Codex / Gemini：会话文件里没有稳定的上游 id，用 `codex:{session}:{seq}` /
//     `gemini:{session}:{idx}` 合成稳定键，保证重复扫描同一文件不会重复计数。
//
// 增量：用 local-stats 的 import_state 表记录每个文件的 mtime/size，未变更则跳过；
//   变更的文件整文件重扫，已记录的行靠 request_id 去重，只有新增行真正入库。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── 通用文件辅助 ────────────────────────────────────────────────────────────

// 递归列出 dir 下所有满足 matchFn(filePath) 的文件。目录不存在或不可读时返回 []。
function walk(dir, matchFn, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) walk(full, matchFn, out);
      else if (ent.isFile() && matchFn(full)) out.push(full);
    } catch { /* 跳过坏链接/权限问题 */ }
  }
  return out;
}

// 若文件自上次导入后未变更（mtime+size 相同）返回 true。
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

// 逐行读 JSONL，对每个解析成功的对象调用 fn(obj)。坏行静默跳过。
function eachJsonlLine(filePath, fn) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch { return; }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    fn(obj);
  }
}

// ── Claude Code ─────────────────────────────────────────────────────────────
// 已对照真实文件验证字段结构。

function importClaude(localStats) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = walk(root, f => f.endsWith('.jsonl'));
  let imported = 0, skipped = 0, files_scanned = 0;

  for (const file of files) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (unchanged(localStats, file, st)) { skipped++; continue; }
    files_scanned++;

    eachJsonlLine(file, (e) => {
      if (e.type !== 'assistant') return;
      const u = e.message && e.message.usage;
      if (!u) return;
      const reqId = (e.message && e.message.id) || e.requestId || null;
      if (!reqId) return; // 无稳定 id 不记，避免重复扫描时重复计
      const ok = localStats.record({
        ts:                  tsSeconds(e.timestamp),
        api_key:             null,
        model:               (e.message && e.message.model) || null,
        provider_id:         'claude-cli',
        tier:                'paid',
        input_tokens:        u.input_tokens                || 0,
        output_tokens:       u.output_tokens               || 0,
        cache_create_tokens: u.cache_creation_input_tokens || 0,
        cache_read_tokens:   u.cache_read_input_tokens      || 0,
        request_id:          reqId,
        data_source:         'session-claude',
        session_id:          e.sessionId || null,
        status_code:         200,
        is_streaming:        false,
      });
      if (ok) imported++;
    });

    markDone(localStats, file, st);
  }
  return { source: 'claude', imported, skipped, files_scanned };
}

// ── Codex ───────────────────────────────────────────────────────────────────
// 注：本机暂无 ~/.codex/sessions 样本，字段名按 Codex 会话格式的常见形态做防御式解析，
// 待有真实文件后校准。token_count 事件携带「累计」用量，需对每次调用取增量。

function importCodex(localStats) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files = walk(root, f => f.endsWith('.jsonl'));
  let imported = 0, skipped = 0, files_scanned = 0;

  // 从一个 token_count 事件里尽量抽出累计用量对象 {input, cached, output}。
  function extractCumulative(e) {
    const payload = e.payload || e;
    // 常见位置：payload.info.total_token_usage / payload.total_token_usage / payload.usage
    const c = (payload.info && payload.info.total_token_usage) ||
              payload.total_token_usage || payload.usage || null;
    if (!c) return null;
    return {
      input:  c.input_tokens  != null ? c.input_tokens  : (c.prompt_tokens || 0),
      cached: c.cached_input_tokens != null ? c.cached_input_tokens : (c.cache_read_tokens || 0),
      output: c.output_tokens != null ? c.output_tokens : (c.completion_tokens || 0),
    };
  }

  for (const file of files) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (unchanged(localStats, file, st)) { skipped++; continue; }
    files_scanned++;

    let sessionId = path.basename(file).replace(/\.jsonl$/, '');
    let model = null;
    let seq = 0;
    let prev = { input: 0, cached: 0, output: 0 };

    eachJsonlLine(file, (e) => {
      const type = e.type || (e.payload && e.payload.type);
      if (type === 'session_meta' || type === 'turn_context') {
        const p = e.payload || e;
        model = p.model || (p.info && p.info.model) || model;
        if (p.id || p.session_id) sessionId = p.id || p.session_id;
        return;
      }
      if (type !== 'event_msg' && type !== 'token_count') return;
      const payloadType = (e.payload && e.payload.type) || type;
      if (payloadType !== 'token_count') return;

      const cum = extractCumulative(e);
      if (!cum) return;
      // 取相对上一次的增量（累计 → 单次）
      const dIn  = Math.max(0, cum.input  - prev.input);
      const dCr  = Math.max(0, cum.cached - prev.cached);
      const dOut = Math.max(0, cum.output - prev.output);
      prev = cum;
      if (dIn === 0 && dOut === 0 && dCr === 0) return;

      const ok = localStats.record({
        ts:                  tsSeconds(e.timestamp || (e.payload && e.payload.timestamp)),
        api_key:             null,
        model:               model,
        provider_id:         'codex-cli',
        tier:                'paid',
        input_tokens:        dIn,
        output_tokens:       dOut,
        cache_create_tokens: 0,
        cache_read_tokens:   dCr,
        request_id:          `codex:${sessionId}:${seq++}`,
        data_source:         'session-codex',
        session_id:          sessionId,
        status_code:         200,
        is_streaming:        false,
      });
      if (ok) imported++;
    });

    markDone(localStats, file, st);
  }
  return { source: 'codex', imported, skipped, files_scanned };
}

// ── Gemini CLI ──────────────────────────────────────────────────────────────
// 注：本机暂无 ~/.gemini/tmp 样本，按 Gemini chat 会话 JSON 的常见形态做防御式解析。
// 与 Claude/Codex 不同，这里是单个 JSON（含 messages 数组），每条消息独立携带 token 数。

function importGemini(localStats) {
  const root = path.join(os.homedir(), '.gemini', 'tmp');
  const files = walk(root, f => /[/\\]chats[/\\]session-.*\.json$/.test(f));
  let imported = 0, skipped = 0, files_scanned = 0;

  for (const file of files) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (unchanged(localStats, file, st)) { skipped++; continue; }
    files_scanned++;

    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { markDone(localStats, file, st); continue; }

    const sessionId = doc.sessionId || doc.session_id || path.basename(file).replace(/\.json$/, '');
    const messages  = Array.isArray(doc.messages) ? doc.messages
                    : Array.isArray(doc.history)  ? doc.history : [];

    messages.forEach((m, idx) => {
      const role = m.role || m.type;
      if (role && role !== 'model' && role !== 'assistant') return; // 只算模型产出侧
      const um = m.tokens || m.usageMetadata || m.usage_metadata || m.usage;
      if (!um) return;
      const inTok  = um.promptTokenCount        != null ? um.promptTokenCount        : (um.input  || um.input_tokens  || 0);
      const outTok = um.candidatesTokenCount    != null ? um.candidatesTokenCount    : (um.output || um.output_tokens || 0);
      const cRead  = um.cachedContentTokenCount != null ? um.cachedContentTokenCount : (um.cached || 0);
      if (inTok === 0 && outTok === 0 && cRead === 0) return;

      const ok = localStats.record({
        ts:                  tsSeconds(m.timestamp || doc.lastUpdated || doc.updatedAt),
        api_key:             null,
        model:               m.model || doc.model || null,
        provider_id:         'gemini-cli',
        tier:                'paid',
        input_tokens:        inTok,
        output_tokens:       outTok,
        cache_create_tokens: 0,
        cache_read_tokens:   cRead,
        request_id:          `gemini:${sessionId}:${idx}`,
        data_source:         'session-gemini',
        session_id:          sessionId,
        status_code:         200,
        is_streaming:        false,
      });
      if (ok) imported++;
    });

    markDone(localStats, file, st);
  }
  return { source: 'gemini', imported, skipped, files_scanned };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

// 扫描三家会话文件并补录到 local-stats。localStats 需提供 record/getImportState/setImportState。
// 返回 { ok, imported, sources: [...] }；任一来源抛错都被隔离，不影响其它来源。
function run(localStats) {
  if (!localStats || typeof localStats.record !== 'function') {
    return { ok: false, error: 'local-stats not ready', imported: 0, sources: [] };
  }
  const sources = [];
  for (const fn of [importClaude, importCodex, importGemini]) {
    try { sources.push(fn(localStats)); }
    catch (e) { sources.push({ source: fn.name, imported: 0, error: e.message }); }
  }
  const imported = sources.reduce((s, r) => s + (r.imported || 0), 0);
  if (imported > 0) {
    console.log('[session-import]', JSON.stringify(sources));
  }
  return { ok: true, imported, sources };
}

module.exports = { run, importClaude, importCodex, importGemini };
