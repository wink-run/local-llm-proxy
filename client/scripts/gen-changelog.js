#!/usr/bin/env node
/**
 * 生成 release notes：上一个 tag → 当前 tag/HEAD 的提交，按 conventional-commit 前缀分组。
 * 写到 client/release-notes.md，供 electron-builder 与 GitHub Release 正文使用。
 *
 * 用法：
 *   node scripts/gen-changelog.js
 *   node scripts/gen-changelog.js --from v0.4.9 --to v0.5.0
 *   CHANGELOG_FROM=v0.4.9 CHANGELOG_TO=v0.5.0 node scripts/gen-changelog.js
 *
 * 默认：上一可达 tag → 当前 tag（HEAD 在 tag 上）或 HEAD（尚未打 tag 时）。
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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' && argv[i + 1]) out.from = argv[++i];
    else if (argv[i] === '--to' && argv[i + 1]) out.to = argv[++i];
  }
  return out;
}

const pkg = require('../package.json');
const args = parseArgs(process.argv.slice(2));

// 当前版本锚点：显式 --to / env > HEAD 精确 tag > GITHUB_REF_NAME（CI push tag）> package.json
const envTo = process.env.CHANGELOG_TO || '';
const githubTag = (process.env.GITHUB_REF_NAME || '').match(/^v[\w.-]+$/)
  ? process.env.GITHUB_REF_NAME
  : '';
const headTag = git('describe --tags --exact-match HEAD');
const currentRef = args.to || envTo || headTag || githubTag || 'HEAD';
const version = (currentRef !== 'HEAD' ? currentRef : (pkg.version || '')).replace(/^v/i, '');

// 上一 tag：显式 --from / env > currentRef~1 最近 tag > HEAD~1
const envFrom = process.env.CHANGELOG_FROM || '';
let prevTag = args.from || envFrom;
if (!prevTag) {
  // 用 ~1 不用 ^：Windows 上 execSync 走 cmd.exe，^ 是转义符会被吃掉
  const base = currentRef !== 'HEAD' ? currentRef : 'HEAD';
  prevTag = git(`describe --tags --abbrev=0 ${base}~1`)
    || (currentRef === 'HEAD' ? git('describe --tags --abbrev=0') : '');
}

const range = prevTag
  ? `${prevTag}..${currentRef === 'HEAD' ? 'HEAD' : currentRef}`
  : (currentRef === 'HEAD' ? 'HEAD' : currentRef);
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

const today = git(`log -1 --pretty=format:%cs ${currentRef === 'HEAD' ? '' : currentRef}`.trim()) || '';
const header = `## Changelog — v${version}${today ? ` (${today})` : ''}`;
const body = [];
for (const key of ['feat', 'fix', 'perf', 'refactor', 'other']) {
  if (!groups[key].length) continue;
  body.push(`\n### ${TITLE[key]}`);
  for (const item of groups[key]) body.push(`- ${item}`);
}
if (!body.length) body.push('\n_No notable changes._');

const compare = prevTag ? `${prevTag}...v${version}` : '';
const md = `${header}\n${body.join('\n')}\n${compare ? `\n**Full changelog**: ${compare}\n` : ''}`;

const outPath = path.join(__dirname, '..', 'release-notes.md');
fs.writeFileSync(outPath, md);
process.stdout.write(md + '\n');
process.stderr.write(`\n[gen-changelog] ${lines.length} commits (${range}) -> ${path.relative(process.cwd(), outPath)}\n`);
