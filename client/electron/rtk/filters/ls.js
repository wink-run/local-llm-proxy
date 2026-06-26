'use strict';
const { LS_EXT_SUMMARY_TOP, LS_NOISE_DIRS } = require('../constants');
const LS_DATE_RE = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;
function humanSize(b) { return b >= 1048576 ? `${(b/1048576).toFixed(1)}M` : b >= 1024 ? `${(b/1024).toFixed(1)}K` : `${b}B`; }
function parseLsLine(line) {
  const m = LS_DATE_RE.exec(line);
  if (!m) return null;
  const name = line.slice(m.index + m[0].length);
  const before = line.slice(0, m.index).split(/\s+/).filter(Boolean);
  if (before.length < 4) return null;
  const fileType = before[0][0];
  let size = 0;
  for (let i = before.length - 1; i >= 0; i--) { const n = Number(before[i]); if (Number.isInteger(n) && String(n) === before[i]) { size = n; break; } }
  return { fileType, size, name };
}
function ls(input) {
  const dirs = [], files = [], byExt = new Map();
  for (const line of input.split('\n')) {
    if (line.startsWith('total ') || !line) continue;
    const p = parseLsLine(line);
    if (!p || p.name === '.' || p.name === '..' || LS_NOISE_DIRS.includes(p.name)) continue;
    if (p.fileType === 'd') { dirs.push(p.name); }
    else if (p.fileType === '-' || p.fileType === 'l') {
      const dot = p.name.lastIndexOf('.');
      const ext = dot > 0 ? p.name.slice(dot) : 'no ext';
      byExt.set(ext, (byExt.get(ext) || 0) + 1);
      files.push([p.name, humanSize(p.size)]);
    }
  }
  if (!dirs.length && !files.length) return input;
  let out = '';
  for (const d of dirs) out += `${d}/\n`;
  for (const [n, s] of files) out += `${n}  ${s}\n`;
  let summary = `\nSummary: ${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const ext = Array.from(byExt.entries()).sort((a, b) => b[1] - a[1]);
    const parts = ext.slice(0, LS_EXT_SUMMARY_TOP).map(([e, c]) => `${c} ${e}`);
    summary += ` (${parts.join(', ')}`;
    if (ext.length > LS_EXT_SUMMARY_TOP) summary += `, +${ext.length - LS_EXT_SUMMARY_TOP} more`;
    summary += ')';
  }
  return out + summary;
}
ls.filterName = 'ls';
module.exports = { ls };
