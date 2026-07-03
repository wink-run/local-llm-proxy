'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  getAdapter,
  geminiBase,
  isGeminiImageProvider,
  normalizeGeminiImageResponse,
} = require('../handlers/imageHandler');

const GEMINI_PROVIDER = {
  id: 'Gemini',
  api_format: 'gemini',
  token: 'AIza-test',
  base_url: 'https://generativelanguage.googleapis.com/v1beta',
};

test('isGeminiImageProvider detects gemini by api_format and base_url', () => {
  assert.ok(isGeminiImageProvider(GEMINI_PROVIDER));
  assert.ok(isGeminiImageProvider({ base_url: 'https://generativelanguage.googleapis.com' }));
  assert.ok(!isGeminiImageProvider({ id: 'openai', base_url: 'https://api.openai.com' }));
});

test('geminiBase does not duplicate /v1beta', () => {
  assert.equal(
    geminiBase('https://generativelanguage.googleapis.com/v1beta'),
    'https://generativelanguage.googleapis.com/v1beta',
  );
  assert.equal(
    geminiBase('https://generativelanguage.googleapis.com'),
    'https://generativelanguage.googleapis.com/v1beta',
  );
});

test('getAdapter uses generateContent URL for Gemini', () => {
  const a = getAdapter(GEMINI_PROVIDER);
  const url = a.buildUrl('gemini-3.1-flash-lite-image', GEMINI_PROVIDER);
  assert.equal(
    url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent',
  );
  assert.equal(a.buildHeaders(GEMINI_PROVIDER)['x-goog-api-key'], 'AIza-test');
  assert.ok(!a.buildHeaders(GEMINI_PROVIDER).Authorization);
});

test('buildBody includes responseModalities and aspectRatio', () => {
  const body = getAdapter(GEMINI_PROVIDER).buildBody('gemini-3.1-flash-lite-image', {
    prompt: 'a cat',
    size: '1024x768',
  });
  assert.equal(body.contents[0].parts[0].text, 'a cat');
  assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '4:3');
});

test('normalizeGeminiImageResponse extracts inlineData b64_json', () => {
  const parsed = {
    candidates: [{
      content: {
        parts: [
          { text: 'Here is your image' },
          { inlineData: { mimeType: 'image/png', data: 'abc123==' } },
        ],
      },
    }],
  };
  const out = normalizeGeminiImageResponse(parsed);
  assert.equal(out.data.length, 1);
  assert.equal(out.data[0].b64_json, 'abc123==');
});

test('resolveImageRequestTimeoutMs respects config with 3min floor', () => {
  const { resolveImageRequestTimeoutMs } = require('../handlers/imageHandler');
  assert.equal(resolveImageRequestTimeoutMs(null), 300_000);
  assert.equal(resolveImageRequestTimeoutMs({ req_timeout: 60 }), 180_000);
  assert.equal(resolveImageRequestTimeoutMs({ req_timeout: 300 }), 300_000);
});

test('getAttempts provides native + openai fallback', () => {
  const a = getAdapter(GEMINI_PROVIDER);
  const attempts = a.getAttempts('gemini-3.1-flash-lite-image', GEMINI_PROVIDER, { prompt: 'x' });
  assert.equal(attempts.length, 2);
  assert.match(attempts[0].url, /:generateContent$/);
  assert.match(attempts[1].url, /\/openai\/v1\/images\/generations$/);
});

test('id=Gemini but apihub base_url uses OpenAI /images/generations, not generateContent', () => {
  const proxy = {
    id: 'Gemini',
    api_format: 'openai',
    token: 'sk-x',
    base_url: 'https://apihub.agnes-ai.com',
  };
  assert.ok(!isGeminiImageProvider(proxy));
  const url = getAdapter(proxy).buildUrl('gemini-3.1-flash-lite-image', proxy);
  assert.match(url, /\/v1\/images\/generations$/);
  const body = getAdapter(proxy).buildBody('gemini-3.1-flash-lite-image', { prompt: 'cat', size: '1024x1024' }, proxy);
  assert.ok(!('size' in body));
  assert.equal(body.ratio, '1:1');
});
