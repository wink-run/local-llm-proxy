// 会话扫描 worker：在独立线程跑 list / 补录，避免卡住 Electron 主线程（页面假死）。
'use strict';

const { parentPort } = require('worker_threads');

parentPort.on('message', (msg) => {
  const id = msg && msg.id;
  const type = msg && msg.type;
  const payload = (msg && msg.payload) || {};
  try {
    if (type === 'listAll') {
      const sessionBrowser = require('./session-browser');
      parentPort.postMessage({ id, result: sessionBrowser.listAllSessions(payload) });
      return;
    }
    if (type === 'telemetry') {
      const statsDir = payload.statsDir;
      if (!statsDir) throw new Error('missing_statsDir');
      const localStats = require('./local-stats');
      localStats.init(statsDir);
      try {
        const { syncSessionTelemetry } = require('./session-telemetry-sync');
        parentPort.postMessage({
          id,
          result: syncSessionTelemetry(localStats, { force: !!payload.force }),
        });
      } finally {
        try { localStats.close(); } catch { /* ignore */ }
      }
      return;
    }
    parentPort.postMessage({ id, error: `unknown_type:${type}` });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.message) || String(e) });
  }
});
