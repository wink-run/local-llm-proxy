'use strict';
const { TREE_MAX_LINES } = require('../constants');
function tree(input) {
  const lines = input.split('\n');
  const filtered = [];
  for (const line of lines) {
    if (line.includes('director') && line.includes('file')) continue;
    if (line.trim() === '' && filtered.length === 0) continue;
    filtered.push(line);
  }
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') filtered.pop();
  if (filtered.length > TREE_MAX_LINES) {
    const cut = filtered.length - TREE_MAX_LINES;
    return filtered.slice(0, TREE_MAX_LINES).join('\n') + `\n... +${cut} more lines`;
  }
  return filtered.join('\n');
}
tree.filterName = 'tree';
module.exports = { tree };
