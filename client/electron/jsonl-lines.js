// jsonl-lines.js — 大 JSONL 文件的流式逐行读取工具（会话补录 / trace 查看共用）。
//
// 为什么需要：session-import 启动扫描、session-trace 打开会话，都会读会话 jsonl。
// 用 fs.readFileSync(file).split('\n') 会一次性把整份文件 + 整份行数组载入内存；曾有
// 用户的 Codex rollout 达 ~1GB，直接 OOM 崩溃。这里统一提供按块流式的行迭代器。
'use strict';

const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const fzstd = require('fzstd');

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

// zstd 可跳过帧：magic 0x184D2A50..0x184D2A5F（LE）+ 4 字节长度
function zstdSkippableBytes(buf, offset) {
  if (offset + 8 > buf.length) return 0;
  if (buf[offset + 1] !== 0x2a || buf[offset + 2] !== 0x4d || buf[offset + 3] !== 0x18) return 0;
  if (buf[offset] < 0x50 || buf[offset] > 0x5f) return 0;
  return 8 + buf.readUInt32LE(offset + 4);
}

// 标准 zstd 帧 magic：0xFD2FB528（LE）
function isZstdFrameMagic(buf, offset) {
  return offset + 4 <= buf.length
    && buf[offset] === 0x28 && buf[offset + 1] === 0xb5
    && buf[offset + 2] === 0x2f && buf[offset + 3] === 0xfd;
}

/**
 * 从 offset 起解析一帧的精确字节长度（含 magic / header / blocks / checksum）。
 * 失败返回 0。按帧切开后交给纯 JS 的 fzstd，避免 Node zlib.zstdDecompressSync
 * 在 Electron 主线程留下 native engine，GC 时 SIGTRAP。
 */
function zstdFrameByteLength(buf, offset) {
  if (!isZstdFrameMagic(buf, offset)) return 0;
  let pos = offset + 4;
  if (pos >= buf.length) return 0;
  const desc = buf[pos++];
  const fcsFlag = desc >> 6;
  const singleSegment = (desc >> 5) & 1;
  const contentChecksum = (desc >> 2) & 1;
  const dictIdFlag = desc & 3;
  if ((desc >> 3) & 1) return 0; // Reserved_bit 必须为 0
  if (!singleSegment) pos += 1; // Window_Descriptor
  pos += [0, 1, 2, 4][dictIdFlag];
  pos += fcsFlag === 0 ? (singleSegment ? 1 : 0) : (1 << fcsFlag); // 0/1, 2, 4, 8
  if (pos > buf.length) return 0;
  while (true) {
    if (pos + 3 > buf.length) return 0;
    const header = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
    pos += 3;
    const last = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (blockType === 3) return 0; // Reserved
    pos += blockType === 1 ? 1 : blockSize; // RLE 内容 1 字节，其余 Block_Size
    if (pos > buf.length) return 0;
    if (last) break;
  }
  if (contentChecksum) pos += 4;
  if (pos > buf.length) return 0;
  return pos - offset;
}

/**
 * DeepSeek Harness 等：session.jsonl.zstd 是「一事件一帧」拼接。
 * 必须用纯 JS 解压：Node zlib 的 zstd 每帧一个 native engine，
 * Electron 38 在 didFinishLaunching 里 GC 这些对象会 SIGTRAP。
 */
function* iterZstdJsonlLines(file) {
  const buf = fs.readFileSync(file);
  let offset = 0;
  let carry = '';
  while (offset < buf.length) {
    const skip = zstdSkippableBytes(buf, offset);
    if (skip) { offset += skip; continue; }
    const frameLen = zstdFrameByteLength(buf, offset);
    if (!frameLen) break;
    let u8;
    try {
      u8 = fzstd.decompress(buf.subarray(offset, offset + frameLen));
    } catch {
      break;
    }
    if (!u8 || !u8.length) break;
    offset += frameLen;
    carry += Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('utf8');
    let nl;
    while ((nl = carry.indexOf('\n')) >= 0) {
      yield carry.slice(0, nl);
      carry = carry.slice(nl + 1);
    }
  }
  if (carry) yield carry;
}

module.exports = {
  iterFileLines,
  iterZstdJsonlLines,
  countJsonlLines,
  MAX_JSONL_FILE_BYTES,
  STREAM_THRESHOLD_BYTES,
};
