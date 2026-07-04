'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  syncFromSessionMemory,
  parseUserQuery,
  parseRendererMetadata,
  parseRendererDone,
  isDuplicateUserQuery,
  dropOrphanTailUsers,
  estimateTokens,
  MEMORY_ROOT,
} = require('../trae-session-sync');

test('parseUserQuery extracts text content from Trae log query', () => {
  const line = 'query: Some("[{\\"type\\":\\"text\\",\\"data\\":{\\"content\\":\\"调研trae work\\"}}]")';
  assert.equal(parseUserQuery(line), '调研trae work');
});

test('parseRendererMetadata extracts parsed_query from renderer log', () => {
  const line = '2026-07-04T23:56:15.170+08:00 [info] [trae-chat-core] [MetadataHandler] received metadata {"sessionId":"abc1234567890123456789012","message_id":"def1234567890123456789012","session_id":"abc1234567890123456789012","created_at":1783180575,"user_message_context":{"parsed_query":["诗"]}}';
  const meta = parseRendererMetadata(line);
  assert.equal(meta.session_id, 'abc1234567890123456789012');
  assert.equal(meta.query, '诗');
  assert.equal(meta.timestamp, 1783180575);
});

test('parseRendererDone extracts completed agent message id', () => {
  const line = '2026-07-04T23:56:21.123+08:00 [info] [trae-chat-core] [DoneHandler] Stream done event received {"sessionId":"abc1234567890123456789012","status":"completed","agentMessageId":"def1234567890123456789012"}';
  const done = parseRendererDone(line);
  assert.equal(done.session_id, 'abc1234567890123456789012');
  assert.equal(done.agent_message_id, 'def1234567890123456789012');
});

test('isDuplicateUserQuery avoids short query false positive', () => {
  assert.equal(isDuplicateUserQuery(['创作一首诗'], '诗'), false);
  assert.equal(isDuplicateUserQuery(['以命运为题撰写诗歌'], '以命运为题撰写以命运为题撰写'), true);
});

test('dropOrphanTailUsers removes log orphans and trailing user without assistant', () => {
  const rows = [
    { session_id: 's1', type: 'user', message: { content: 'a' }, _source: 'trae-memory' },
    { session_id: 's1', type: 'assistant', step_kind: 'outcome', message: { content: 'ok' }, _source: 'trae-memory' },
    { session_id: 's1', type: 'user', message: { content: 'orphan' }, _source: 'trae-log' },
    { session_id: 's1', type: 'user', message: { content: 'tail' }, _source: 'trae-renderer' },
  ];
  const out = dropOrphanTailUsers(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].message.content, 'a');
});

test('estimateTokens returns at least 1 for non-empty text', () => {
  assert.ok(estimateTokens('hello world') >= 1);
  assert.equal(estimateTokens(''), 0);
});

test('syncFromSessionMemory reads session_memory jsonl when present', () => {
  if (!fs.existsSync(MEMORY_ROOT)) return;
  const rows = syncFromSessionMemory();
  assert.ok(Array.isArray(rows));
  const sid = '6a49201cd84725b3d03effa5';
  const sessionRows = rows.filter(r => r.session_id === sid);
  if (!sessionRows.length) return;
  const user = sessionRows.find(r => r.type === 'user');
  assert.ok(user?.message?.content?.includes('调研trae work'));
  const outcome = sessionRows.find(r => r.step_kind === 'outcome');
  assert.ok(outcome?.message?.content?.length > 10);
  assert.ok((outcome.message.usage.output_tokens || 0) > 0);
});
