'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveConsumerKey,
  contributeSessionKey,
  isContributeSessionKey,
  ensureContributeWorkspace,
  safeSegment,
} = require('../contribute-session');

test('resolveConsumerKey prefers consumer_key then uid then task', () => {
  assert.equal(resolveConsumerKey({ consumer_key: 'u42' }), 'u42');
  assert.equal(resolveConsumerKey({ consumer_user_id: 7 }), 'u7');
  assert.equal(resolveConsumerKey({ task_id: 'at-abc' }), 'task-at-abc');
  assert.equal(resolveConsumerKey({}), 'anon');
});

test('contributeSessionKey isolates users', () => {
  const a = contributeSessionKey('poetry', 'u1');
  const b = contributeSessionKey('poetry', 'u2');
  assert.equal(a, 'contribute:poetry:u1');
  assert.equal(b, 'contribute:poetry:u2');
  assert.notEqual(a, b);
  assert.equal(isContributeSessionKey(a), true);
  assert.equal(isContributeSessionKey('assistant:poetry'), false);
});

test('ensureContributeWorkspace creates per-user dirs', () => {
  const root = path.join(os.homedir(), '.tokenbank', 'contribute-workspaces');
  const d1 = ensureContributeWorkspace('asst-demo', 'u1');
  const d2 = ensureContributeWorkspace('asst-demo', 'u2');
  assert.ok(d1.startsWith(root));
  assert.ok(fs.existsSync(d1));
  assert.ok(fs.existsSync(d2));
  assert.notEqual(d1, d2);
  assert.equal(path.basename(d1), 'u1');
  assert.equal(path.basename(d2), 'u2');
});

test('safeSegment strips unsafe path chars', () => {
  assert.equal(safeSegment('../evil name!!'), 'evil_name');
});
