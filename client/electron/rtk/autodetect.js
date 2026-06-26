'use strict';
const { DETECT_WINDOW, SMART_TRUNCATE_MIN_LINES } = require('./constants');
const { gitDiff } = require('./filters/gitDiff');
const { gitStatus } = require('./filters/gitStatus');
const { grep } = require('./filters/grep');
const { find } = require('./filters/find');
const { tree } = require('./filters/tree');
const { ls } = require('./filters/ls');
const { smartTruncate } = require('./filters/smartTruncate');

const RE_GIT_DIFF     = /^diff --git /m;
const RE_GIT_DIFF_HNK = /^@@ /m;
const RE_GIT_STATUS   = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_PORCELAIN    = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_TREE_GLYPH   = /[├└]──|│  /;
const RE_LS_ROW       = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL     = /^total \d+$/m;

function isGrepLine(line) {
  const f = line.indexOf(':');
  if (f === -1) return false;
  const s = line.indexOf(':', f + 1);
  if (s === -1) return false;
  return /^\d+$/.test(line.slice(f + 1, s));
}
function isPathLike(l) { const t = l.trim(); return t && !t.includes(':') && (t.startsWith('.') || t.startsWith('/') || t.includes('/')); }
function isMostlyPorcelain(head) { const ls2 = head.split('\n').filter(l => l.trim()); if (ls2.length < 3) return false; const hits = ls2.filter(l => RE_PORCELAIN.test(l)).length; return hits / ls2.length >= 0.6; }
function countMatches(text, re) { const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); return (text.match(g) || []).length; }

function autoDetectFilter(text) {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HNK.test(head)) return gitDiff;
  if (RE_GIT_STATUS.test(head)) return gitStatus;
  if (isMostlyPorcelain(head)) return gitStatus;
  const lines = head.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.slice(0, 5).some(isGrepLine)) return grep;
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return find;
  if (RE_TREE_GLYPH.test(head)) return tree;
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= 3) return ls;
  if (text.split('\n').length >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;
  return null;
}

module.exports = { autoDetectFilter };
