'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sceneHasVisionAssist,
  routeSupportsImages,
  getRouteCatalogModels,
} = require('../app-handlers');
const codexCfg = require('../codex-config');

const ROUTES = [
  {
    id: 'r-plain',
    model_key: 'llm-router-plain',
    steps: [{ model: 'deepseek-v4-flash' }],
  },
  {
    id: 'r-va',
    model_key: 'llm-router-vision-assist',
    steps: [
      { model: 'deepseek-v4-pro', vision_assist: { model: 'kimi-k2.5' } },
    ],
  },
  {
    id: 'r-va-rules',
    model_key: 'llm-router-va-rules',
    rules: [{
      when: { type: 'token_count', op: 'lt', value: 1000 },
      steps: [{ model: 'a', vision_assist: 'gpt-5.6-luna' }],
    }],
    steps: [{ model: 'b' }],
  },
];

test('sceneHasVisionAssist：steps / rules 均可检出', () => {
  assert.equal(sceneHasVisionAssist(ROUTES[0]), false);
  assert.equal(sceneHasVisionAssist(ROUTES[1]), true);
  assert.equal(sceneHasVisionAssist(ROUTES[2]), true);
});

test('routeSupportsImages：配备识图增强的场景 → true；纯文本场景 → false', () => {
  assert.equal(routeSupportsImages('llm-router-vision-assist', ROUTES, []), true);
  assert.equal(routeSupportsImages('llm-router-plain', ROUTES, []), false);
  // 直接绑定供给源图文模型
  const providers = [{ models: [{ name: 'gpt-4o', type: 'vision' }] }];
  assert.equal(routeSupportsImages('gpt-4o', [], providers), true);
  assert.equal(routeSupportsImages('paid:gpt-4o', [], providers), true);
});

test('getRouteCatalogModels：识图场景写入 vision=true，供 Codex catalog 含 image', () => {
  const app = { route_ids: ['llm-router-vision-assist', 'llm-router-plain'] };
  const catalog = getRouteCatalogModels(app, ROUTES, []);
  assert.deepEqual(catalog, [
    { name: 'llm-router-vision-assist', vision: true },
    { name: 'llm-router-plain', vision: false },
  ]);
});

test('writeCodexCatalog：vision=true → input_modalities 含 image', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-va-'));
  try {
    const r = codexCfg.writeCodexCatalog(home, [
      { name: 'llm-router-vision-assist', vision: true },
      { name: 'llm-router-plain', vision: false },
    ]);
    const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    const bySlug = Object.fromEntries(doc.models.map((m) => [m.slug, m]));
    assert.deepEqual(bySlug['llm-router-vision-assist'].input_modalities, ['text', 'image']);
    assert.deepEqual(bySlug['llm-router-plain'].input_modalities, ['text']);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});
