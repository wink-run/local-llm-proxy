// provider-registry.js — 读取 providers.registry.yaml，校验 handler 白名单
'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REGISTRY_PATH = path.join(__dirname, 'config', 'providers.registry.yaml');

// 客户端预置 adapter；不含 BFL / fal / stability / elevenlabs / deepgram 等
const HANDLERS = new Set(['local', 'openai', 'anthropic', 'gemini', 'p2p', 'agnes-image']);

function loadRegistryDoc() {
  try {
    const doc = yaml.load(fs.readFileSync(REGISTRY_PATH, 'utf8')) || {};
    return typeof doc === 'object' && doc ? doc : { providers: [] };
  } catch (e) {
    console.warn('[provider-registry] 加载失败:', e.message);
    return { providers: [] };
  }
}

function listProviders() {
  const doc = loadRegistryDoc();
  return Array.isArray(doc.providers) ? doc.providers : [];
}

function isKnownHandler(name) {
  return HANDLERS.has(name);
}

module.exports = { HANDLERS, loadRegistryDoc, listProviders, isKnownHandler };
