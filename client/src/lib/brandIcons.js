// 应用 / 模型 / 供给源品牌 logo —— 取自 @lobehub/icons-static-svg（纯静态 SVG，随构建打包，离线可用）。
// Vite 把 .svg import 解析成资源 URL，用 <img src> 渲染即可。
// resolveBrandIcon(text) 按规则匹配返回 URL；未命中返回 null，调用方回退到原 emoji。
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg';
import claudecode from '@lobehub/icons-static-svg/icons/claudecode-color.svg';
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg';
import openai from '@lobehub/icons-static-svg/icons/openai.svg';
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg';
import openclaw from '@lobehub/icons-static-svg/icons/openclaw-color.svg';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg';
import geminicli from '@lobehub/icons-static-svg/icons/geminicli-color.svg';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg';
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg';
import glm from '@lobehub/icons-static-svg/icons/glmv-color.svg';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg';
import copilot from '@lobehub/icons-static-svg/icons/copilot-color.svg';

// 顺序敏感：更具体的规则在前（claude code 先于 claude；gemini cli 先于 gemini）。
const RULES = [
  [/claude[\s_-]*code/i, claudecode],
  [/claude|anthropic/i, claude],
  [/codex/i, codex],
  [/openai|gpt|o[34]-|o1-/i, openai],
  [/cursor/i, cursor],
  [/openclaw/i, openclaw],
  [/gemini[\s_-]*cli/i, geminicli],
  [/gemini|google|palm/i, gemini],
  [/deepseek/i, deepseek],
  [/kimi|moonshot/i, kimi],
  [/glm|zhipu|chatglm|智谱/i, glm],
  [/qwen|通义|tongyi/i, qwen],
  [/copilot/i, copilot],
];

/** 依据任意文本（应用名/模型名/供给源名）推断品牌 logo URL，无匹配返回 null。 */
export function resolveBrandIcon(text = '') {
  const hay = String(text);
  for (const [re, url] of RULES) if (re.test(hay)) return url;
  return null;
}

/** 应用对象便捷封装：综合 agent_id 与 name 匹配。 */
export function brandIconFor(app = {}) {
  return resolveBrandIcon(`${app.agent_id || ''} ${app.name || ''}`);
}
