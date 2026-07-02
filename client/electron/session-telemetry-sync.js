'use strict';
// 统一：先导入 Cursor hook 事件，再增量扫会话文件（与明细/列表查询口径一致）。

const sessionImport = require('./session-import');
const cursorHooks = require('./cursor-hooks');
const { computeImportSkip } = require('../shared/telemetry');

/**
 * @returns {{ hookImported: number, sessionImported: number }}
 */
function syncSessionTelemetry(localStats) {
  let hookImported = 0;
  let sessionImported = 0;
  try {
    hookImported = cursorHooks.importEvents(localStats);
    const r = sessionImport.run(localStats, { skip: computeImportSkip() });
    sessionImported = (r && r.imported) || 0;
    // transcript 行常无 usage → 0 token 占位；hook 纳管后以 hook 为准，清掉 cursor:… 脏行
    cursorHooks.purgeTranscriptZeroTokens(localStats);
  } catch (e) {
    console.error('[session-telemetry]', e.message);
  }
  return { hookImported, sessionImported };
}

module.exports = { syncSessionTelemetry };
