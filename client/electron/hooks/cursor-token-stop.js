#!/usr/bin/env node
'use strict';
// Cursor stop hook：stdin JSON → ~/.tokenbank/cursor-hook-events.jsonl（导入后由 App 清空）
// debug 模式（设置页 Log level=Debug）→ 同时写 ~/.tokenbank/hooks.log

const fs = require('fs');
const path = require('path');
const os = require('os');
const { hookLog } = require('./cursor-hooks-log');

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch (e) {
    hookLog('stop:parse_error', { error: String(e && e.message) });
    process.exit(0);
  }

  if (input.input_tokens == null && input.output_tokens == null) {
    hookLog('stop:skipped_no_tokens', input);
    process.exit(0);
  }
  if (input.status && input.status !== 'completed') {
    hookLog('stop:skipped_status', { status: input.status, generation_id: input.generation_id });
    process.exit(0);
  }

  const event = {
    generation_id: String(input.generation_id || ''),
    conversation_id: String(input.conversation_id || input.session_id || ''),
    ts: Math.floor(Date.now() / 1000),
    model: input.model_id || input.model || null,
    status: input.status || 'completed',
    input_tokens: Number(input.input_tokens) || 0,
    output_tokens: Number(input.output_tokens) || 0,
    cache_read_tokens: Number(input.cache_read_tokens) || 0,
    cache_write_tokens: Number(input.cache_write_tokens) || 0,
  };

  if (!event.generation_id) {
    hookLog('stop:skipped_no_generation_id', input);
    process.exit(0);
  }

  const dir = path.join(os.homedir(), '.tokenbank');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'cursor-hook-events.jsonl'),
    `${JSON.stringify(event)}\n`,
    'utf8',
  );
  hookLog('stop:recorded', { event, input });
}

main().catch((e) => {
  hookLog('stop:error', { error: String(e && e.message) });
  process.exit(0);
});
