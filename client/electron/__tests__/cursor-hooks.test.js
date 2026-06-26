'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cursorHooks = require('../cursor-hooks');

// importEvents：按 local-stats 口径写入
(() => {
  const recorded = [];
  const localStats = {
    record(row) {
      recorded.push(row);
      return true;
    },
  };
  const tmp = path.join(os.tmpdir(), `tb-cursor-hook-test-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, JSON.stringify({
    generation_id: 'gen-test-1',
    conversation_id: 'conv-1',
    ts: 1700000000,
    model: 'default',
    status: 'completed',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 50,
    cache_write_tokens: 0,
  }) + '\n');

  const n = cursorHooks.importEvents(localStats, { eventsPath: tmp });
  fs.unlinkSync(tmp);

  assert.equal(n, 1);
  assert.equal(recorded[0].data_source, 'session-cursor');
  assert.equal(recorded[0].request_id, 'cursor-hook:gen-test-1');
  assert.equal(recorded[0].model, 'cursor-agent');
  assert.equal(recorded[0].billing_type, 'subscription');
  assert.equal(recorded[0].input_tokens, 100);
  assert.equal(recorded[0].output_tokens, 20);
})();

// purgeTranscriptZeroTokens：委托 local-stats 按前缀删 0 token 行
(() => {
  let args;
  const localStats = {
    deleteZeroTokenSessionRows(a) { args = a; return 42; },
  };
  const n = cursorHooks.purgeTranscriptZeroTokens(localStats);
  assert.equal(n, 42);
  assert.equal(args.dataSource, 'session-cursor');
  assert.equal(args.requestIdLike, 'cursor:%');
})();

console.log('cursor-hooks.test.js ok');
