'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// 与 RichMediaContent.softenStreamingMarkdown 保持同步的纯逻辑副本(便于 node:test)
function softenStreamingMarkdown(text) {
  let s = String(text || '');
  if (!s) return s;
  const fenceLines = s.split('\n').filter((ln) => ln.trim().startsWith('```'));
  if (fenceLines.length % 2 === 1) s = `${s}\n\`\`\``;
  const ticks = (s.match(/`/g) || []).length;
  if (ticks % 2 === 1) {
    const idx = s.lastIndexOf('`');
    if (idx >= 0) s = `${s.slice(0, idx)}${s.slice(idx + 1)}`;
  }
  const boldStars = (s.match(/\*\*/g) || []).length;
  if (boldStars % 2 === 1) {
    const idx = s.lastIndexOf('**');
    if (idx >= 0) s = `${s.slice(0, idx)}${s.slice(idx + 2)}`;
  }
  return s;
}

function isMarkdownStable(text) {
  const s = String(text || '');
  if (!s) return true;
  const fences = s.split('\n').filter((ln) => ln.trim().startsWith('```')).length;
  if (fences % 2 === 1) return false;
  if (((s.match(/`/g) || []).length) % 2 === 1) return false;
  if (((s.match(/\*\*/g) || []).length) % 2 === 1) return false;
  return true;
}

test('softenStreamingMarkdown closes open fence', () => {
  const out = softenStreamingMarkdown('before\n```js\nconst x = 1');
  assert.ok(out.trimEnd().endsWith('```'));
  assert.equal(isMarkdownStable(out), true);
});

test('softenStreamingMarkdown drops unpaired inline backtick', () => {
  const out = softenStreamingMarkdown('path is `/tmp/foo and more');
  assert.equal(out.includes('`'), false);
  assert.match(out, /\/tmp\/foo/);
});

test('isMarkdownStable detects incomplete bold', () => {
  assert.equal(isMarkdownStable('hello **world'), false);
  assert.equal(isMarkdownStable('hello **world**'), true);
});
