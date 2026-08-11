'use strict';

/**
 * Electron 侧品牌 logo 解析（与 client/src/lib/brandIcons.js 规则对齐）
 * 返回 file:// URL 或 data: URL，供 tray-popover 沙箱窗口使用。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ICONS_DIR = path.join(
  __dirname,
  '..',
  'node_modules',
  '@lobehub',
  'icons-static-svg',
  'icons',
);

// 更具体的规则在前
const RULES = [
  [/claude[\s_-]*code/i, 'claudecode-color.svg'],
  // anthropic-compatible 用 Dify Anthropic 插件图标，须先于通用 anthropic/claude
  [/anthropic[\s_-]*compatible/i, 'anthropic-compatible.svg'],
  [/claude|anthropic/i, 'claude-color.svg'],
  [/codex/i, 'codex-color.svg'],
  [/opencode/i, 'opencode.svg'],
  // openai-compatible 专用立方体，须先于通用 openai
  [/openai[\s_-]*compatible/i, 'openai-compatible.svg'],
  [/openai|gpt|o[34]-|o1-/i, 'openai.svg'],
  [/cursor/i, 'cursor.svg'],
  [/openclaw/i, 'openclaw-color.svg'],
  [/gemini[\s_-]*cli/i, 'geminicli-color.svg'],
  [/gemini|google|palm/i, 'gemini-color.svg'],
  [/deepseek/i, 'deepseek-color.svg'],
  // Kimi → brand-assets/kimi-avatar.svg（见 resolveFile 特殊处理）
  [/kimi|moonshot/i, 'kimi-avatar.svg'],
  [/minimax/i, 'minimax.png'],
  [/zhipu|智谱|bigmodel/i, 'zhipu.svg'],
  [/glm|chatglm/i, 'glmv-color.svg'],
  [/hugging[\s_-]*face|huggingface|\bhf\b/i, 'huggingface.svg'],
  [/qwen|通义|tongyi/i, 'qwen-color.svg'],
  [/copilot/i, 'copilot-color.svg'],
  [/antigravity/i, 'antigravity-color.svg'],
  [/hermes/i, 'hermesagent.svg'],
  [/grok/i, 'grok.svg'],
  [/workbuddy|codebuddy/i, 'codebuddy-color.svg'],
  [/trae/i, 'trae-color.svg'],
  [/volcengine|火山|volc|doubao|豆包|volcengine-ark/i, 'volcengine-color.svg'],
];

const cache = new Map();
const missCache = new Set(); // 未命中的匹配串，避免反复 existsSync

const BRAND_ASSETS_DIR = path.join(__dirname, 'brand-assets');

function resolveFile(text = '') {
  const hay = String(text);
  if (!hay) return null;
  if (missCache.has(hay)) return null;
  for (const [re, file] of RULES) {
    if (!re.test(hay)) continue;
    // Kimi Avatar 等本地资产优先于 lobehub static-svg
    const local = path.join(BRAND_ASSETS_DIR, file);
    if (fs.existsSync(local)) return local;
    const abs = path.join(ICONS_DIR, file);
    if (fs.existsSync(abs)) return abs;
  }
  missCache.add(hay);
  return null;
}

/** 读 SVG 为 data URL（沙箱下比 file:// 更稳） */
function toDataUrl(absPath) {
  if (!absPath) return null;
  if (cache.has(absPath)) return cache.get(absPath);
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
    cache.set(absPath, url);
    return url;
  } catch {
    try {
      const url = pathToFileURL(absPath).href;
      cache.set(absPath, url);
      return url;
    } catch {
      return null;
    }
  }
}

function resolveBrandIconUrl(text = '') {
  return toDataUrl(resolveFile(text));
}

function brandIconForApp(app = {}) {
  return resolveBrandIconUrl(`${app.agent_id || app.preset_id || ''} ${app.name || ''}`);
}

module.exports = {
  resolveBrandIconUrl,
  brandIconForApp,
  ICONS_DIR,
};
