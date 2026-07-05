'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { replaceWithSymlink, isSymlinkTo } = require('../resource-projector');

test('replaceWithSymlink creates directory symlink to canonical', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-symlink-'));
  const canonicalDir = path.join(tmp, 'canonical', 'demo');
  const targetDir = path.join(tmp, 'agent', 'skills', 'demo');
  const canonicalMd = path.join(canonicalDir, 'SKILL.md');
  const targetMd = path.join(targetDir, 'SKILL.md');

  fs.mkdirSync(canonicalDir, { recursive: true });
  fs.writeFileSync(canonicalMd, '# demo\n', 'utf8');
  fs.writeFileSync(path.join(canonicalDir, 'helper.js'), 'module.exports = {};\n', 'utf8');

  const mode = replaceWithSymlink(targetDir, canonicalDir);
  assert.equal(mode, 'symlink');
  assert.ok(isSymlinkTo(targetDir, canonicalDir));
  assert.equal(fs.readFileSync(targetMd, 'utf8'), '# demo\n');
  assert.ok(fs.existsSync(path.join(targetDir, 'helper.js')));

  fs.writeFileSync(canonicalMd, '# updated\n', 'utf8');
  assert.equal(fs.readFileSync(targetMd, 'utf8'), '# updated\n');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('replaceWithSymlink falls back to directory copy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-copy-'));
  const canonicalDir = path.join(tmp, 'canonical', 'demo');
  fs.mkdirSync(canonicalDir, { recursive: true });
  fs.writeFileSync(path.join(canonicalDir, 'SKILL.md'), '# copy\n', 'utf8');

  const targetDir = path.join(tmp, 'agent', 'skills', 'demo');
  const originalSymlink = fs.symlinkSync;
  fs.symlinkSync = () => {
    throw new Error('symlink denied');
  };

  try {
    const mode = replaceWithSymlink(targetDir, canonicalDir);
    assert.equal(mode, 'copy');
    assert.equal(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8'), '# copy\n');
    assert.ok(!fs.lstatSync(targetDir).isSymbolicLink());
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
