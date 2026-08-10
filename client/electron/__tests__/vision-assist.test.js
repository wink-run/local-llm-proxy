'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  bodyHasImages,
  collectImagesFromBody,
  parseAssistDescriptions,
  replaceImagesInBody,
  stripImagesInBody,
  buildAssistUserContent,
  cloneBody,
} = require('../vision-assist');

const TINY_PNG = 'data:image/png;base64,aaa';

test('bodyHasImages：无图为 false，有 image_url / image 为 true', () => {
  assert.equal(bodyHasImages({ messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(bodyHasImages({
    messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: TINY_PNG } }] }],
  }), true);
  assert.equal(bodyHasImages({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/a.png' } }] }],
  }), true);
});

test('collectImagesFromBody：按出现顺序收集多图', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: TINY_PNG } },
        { type: 'text', text: '两张' },
        { type: 'image_url', image_url: { url: 'https://x/b.jpg' } },
      ],
    }],
  };
  const imgs = collectImagesFromBody(body);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].url, TINY_PNG);
  assert.equal(imgs[1].url, 'https://x/b.jpg');
});

test('parseAssistDescriptions：单图整段；多图按标记分段', () => {
  assert.deepEqual(parseAssistDescriptions('一只猫', 1), ['一只猫']);
  assert.deepEqual(
    parseAssistDescriptions('[图片1]：猫\n[图片2]：狗', 2),
    ['猫', '狗'],
  );
});

test('replaceImagesInBody：图片位换成描述文本', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是啥' },
        { type: 'image_url', image_url: { url: TINY_PNG } },
      ],
    }],
  };
  const out = replaceImagesInBody(cloneBody(body), ['橘猫在沙发上']);
  assert.equal(out.messages[0].content[0].text, '这是啥');
  assert.match(out.messages[0].content[1].text, /图片1的文字描述/);
  assert.match(out.messages[0].content[1].text, /橘猫在沙发上/);
  assert.equal(bodyHasImages(out), false);
});

test('stripImagesInBody：失败降级为无描述占位', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: TINY_PNG } }],
    }],
  };
  const out = stripImagesInBody(body);
  assert.match(out.messages[0].content[0].text, /未给出描述/);
});

test('parseAssistDescriptions：多图无标记时全文复用到每张', () => {
  assert.deepEqual(parseAssistDescriptions('画面里有猫和狗', 2), [
    '画面里有猫和狗',
    '画面里有猫和狗',
  ]);
});

test('prependVisionAssistNotice：在最后一条 user 前插入说明', () => {
  const { prependVisionAssistNotice } = require('../vision-assist');
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: '看图' }] },
    ],
  };
  prependVisionAssistNotice(body, 2);
  const last = body.messages[2].content;
  assert.equal(last[0].type, 'text');
  assert.match(last[0].text, /视觉助手/);
  assert.equal(last[1].text, '看图');
});

test('buildAssistUserContent：OpenAI 与 Anthropic 均可带图', () => {
  const imgs = [{ kind: 'oai', url: TINY_PNG }];
  const oai = buildAssistUserContent(imgs, '描述', 'openai');
  assert.equal(oai[0].type, 'text');
  assert.equal(oai[1].type, 'image_url');
  const anth = buildAssistUserContent(imgs, '描述', 'anthropic');
  assert.equal(anth[0].type, 'text');
  assert.equal(anth[1].type, 'image');
  assert.equal(anth[1].source.type, 'base64');
});

test('extractAssistResponseText：兼容火山 kimi 的 reasoning_content', () => {
  const { extractAssistResponseText } = require('../vision-assist');
  assert.equal(extractAssistResponseText({
    choices: [{ message: { content: '', reasoning_content: '图中是一只橘猫' } }],
  }, false), '图中是一只橘猫');
  assert.equal(extractAssistResponseText({
    choices: [{ message: { content: [{ type: 'text', text: '一只狗' }] } }],
  }, false), '一只狗');
  assert.equal(extractAssistResponseText({
    content: [{ type: 'text', text: 'Anthropic 描述' }],
  }, true), 'Anthropic 描述');
});

test('planImageDescriptions：历史图不调识图；仅最新 user 未缓存图进 needApi', () => {
  const {
    collectImagesWithMeta,
    planImageDescriptions,
    cacheSet,
    cacheClear,
    imageFingerprint,
  } = require('../vision-assist');
  cacheClear();

  const histUrl = 'data:image/png;base64,hist';
  const newUrl = 'data:image/png;base64,new';
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '第一轮' },
          { type: 'image_url', image_url: { url: histUrl } },
        ],
      },
      { role: 'assistant', content: '好的' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '第二轮' },
          { type: 'image_url', image_url: { url: newUrl } },
        ],
      },
    ],
  };
  const items = collectImagesWithMeta(body);
  assert.equal(items.length, 2);
  assert.equal(items[0].inLastUser, false);
  assert.equal(items[1].inLastUser, true);

  // 历史无缓存 → 占位跳过；新图 → 需 API
  let plan = planImageDescriptions(items);
  assert.equal(plan.needApiIdx.length, 1);
  assert.deepEqual(plan.needApiIdx, [1]);
  assert.equal(plan.historySkip, 1);
  assert.equal(plan.cacheHits, 0);
  assert.match(plan.descs[0], /历史图片/);

  // 写入历史图缓存后，再规划应全部不调 API（新图也若已缓存）
  cacheSet(imageFingerprint(items[0].img), '历史图描述：一只猫');
  cacheSet(imageFingerprint(items[1].img), '新图描述：一只狗');
  plan = planImageDescriptions(items);
  assert.deepEqual(plan.needApiIdx, []);
  assert.equal(plan.cacheHits, 2);
  assert.equal(plan.historySkip, 0);
  assert.equal(plan.descs[0], '历史图描述：一只猫');
  assert.equal(plan.descs[1], '新图描述：一只狗');
  cacheClear();
});

test('planImageDescriptions：同图再次出现在最新 user 时命中缓存，不重复识图', () => {
  const {
    collectImagesWithMeta,
    planImageDescriptions,
    cacheSet,
    cacheClear,
    imageFingerprint,
  } = require('../vision-assist');
  cacheClear();

  const sameUrl = 'data:image/png;base64,same';
  const img = { kind: 'oai', url: sameUrl };
  cacheSet(imageFingerprint(img), '已识别过的猫');

  const body = {
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: sameUrl } }],
    }],
  };
  const plan = planImageDescriptions(collectImagesWithMeta(body));
  assert.deepEqual(plan.needApiIdx, []);
  assert.equal(plan.cacheHits, 1);
  assert.equal(plan.descs[0], '已识别过的猫');
  cacheClear();
});
