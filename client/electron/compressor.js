// client/electron/compressor.js
// Optional, opt-in prompt-compression stage for the local gateway.
//
// Lossless only: minifies pretty-printed JSON found in message content (tool
// results, embedded data). JSON whitespace is non-semantic, so the model sees
// identical information with fewer tokens. Anything that isn't valid JSON is
// left byte-for-byte untouched — never changes the model's answers.
'use strict';

// ~4 chars/token — matches the gateway's existing estimateInputTokens heuristic
// so before/after deltas are consistent with the rest of the stats.
function estimateTokens(str) {
  return Math.ceil((typeof str === 'string' ? str.length : 0) / 4);
}

// Minify a string IFF it is a pretty-printed JSON object/array and the compact
// form is actually shorter. Returns the original string otherwise (lossless).
function minifyJsonString(s) {
  if (typeof s !== 'string') return s;
  const t = s.trimStart();
  if (t.length === 0 || (t[0] !== '{' && t[0] !== '[')) return s;
  try {
    const parsed = JSON.parse(s);
    if (parsed === null || typeof parsed !== 'object') return s;
    const compact = JSON.stringify(parsed);
    return compact.length < s.length ? compact : s;
  } catch {
    return s; // not valid JSON — leave untouched
  }
}

// Compress one message's `content`, which may be a string or an array of
// content blocks (OpenAI/Anthropic). Returns the new content (same shape).
function compressContent(content) {
  if (typeof content === 'string') return minifyJsonString(content);
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === 'object') {
        if (typeof block.text === 'string') return { ...block, text: minifyJsonString(block.text) };
        if (typeof block.content === 'string') return { ...block, content: minifyJsonString(block.content) };
      }
      return block;
    });
  }
  return content;
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

// Compress an array of chat messages. Returns { messages, before, after } in
// tokens. `messages` is a new array; inputs are not mutated.
function compressMessages(messages) {
  let beforeChars = 0, afterChars = 0;
  const out = (Array.isArray(messages) ? messages : []).map((m) => {
    if (!m || typeof m !== 'object' || m.content == null) return m;
    beforeChars += _contentChars(m.content);
    const content = compressContent(m.content);
    afterChars += _contentChars(content);
    return content === m.content ? m : { ...m, content };
  });
  return { messages: out, before: estimateTokens('x'.repeat(beforeChars)), after: estimateTokens('x'.repeat(afterChars)) };
}

// Concatenated text of all message content, for a stable token estimate.
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

// 压缩比 = 省下占原始的比例（0..1）。before<=0 时返回 0。
function compressionRatio(before, after) {
  if (!before || before <= 0) return 0;
  return Math.max(0, Math.min(1, (before - after) / before));
}

/**
 * Compress a chat request body — built-in lossless JSON minify only.
 * @param {object} body  parsed request body (OpenAI or Anthropic shape)
 * @param {object} opts  { enabled }
 * @returns {{ body, before, after, saved }} tokens; saved = before-after
 */
function compressBody(body, opts = {}) {
  if (!opts.enabled || !body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { body, before: 0, after: 0, saved: 0 };
  }
  const sysStr = typeof body.system === 'string' ? body.system : '';
  const before = messagesTokens(body.messages) + estimateTokens(sysStr);

  const outMessages = compressMessages(body.messages).messages;
  const system = sysStr ? minifyJsonString(sysStr) : body.system;
  const after = messagesTokens(outMessages) + estimateTokens(typeof system === 'string' ? system : '');
  const saved = Math.max(0, before - after);

  if (saved <= 0) return { body, before, after, saved: 0 };
  const next = { ...body, messages: outMessages };
  if (system !== body.system) next.system = system;
  return { body: next, before, after, saved };
}

module.exports = {
  estimateTokens, minifyJsonString, compressContent, compressMessages, messagesTokens, compressBody, compressionRatio,
};
