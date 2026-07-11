'use strict';

const assert = require('assert');
const { analyzeCorrelation, correlateRouteLogs } = require('../api-retry-trace');

const now = Date.now();
const getLog = () => [
  { ts: now - 5000, status: 'ok', model: 'claude-sonnet', via: 'p2p-1' },
  { ts: now - 10000, status: 'ok', model: 'claude-sonnet', via: 'paid-1' },
];

const analysis = analyzeCorrelation(correlateRouteLogs(getLog, 60_000));
assert.strictEqual(analysis.errors, 0);
assert.strictEqual(analysis.ok, 2);
assert.ok(analysis.hints.some(h => h.includes('failover')));

const errLog = () => [
  { ts: now - 2000, status: 'error', model: 'x', error: 'HTTP 529' },
];
const errAnalysis = analyzeCorrelation(correlateRouteLogs(errLog, 60_000));
assert.strictEqual(errAnalysis.errors, 1);
assert.ok(errAnalysis.hints.some(h => h.includes('失败记录')));

console.log('api-retry-trace.test.js OK');
