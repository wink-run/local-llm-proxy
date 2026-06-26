'use strict';
const { GIT_DIFF_HUNK_MAX_LINES } = require('../constants');
function gitDiff(diff, maxLines = 500) {
  const result = [];
  let currentFile = '', added = 0, removed = 0, inHunk = false, hunkShown = 0, hunkSkipped = 0, wasTruncated = false;
  outer: for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (hunkSkipped > 0) { result.push(`  ... (${hunkSkipped} lines truncated)`); wasTruncated = true; hunkSkipped = 0; }
      if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
      const parts = line.split(' b/');
      currentFile = parts.length > 1 ? parts.slice(1).join(' b/') : 'unknown';
      result.push(`\n${currentFile}`);
      added = 0; removed = 0; inHunk = false; hunkShown = 0;
    } else if (line.startsWith('@@')) {
      if (hunkSkipped > 0) { result.push(`  ... (${hunkSkipped} lines truncated)`); wasTruncated = true; hunkSkipped = 0; }
      inHunk = true; hunkShown = 0; result.push(`  ${line}`);
    } else if (inHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added++;
        if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) { result.push(`  ${line}`); hunkShown++; } else { hunkSkipped++; }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed++;
        if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) { result.push(`  ${line}`); hunkShown++; } else { hunkSkipped++; }
      } else if (hunkShown < GIT_DIFF_HUNK_MAX_LINES && !line.startsWith('\\')) {
        if (hunkShown > 0) { result.push(`  ${line}`); hunkShown++; }
      }
    }
    if (result.length >= maxLines) { result.push('\n... (more changes truncated)'); wasTruncated = true; break outer; }
  }
  if (hunkSkipped > 0) { result.push(`  ... (${hunkSkipped} lines truncated)`); wasTruncated = true; }
  if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
  if (wasTruncated) result.push('[full diff: rtk git diff --no-compact]');
  return result.join('\n');
}
gitDiff.filterName = 'git-diff';
module.exports = { gitDiff };
