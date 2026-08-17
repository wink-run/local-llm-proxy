'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  collectCliRuntimeDeps,
  isDesktopOnly,
  DESKTOP_ONLY_FILES,
  ELECTRON_ROOT,
  CLIENT_ROOT,
} = require('../../scripts/cli-runtime-manifest');

test('Dockerfile.cli installs npm packages required by CLI source', () => {
  const dockerfile = fs.readFileSync(path.join(CLIENT_ROOT, 'Dockerfile.cli'), 'utf8');
  const deps = require(path.join(CLIENT_ROOT, 'package.json')).dependencies || {};
  const { files } = collectCliRuntimeDeps();
  const needed = new Set();
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(src))) {
      let name = m[1];
      if (name.startsWith('.') || name.startsWith('node:')) continue;
      name = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
      if (deps[name]) needed.add(name);
    }
  }
  const missing = [...needed].filter((n) => !dockerfile.includes(n));
  assert.deepEqual(missing, [], `Dockerfile.cli missing npm deps: ${missing.join(', ')}`);
});

test('CLI entry points resolve all local requires', () => {
  const { missing } = collectCliRuntimeDeps();
  assert.equal(
    missing.length,
    0,
    missing.map(m => `${m.from} → ${m.req} (${m.resolved})`).join('\n'),
  );
});

test('CLI runtime includes gateway core modules', () => {
  const { files } = collectCliRuntimeDeps();
  const mustHave = [
    'local-gateway.js',
    'compressor.js',
    'handlers/imageHandler.js',
    'app-handlers.js',
    'session-trace/registry.js',
    'cursor-hooks.js',
  ].map(f => path.join(ELECTRON_ROOT, f));
  for (const f of mustHave) {
    assert.ok(files.includes(f), `expected in CLI deps: ${path.relative(ELECTRON_ROOT, f)}`);
  }
});

test('desktop shell files are marked desktop-only', () => {
  for (const f of DESKTOP_ONLY_FILES) {
    assert.ok(isDesktopOnly(path.join(ELECTRON_ROOT, f)), `${f} should be desktop-only`);
  }
});

test('local-gateway loads in Node (same module graph as Docker CLI)', () => {
  assert.doesNotThrow(() => {
    const gw = path.join(ELECTRON_ROOT, 'local-gateway.js');
    delete require.cache[require.resolve(gw)];
    require(gw);
  });
});

test('prune script keeps CLI deps in isolated copy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-prune-'));
  const copyRoot = path.join(tmp, 'electron');
  fs.cpSync(ELECTRON_ROOT, copyRoot, { recursive: true });
  execFileSync(process.execPath, [path.join(CLIENT_ROOT, 'scripts', 'prune-electron-for-cli.js')], {
    env: { ...process.env, CLI_PRUNE_ELECTRON_ROOT: copyRoot },
    stdio: 'pipe',
  });
  assert.ok(!fs.existsSync(path.join(copyRoot, 'main.js')));
  assert.ok(fs.existsSync(path.join(copyRoot, 'local-gateway.js')));
  assert.ok(fs.existsSync(path.join(copyRoot, 'compressor.js')));
  fs.rmSync(tmp, { recursive: true, force: true });
});
