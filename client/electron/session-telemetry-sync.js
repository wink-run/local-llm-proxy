'use strict';
// 统一：先导入 Cursor hook 事件，再增量扫会话文件（与明细/列表查询口径一致）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const sessionImport = require('./session-import');
const cursorHooks = require('./cursor-hooks');
const { syncTraeSessions } = require('./trae-session-sync');
const { computeImportSkip } = require('../shared/telemetry');

const TRAE_TS_FIX_MARKER = path.join(os.homedir(), '.tokenbank', 'trae-sessions', '.ts-seconds-fix-v1');

/** 一次性修复：tsSeconds 曾误把 Unix 秒再除 1000，导致 session-trae-work 落在 1970 无法进今日窗口 */
function maybeFixTraeSessionTimestamps(localStats) {
  if (fs.existsSync(TRAE_TS_FIX_MARKER)) return;
  const ok = localStats.resetSessionData(['session-trae-work'], '%trae-sessions%');
  if (!ok) return;
  try {
    fs.mkdirSync(path.dirname(TRAE_TS_FIX_MARKER), { recursive: true });
    fs.writeFileSync(TRAE_TS_FIX_MARKER, '');
    console.log('[session-telemetry] trae-work session rows reset for timestamp re-import');
  } catch (e) {
    console.warn('[session-telemetry] trae ts fix marker:', e.message);
  }
}

/**
 * @param {object} localStats
 * @param {{ force?: boolean }} [opts] force=true 跳过节流（IPC 手动触发）
 * @returns {{ hookImported: number, sessionImported: number, traeSynced: number, skipped?: boolean }}
 */
let _lastTelemetrySyncAt = 0;
const TELEMETRY_SYNC_MIN_MS = 30_000; // 与主进程 30s 定时导入对齐，避免托盘/多处连点反复扫

function syncSessionTelemetry(localStats, opts = {}) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (!force && _lastTelemetrySyncAt && (now - _lastTelemetrySyncAt) < TELEMETRY_SYNC_MIN_MS) {
    return { hookImported: 0, sessionImported: 0, traeSynced: 0, skipped: true };
  }
  _lastTelemetrySyncAt = now;

  let hookImported = 0;
  let sessionImported = 0;
  let traeSynced = 0;
  try {
    hookImported = cursorHooks.importEvents(localStats);
    maybeFixTraeSessionTimestamps(localStats);
    try { traeSynced = syncTraeSessions(); } catch (e) { console.error('[trae-session-sync]', e.message); }
    const skip = computeImportSkip();
    const r = sessionImport.run(localStats, { skip });
    sessionImported = (r && r.imported) || 0;
    // transcript 行常无 usage → 0 token 占位；hook 纳管后以 hook 为准，清掉 cursor:… 脏行
    cursorHooks.purgeTranscriptZeroTokens(localStats);
    // Skill 调用增量入库（Claude Skill/slash + Codex SKILL.md 路径）
    let skillRecorded = 0;
    try {
      const skillUsage = require('./session-skill-usage');
      const sr = skillUsage.syncSkillUsage(localStats);
      skillRecorded = (sr && sr.recorded) || 0;
    } catch (e) {
      console.error('[session-telemetry] skill-usage', e.message);
    }
    console.log('[session-telemetry]', JSON.stringify({
      hookImported, sessionImported, traeSynced, skillRecorded, skip: [...skip],
    }));
  } catch (e) {
    console.error('[session-telemetry]', e.message);
  }
  return { hookImported, sessionImported, traeSynced };
}

module.exports = { syncSessionTelemetry };
