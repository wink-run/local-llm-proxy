'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sessionOffthread = require('../session-offthread');
const { getSessionsAsync, invalidateSessionsCache } = require('../session-manager');

test('session-offthread listAllSessions 在 worker 返回数组', async () => {
  const rows = await sessionOffthread.listAllSessions({ limit: 1, sinceDays: 1 });
  assert.ok(Array.isArray(rows));
});

test('getSessionsAsync 合并结果为数组', async () => {
  invalidateSessionsCache();
  const localStats = {
    querySessionStatsMap: () => ({}),
    listSessionMeta: () => [],
  };
  const sessionBrowser = require('../session-browser');
  const rows = await getSessionsAsync({ sessionBrowser, localStats }, { limit: 1, sinceDays: 1 });
  assert.ok(Array.isArray(rows));
});

test.after(() => {
  sessionOffthread.terminate();
});
