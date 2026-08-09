// 应用 / 模型 / 供给源品牌 logo —— 全部本地打包，运行时不拉远程。
// 1) @lobehub/icons-static-svg（应用/模型）
// 2) src/assets/provider-icons/*（供给源官方 logo）
// resolveBrandIcon / resolveProviderBrandIcon 未命中返回 null，调用方回退 emoji。
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg';
import claudecode from '@lobehub/icons-static-svg/icons/claudecode-color.svg';
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg';
import openai from '@lobehub/icons-static-svg/icons/openai.svg';
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg';
import openclaw from '@lobehub/icons-static-svg/icons/openclaw-color.svg';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg';
import geminicli from '@lobehub/icons-static-svg/icons/geminicli-color.svg';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg';
// Kimi 用 Avatar data URL（对齐 Kimi.Avatar），避免外部 svg 资源加载失败
import { KIMI_AVATAR_DATA_URL as kimi } from '../components/KimiAvatar';
import glm from '@lobehub/icons-static-svg/icons/glmv-color.svg';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg';
import copilot from '@lobehub/icons-static-svg/icons/copilot-color.svg';
import volcengine from '@lobehub/icons-static-svg/icons/volcengine-color.svg';
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg';
import antigravity from '@lobehub/icons-static-svg/icons/antigravity-color.svg';
import grok from '@lobehub/icons-static-svg/icons/grok.svg';
import hermes from '@lobehub/icons-static-svg/icons/hermesagent.svg';
import codebuddy from '@lobehub/icons-static-svg/icons/codebuddy-color.svg';
import trae from '@lobehub/icons-static-svg/icons/trae-color.svg';
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg';
import worldrouter from '@lobehub/icons-static-svg/icons/worldrouter.svg';

// 供给源官方 logo（本地 assets，构建时打包）
import iconOllama from '../assets/provider-icons/ollama.png';
import iconNvidia from '../assets/provider-icons/nvidia.png';
import iconSiliconflow from '../assets/provider-icons/siliconflow.png';
import iconAgnes from '../assets/provider-icons/agnes-ai.png';
import iconJimeng from '../assets/provider-icons/jimeng-api.png';
import iconFireworks from '../assets/provider-icons/fireworks.png';
import iconXai from '../assets/provider-icons/xai.png';
import iconAistudio from '../assets/provider-icons/aistudio.png';
import iconVolcFavicon from '../assets/provider-icons/volcengine.png';
// Dify 兼容源 / 厂商官方图标（避免被下方通用规则误匹配）
import iconOpenaiCompatible from '../assets/provider-icons/openai-compatible.svg';
import iconAnthropicCompatible from '../assets/provider-icons/anthropic-compatible.svg';
import iconMinimax from '../assets/provider-icons/minimax.png';
import iconZhipu from '../assets/provider-icons/zhipu.svg';
import iconHuggingface from '../assets/provider-icons/huggingface.svg';

// 顺序敏感：更具体的规则在前（claude code 先于 claude；gemini cli 先于 gemini）。
const RULES = [
  [/claude[\s_-]*code/i, claudecode],
  // anthropic-compatible 用 Dify Anthropic 插件图标，须先于通用 anthropic/claude
  [/anthropic[\s_-]*compatible/i, iconAnthropicCompatible],
  [/claude|anthropic/i, claude],
  [/codex/i, codex],
  [/opencode/i, opencode],
  [/openrouter/i, openrouter],
  [/worldrouter|worldclaw/i, worldrouter],
  // openai-compatible 专用立方体图标，须先于通用 openai 规则
  [/openai[\s_-]*compatible/i, iconOpenaiCompatible],
  [/openai|gpt|o[34]-|o1-/i, openai],
  [/cursor/i, cursor],
  [/openclaw/i, openclaw],
  [/gemini[\s_-]*cli/i, geminicli],
  [/gemini|google|palm/i, gemini],
  [/deepseek/i, deepseek],
  [/kimi|moonshot/i, kimi],
  [/minimax/i, iconMinimax],
  // 智谱供给源用 Dify zhipuai 图标；模型名 glm-* 仍走 lobehub
  [/zhipu|智谱|bigmodel/i, iconZhipu],
  [/glm|chatglm/i, glm],
  [/hugging[\s_-]*face|huggingface|\bhf\b/i, iconHuggingface],
  [/qwen|通义|tongyi/i, qwen],
  [/copilot/i, copilot],
  [/antigravity/i, antigravity],
  [/hermes/i, hermes],
  [/grok/i, grok],
  [/workbuddy|codebuddy/i, codebuddy],   // WorkBuddy = 腾讯 CodeBuddy
  [/trae/i, trae],
  [/volcengine|火山|volc|doubao|豆包|api-volcengine/i, volcengine],
];

/** 供给源 catalog id → 本地 logo 资源（无 lobehub 条目时使用） */
const PROVIDER_LOCAL_ICONS = {
  ollama: iconOllama,
  nvidia: iconNvidia,
  siliconflow: iconSiliconflow,
  'agnes-ai': iconAgnes,
  'jimeng-api': iconJimeng,
  jimeng: iconJimeng,
  fireworks: iconFireworks,
  xai: iconXai,
  gemini: iconAistudio,
  volcengine: iconVolcFavicon,
  'api-volcengine': iconVolcFavicon,
  'openai-compatible': iconOpenaiCompatible,
  'anthropic-compatible': iconAnthropicCompatible,
  minimax: iconMinimax,
  zhipu: iconZhipu,
  zhipuai: iconZhipu,
  huggingface: iconHuggingface,
  huggingface_hub: iconHuggingface,
};

/** 依据任意文本（应用名/模型名/供给源名）推断品牌 logo URL，无匹配返回 null。 */
export function resolveBrandIcon(text = '') {
  const hay = String(text);
  for (const [re, url] of RULES) if (re.test(hay)) return url;
  return null;
}

/**
 * 供给源 logo：全部本地资源（lobehub 或 provider-icons），不发起网络请求。
 * @param {{ id?: string, name?: string, label?: string, base_url?: string, signup_url?: string }} opts
 */
export function resolveProviderBrandIcon(opts = {}) {
  const id = String(opts.id || '').trim();
  const hay = `${id} ${opts.name || ''} ${opts.label || ''}`;
  // catalog id 精确命中优先，避免 openai-compatible 被 openai 规则抢走
  if (PROVIDER_LOCAL_ICONS[id]) return PROVIDER_LOCAL_ICONS[id];

  const local = resolveBrandIcon(hay);
  if (local) return local;

  // 名称模糊匹配本地表（如「即梦」「WorldRouter」）
  for (const [key, url] of Object.entries(PROVIDER_LOCAL_ICONS)) {
    if (new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(hay)) return url;
  }
  if (/即梦|jimeng/i.test(hay)) return iconJimeng;

  return null;
}

/** 应用对象便捷封装：综合 agent_id 与 name 匹配。 */
export function brandIconFor(app = {}) {
  return resolveBrandIcon(`${app.agent_id || ''} ${app.name || ''}`);
}
