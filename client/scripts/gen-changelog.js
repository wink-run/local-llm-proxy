#!/usr/bin/env node
/**
 * 生成 release notes：上一个 tag → 当前 HEAD 的提交，按 conventional-commit 前缀分组。
 * 写到 client/release-notes.md，供 electron-builder 的 releaseInfo.releaseNotesFile 用作
 * GitHub release 正文（build 前由 prebuild 自动跑）。也可单独 `node scripts/gen-changelog.js` 预览。
 *
 * 说明：构建时新 tag 通常还没打，所以用「最近可达 tag → HEAD」= 本次待发布的更新内容。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const pkg = require('../package.json');

// 上一个 tag：HEAD 可达的最近 tag（若 HEAD 正好在某 tag 上，取它的上一个）。
// 用 ~1 不用 ^：Windows 上 execSync 走 cmd.exe，^ 是转义符会被吃掉。
const headTag = git('describe --tags --exact-match HEAD'); // HEAD 若就在 tag 上
// 版本号：HEAD 在 tag 上就用该 tag（预览更准），否则用 package.json（构建时通常还没打 tag）。
const version = headTag ? headTag.replace(/^v/i, '') : (pkg.version || '');
let prevTag = headTag
  ? git(`describe --tags --abbrev=0 ${headTag}~1`)
  : (git('describe --tags --abbrev=0 HEAD~1') || git('describe --tags --abbrev=0'));

const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
const raw = git(`log ${range} --no-merges --pretty=format:%s`);
const lines = raw ? raw.split('\n').filter(Boolean) : [];

// 按 conventional-commit 前缀分组
const groups = { feat: [], fix: [], perf: [], refactor: [], other: [] };
const TITLE = { feat: '✨ Features', fix: '🐛 Fixes', perf: '⚡ Performance', refactor: '♻️ Refactor', other: '📦 Other' };
for (const subj of lines) {
  const m = subj.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
  if (m && groups[m[1]]) groups[m[1]].push(m[2]);
  else if (m && (m[1] === 'chore' || m[1] === 'docs' || m[1] === 'test' || m[1] === 'ci' || m[1] === 'build' || m[1] === 'style')) {
    groups.other.push(m[2]);
  } else {
    groups.other.push(subj);
  }
}

const today = git('log -1 --pretty=format:%cs') || ''; // 提交日期 YYYY-MM-DD（不用 Date，构建可复现）
const header = `## v${version}${today ? ` (${today})` : ''}`;
const body = [];
for (const key of ['feat', 'fix', 'perf', 'refactor', 'other']) {
  if (!groups[key].length) continue;
  body.push(`\n### ${TITLE[key]}`);
  for (const item of groups[key]) body.push(`- ${item}`);
}
if (!body.length) body.push('\n_No notable changes._');

const md = `${header}\n${body.join('\n')}\n${prevTag ? `\n**Full changelog**: ${prevTag}...v${version}\n` : ''}`;

const outPath = path.join(__dirname, '..', 'release-notes.md');
fs.writeFileSync(outPath, md);
process.stdout.write(md + '\n');
process.stderr.write(`\n[gen-changelog] ${lines.length} commits (${range}) -> ${path.relative(process.cwd(), outPath)}\n`);
