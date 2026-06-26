'use strict';
const { FIND_PER_DIR_MAX, FIND_TOTAL_DIR_MAX } = require('../constants');
function find(input) {
  const lines = input.split('\n').filter(l => l.trim());
  if (!lines.length) return input;
  const byDir = new Map();
  for (const path of lines) {
    const last = path.lastIndexOf('/');
    const dir = last === -1 ? '.' : (path.slice(0, last) || '/');
    const base = last === -1 ? path : path.slice(last + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(base);
  }
  const dirs = Array.from(byDir.keys()).sort();
  let out = `${lines.length} files in ${dirs.length} dirs:\n\n`;
  for (const dir of dirs.slice(0, FIND_TOTAL_DIR_MAX)) {
    const files = byDir.get(dir);
    out += `${dir}/  (${files.length})\n`;
    for (const f of files.slice(0, FIND_PER_DIR_MAX)) out += `  ${f}\n`;
    if (files.length > FIND_PER_DIR_MAX) out += `  +${files.length - FIND_PER_DIR_MAX}\n`;
  }
  if (dirs.length > FIND_TOTAL_DIR_MAX) out += `\n+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs\n`;
  return out;
}
find.filterName = 'find';
module.exports = { find };
