// jsonl-lines.js — 大 JSONL 文件的流式逐行读取工具（会话补录 / trace 查看共用）。
//
// 为什么需要：session-import 启动扫描、session-trace 打开会话，都会读会话 jsonl。
// 用 fs.readFileSync(file).split('\n') 会一次性把整份文件 + 整份行数组载入内存；曾有
// 用户的 Codex rollout 达 ~1GB，直接 OOM 崩溃。这里统一提供按块流式的行迭代器。
'use strict';

const fs = require('fs');
const { StringDecoder } = require('string_decoder');

// 单文件硬上限：超过则不做全量解析，改走「浅解析 / 截断」兜底，绝不整份读入。
const MAX_JSONL_FILE_BYTES = 256 * 1024 * 1024; // 256MB
// 流式阈值：超过则逐行流式读取，避免 readFileSync + split 的双份整文件拷贝。
const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8MB

// 按块流式逐行读取，只在内存里保留「跨块残行」，不整份载入。
// 用 StringDecoder 处理跨块边界的多字节 UTF-8 字符，避免出现替换符。
// 提前 break 出 for-of 会触发 generator 的 return()，从而走 finally 关闭 fd。
function* iterFileLines(file) {
  const CHUNK = 1 << 20; // 1MB
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = '';
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
      carry += decoder.write(buf.subarray(0, bytes));
      let nl;
      while ((nl = carry.indexOf('\n')) >= 0) {
        yield carry.slice(0, nl);
        carry = carry.slice(nl + 1);
      }
    }
    carry += decoder.end();
    if (carry) yield carry;
  } finally {
    fs.closeSync(fd);
  }
}

// 统计非空行数（与旧 split().filter(Boolean).length 语义一致），流式无大内存分配。
function countJsonlLines(file) {
  let n = 0;
  for (const raw of iterFileLines(file)) if (raw.trim()) n++;
  return n;
}

module.exports = {
  iterFileLines,
  countJsonlLines,
  MAX_JSONL_FILE_BYTES,
  STREAM_THRESHOLD_BYTES,
};
