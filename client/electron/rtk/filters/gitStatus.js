'use strict';
const { STATUS_MAX_FILES, STATUS_MAX_UNTRACKED } = require('../constants');
function gitStatus(input) {
  const lines = input.split('\n');
  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) return 'Clean working tree';
  let branch = '';
  const stagedFiles = [], modifiedFiles = [], untrackedFiles = [];
  let staged = 0, modified = 0, untracked = 0, conflicts = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const longBranch = raw.match(/^On branch (\S+)/);
    if (longBranch) { branch = longBranch[1]; continue; }
    if (raw.startsWith('##')) { branch = raw.replace(/^##\s*/, ''); continue; }
    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0], y = raw[1], file = raw.slice(3);
      if (raw.slice(0, 2) === '??') { untracked++; untrackedFiles.push(file); continue; }
      if ('MADRC'.includes(x)) { staged++; stagedFiles.push(file); }
      else if (x === 'U') { conflicts++; }
      if (y === 'M' || y === 'D') { modified++; modifiedFiles.push(file); }
      continue;
    }
    const longMatch = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (longMatch) {
      const kind = longMatch[1], path = longMatch[2].trim();
      if (kind === 'both modified') conflicts++;
      else if (kind === 'modified' || kind === 'deleted') { modified++; modifiedFiles.push(path); }
      else { staged++; stagedFiles.push(path); }
    }
  }
  let out = '';
  if (branch) out += `* ${branch}\n`;
  if (staged > 0) {
    out += `+ Staged: ${staged} files\n`;
    for (const f of stagedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (stagedFiles.length > STATUS_MAX_FILES) out += `   ... +${stagedFiles.length - STATUS_MAX_FILES} more\n`;
  }
  if (modified > 0) {
    out += `~ Modified: ${modified} files\n`;
    for (const f of modifiedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (modifiedFiles.length > STATUS_MAX_FILES) out += `   ... +${modifiedFiles.length - STATUS_MAX_FILES} more\n`;
  }
  if (untracked > 0) {
    out += `? Untracked: ${untracked} files\n`;
    for (const f of untrackedFiles.slice(0, STATUS_MAX_UNTRACKED)) out += `   ${f}\n`;
    if (untrackedFiles.length > STATUS_MAX_UNTRACKED) out += `   ... +${untrackedFiles.length - STATUS_MAX_UNTRACKED} more\n`;
  }
  if (conflicts > 0) out += `conflicts: ${conflicts} files\n`;
  if (!staged && !modified && !untracked && !conflicts) out += 'clean — nothing to commit\n';
  return out.replace(/\n+$/, '');
}
gitStatus.filterName = 'git-status';
module.exports = { gitStatus };
