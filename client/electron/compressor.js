// client/electron/compressor.js
'use strict';

// ~4 chars/token
function estimateTokens(str) { return Math.ceil((typeof str === 'string' ? str.length : 0) / 4); }

function minifyJsonString(s) {
  if (typeof s !== 'string') return s;
  const t = s.trimStart();
  if (!t.length || (t[0] !== '{' && t[0] !== '[')) return s;
  try {
    const parsed = JSON.parse(s);
    if (parsed === null || typeof parsed !== 'object') return s;
    const compact = JSON.stringify(parsed);
    return compact.length < s.length ? compact : s;
  } catch { return s; }
}

// RTK: apply structural compression to tool output text (> 500 chars)
const RTK_MIN = 500;
let _rtkLoaded = false;
let _autoDetect = null;
let _safeApply = null;
function _loadRtk() {
  if (_rtkLoaded) return;
  _rtkLoaded = true;
  try {
    _autoDetect = require('./rtk/autodetect').autoDetectFilter;
    _safeApply  = require('./rtk/applyFilter').safeApply;
  } catch (e) {
    console.warn('[rtk] failed to load RTK modules:', e && e.message);
  }
}

// Compress tool output text with RTK; returns { text, hit } where hit is filterName or null
function rtkCompressText(text) {
  if (!text || text.length < RTK_MIN || !_autoDetect) return { text, hit: null };
  const fn = _autoDetect(text);
  if (!fn) return { text, hit: null };
  const out = _safeApply(fn, text);
  if (out === text) return { text, hit: null };
  return { text: out, hit: fn.filterName || fn.name || 'rtk' };
}

function compressContent(content, isToolRole) {
  if (typeof content === 'string') {
    const s = minifyJsonString(content);
    if (!isToolRole) return { content: s, rtkHits: [] };
    const { text, hit } = rtkCompressText(s);
    return { content: text, rtkHits: hit ? [hit] : [] };
  }
  if (Array.isArray(content)) {
    const rtkHits = [];
    const blocks = content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const isTR = block.type === 'tool_result';
      if (typeof block.text === 'string') {
        const s = minifyJsonString(block.text);
        if (isTR) { const r = rtkCompressText(s); if (r.hit) rtkHits.push(r.hit); return { ...block, text: r.text }; }
        return { ...block, text: s };
      }
      if (typeof block.content === 'string') {
        const s = minifyJsonString(block.content);
        if (isTR) { const r = rtkCompressText(s); if (r.hit) rtkHits.push(r.hit); return { ...block, content: r.text }; }
        return { ...block, content: s };
      }
      if (isTR && Array.isArray(block.content)) {
        const parts = block.content.map(part => {
          if (!part || typeof part.text !== 'string') return part;
          const s = minifyJsonString(part.text);
          const r = rtkCompressText(s);
          if (r.hit) rtkHits.push(r.hit);
          return { ...part, text: r.text };
        });
        return { ...block, content: parts };
      }
      return block;
    });
    return { content: blocks, rtkHits };
  }
  return { content, rtkHits: [] };
}

function _contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const b of content) {
      if (typeof b === 'string') n += b.length;
      else if (b && typeof b.text === 'string') n += b.text.length;
      else if (b && typeof b.content === 'string') n += b.content.length;
    }
    return n;
  }
  return 0;
}

function _messagesText(messages) {
  const parts = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const c = m && m.content;
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (typeof b === 'string') parts.push(b);
        else if (b && typeof b.text === 'string') parts.push(b.text);
        else if (b && typeof b.content === 'string') parts.push(b.content);
      }
    }
  }
  return parts.join('\n');
}

function messagesTokens(messages) { return estimateTokens(_messagesText(messages)); }

function compressionRatio(before, after) {
  if (!before || before <= 0) return 0;
  return Math.max(0, Math.min(1, (before - after) / before));
}

function compressMessages(messages) {
  let beforeChars = 0, afterChars = 0;
  const out = (Array.isArray(messages) ? messages : []).map((m) => {
    if (!m || typeof m !== 'object' || m.content == null) return m;
    beforeChars += _contentChars(m.content);
    const isToolRole = m.role === 'tool';
    const { content } = compressContent(m.content, isToolRole);
    afterChars += _contentChars(content);
    return content === m.content ? m : { ...m, content };
  });
  return { messages: out, before: estimateTokens('x'.repeat(beforeChars)), after: estimateTokens('x'.repeat(afterChars)) };
}

/**
 * Compress a chat request body.
 * @returns {{ body, before, after, saved, rtkHits: string[] }}
 */
function compressBody(body, opts = {}) {
  _loadRtk();
  if (!opts.enabled || !body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { body, before: 0, after: 0, saved: 0, rtkHits: [] };
  }
  const sysStr = typeof body.system === 'string' ? body.system : '';
  const before = messagesTokens(body.messages) + estimateTokens(sysStr);
  const allRtkHits = [];

  const outMessages = (body.messages).map((m) => {
    if (!m || typeof m !== 'object' || m.content == null) return m;
    const isToolRole = m.role === 'tool';
    const { content, rtkHits } = compressContent(m.content, isToolRole);
    if (rtkHits && rtkHits.length) allRtkHits.push(...rtkHits);
    return content === m.content ? m : { ...m, content };
  });

  const system = sysStr ? minifyJsonString(sysStr) : body.system;
  const after = messagesTokens(outMessages) + estimateTokens(typeof system === 'string' ? system : '');
  const saved = Math.max(0, before - after);

  if (saved <= 0 && !allRtkHits.length) return { body, before, after, saved: 0, rtkHits: [] };
  const next = { ...body, messages: outMessages };
  if (system !== body.system) next.system = system;
  return { body: next, before, after, saved, rtkHits: allRtkHits };
}

module.exports = {
  estimateTokens, minifyJsonString, compressContent, compressMessages, messagesTokens, compressBody, compressionRatio,
};
