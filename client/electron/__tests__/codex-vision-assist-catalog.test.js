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
    { name: 'llm-router-vision-assist', label: 'llm-router-vision-assist', vision: true },
    { name: 'llm-router-plain', label: 'llm-router-plain', vision: false },
  ]);
});

test('getRouteCatalogModels：场景路由带 scene_name 作 label', () => {
  const routes = [
    { id: 'r1', model_key: 'llm-router-speed', scene_name: '速度优先', icon: '⚡', steps: [{ strategy: 'speed' }] },
    { id: 'r2', model_key: 'llm-router-personal', scene_name: '个人源', icon: '⌛', steps: [{ strategy: 'auto', scope: 'personal' }] },
  ];
  const catalog = getRouteCatalogModels({ route_ids: ['llm-router-speed', 'llm-router-personal'] }, routes, []);
  assert.equal(catalog[0].name, 'llm-router-speed');
  assert.equal(catalog[0].label, '⚡ 速度优先');
  assert.equal(catalog[1].label, '⌛ 个人源');
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

test('writeCodexCatalog：description/display_name 用路由名，slug 仍为 model_key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-label-'));
  try {
    const r = codexCfg.writeCodexCatalog(home, [
      { name: 'llm-router-personal', label: '⌛ 个人源', vision: false },
      { name: 'deepseek-v4-flash', vision: false },
    ]);
    const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    const bySlug = Object.fromEntries(doc.models.map((m) => [m.slug, m]));
    assert.equal(bySlug['llm-router-personal'].slug, 'llm-router-personal');
    assert.equal(bySlug['llm-router-personal'].description, '⌛ 个人源');
    assert.equal(bySlug['llm-router-personal'].display_name, '⌛ 个人源');
    // 无 label 时回退为 name
    assert.equal(bySlug['deepseek-v4-flash'].description, 'deepseek-v4-flash');
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});
