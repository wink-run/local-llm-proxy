'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ADAPTERS, getAdapter, resolveProvider } = require('../handlers/imageHandler');

// Real user config: base_url omits /v1 (the bug that caused 403s), provider id is agnes-ai.
// Agnes is handled via BODY_CONFIGS (OpenAI-compatible base + per-provider overrides),
// not a standalone ADAPTERS entry — so we exercise it through getAdapter().
const PROVIDER = { id: 'agnes-ai', type: 'free', token: 'sk-x', base_url: 'https://apihub.agnes-ai.com' };

test('agnes-ai is NOT a standalone adapter (handled by BODY_CONFIGS)', () => {
  assert.ok(!ADAPTERS['agnes-ai'], 'agnes-ai should not hardcode a top-level adapter');
});

test('getAdapter matches agnes by base_url and composes an adapter', () => {
  const a = getAdapter(PROVIDER);
  assert.ok(a, 'getAdapter must return an adapter for agnes');
  assert.equal(typeof a.buildUrl, 'function');
  assert.equal(typeof a.buildBody, 'function');
  // inherits OpenAI passthrough normalize + Bearer auth
  assert.equal(typeof a.normalize, 'function');
  assert.equal(a.buildHeaders(PROVIDER).Authorization, 'Bearer sk-x');
});

test('buildUrl adds missing /v1 (real config: base_url without /v1)', () => {
  // Docs endpoint: https://apihub.agnes-ai.com/v1/images/generations
  // User's stored base_url is https://apihub.agnes-ai.com (no /v1) → must be normalized.
  const url = getAdapter(PROVIDER).buildUrl('agnes-image-2.1-flash', PROVIDER);
  assert.equal(url, 'https://apihub.agnes-ai.com/v1/images/generations');
});

test('buildUrl does not duplicate /v1 when base_url already has it', () => {
  const p = { ...PROVIDER, base_url: 'https://apihub.agnes-ai.com/v1' };
  assert.equal(getAdapter(p).buildUrl('m', p), 'https://apihub.agnes-ai.com/v1/images/generations');
});

test('buildUrl strips trailing slash', () => {
  const p = { ...PROVIDER, base_url: 'https://apihub.agnes-ai.com/v1/' };
  assert.equal(getAdapter(p).buildUrl('m', p), 'https://apihub.agnes-ai.com/v1/images/generations');
});

test('text-to-image: response_format goes inside extra_body, never top-level', () => {
  const body = getAdapter(PROVIDER).buildBody('agnes-image-2.0-flash', {
    prompt: 'a glass cube', size: '1024x768', response_format: 'url',
  });
  assert.equal(body.model, 'agnes-image-2.0-flash');
  assert.equal(body.prompt, 'a glass cube');
  assert.equal(body.size, '1024x768');
  // top-level response_format would cause HTTP 400 on Agnes
  assert.ok(!('response_format' in body), 'response_format must NOT be at top level');
  assert.deepEqual(body.extra_body, { response_format: 'url' });
  assert.ok(!('image' in body), 'text-to-image must not include image array');
});

test('return_base64 short-circuits to base64 output', () => {
  const body = getAdapter(PROVIDER).buildBody('m', { prompt: 'p', return_base64: true });
  assert.equal(body.return_base64, true);
  assert.ok(!('extra_body' in body));
});

test('img2img: top-level image array is passed through', () => {
  const body = getAdapter(PROVIDER).buildBody('m', {
    prompt: 'make it orange', size: '1024x768',
    image: ['https://example.com/in.png'],
  });
  assert.deepEqual(body.image, ['https://example.com/in.png']);
  // no tags field needed
  assert.ok(!('tags' in body));
});

test('multi-image composition: multiple urls preserved', () => {
  const body = getAdapter(PROVIDER).buildBody('m', {
    prompt: 'combine', image: ['https://a/1.png', 'https://b/2.png'],
  });
  assert.equal(body.image.length, 2);
});

test('normalize is passthrough (inherits OpenAI; Agnes already returns OpenAI shape)', () => {
  const parsed = { created: 1780000000, data: [{ url: 'https://x/y.png', b64_json: null, revised_prompt: null }] };
  assert.equal(getAdapter(PROVIDER).normalize(parsed), parsed);
});

test('resolveProvider finds agnes-ai by "agnes-ai/model" format', () => {
  const r = resolveProvider('agnes-ai/agnes-image-2.0-flash', [PROVIDER]);
  assert.ok(r);
  assert.equal(r.provider.id, 'agnes-ai');
  assert.equal(r.model, 'agnes-image-2.0-flash');
});

test('resolveProvider finds agnes-ai by image model entry', () => {
  const p = { ...PROVIDER, models: [{ name: 'agnes-image-2.0-flash', type: 'image' }] };
  const r = resolveProvider('agnes-image-2.0-flash', [p]);
  assert.ok(r);
  assert.equal(r.provider.id, 'agnes-ai');
});

test('resolveProvider falls back to BODY_CONFIGS match even without an exact image model', () => {
  // User's real situation: configured model is agnes-image-2.1-flash but request sends
  // agnes-image-2.0-flash (no slash, no matching model entry). Must still resolve via
  // the BODY_CONFIGS fallback so the request reaches Agnes instead of 400-ing.
  const p = { ...PROVIDER, models: [{ name: 'agnes-image-2.1-flash', type: 'image' }] };
  const r = resolveProvider('agnes-image-2.0-flash', [p]);
  assert.ok(r, 'should resolve via BODY_CONFIGS fallback');
  assert.equal(r.provider.id, 'agnes-ai');
});

test('match is by base_url, robust to a custom provider id', () => {
  // A custom-named provider pointing at Agnes should still match the body config.
  const custom = { id: 'my-agnes', token: 'sk-x', base_url: 'https://apihub.agnes-ai.com' };
  const url = getAdapter(custom).buildUrl('m', custom);
  assert.equal(url, 'https://apihub.agnes-ai.com/v1/images/generations');
});

test('tier prefix free: is stripped before provider lookup (same as chat route)', () => {
  const { TIER_ROUTE_RE } = require('../../shared/route-binding');
  const m = TIER_ROUTE_RE.exec('free:agnes-image-2.0-flash');
  assert.ok(m);
  assert.equal(m[1], 'free');
  assert.equal(m[2], 'agnes-image-2.0-flash');
  const r = resolveProvider(m[2], [PROVIDER]);
  assert.equal(r.provider.id, 'agnes-ai');
  assert.equal(r.model, 'agnes-image-2.0-flash');
});
