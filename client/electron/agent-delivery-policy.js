'use strict';

/**
 * Claude Code / Codex 共用：可交付产物必须由 Agent 直接落盘，
 * 禁止让用户粘贴依赖 Codex 内部 cache 的「一键保存」超长脚本。
 */
const DELIVERY_POLICY = [
  '【Token Bank 产物交付】',
  '1. PPT/PDF/图片/代码等文件须用工具直接写入当前工作目录或用户指定路径（如桌面），完成后回复绝对路径。',
  '2. 禁止让用户复制粘贴「一键保存」超长脚本；禁止依赖 ~/.cache/codex-runtimes、artifact_tool 等内部路径。',
  '3. 若必须用脚本生成：先把完整脚本写入工作目录（.js/.mjs/.py 等），再在该目录用 shell 执行并写出产物。',
  '4. 对话中只给简短说明与最终文件路径，不要贴完整生成脚本正文。',
].join('\n');

/** Codex：前缀拼到用户 prompt */
function withDeliveryPolicyPrompt(prompt) {
  const body = String(prompt || '');
  if (!body.trim()) return DELIVERY_POLICY;
  if (body.includes('【Token Bank 产物交付】')) return body;
  return `${DELIVERY_POLICY}\n\n${body}`;
}

/** Claude：追加 --append-system-prompt 段（已有则拼接） */
function withClaudeDeliverySystemArgs(extraArgs = []) {
  const out = [...extraArgs];
  const idx = out.indexOf('--append-system-prompt');
  if (idx >= 0 && out[idx + 1] != null) {
    const prev = String(out[idx + 1]);
    if (!prev.includes('【Token Bank 产物交付】')) {
      out[idx + 1] = `${prev}\n\n${DELIVERY_POLICY}`;
    }
    return out;
  }
  out.push('--append-system-prompt', DELIVERY_POLICY);
  return out;
}

module.exports = {
  DELIVERY_POLICY,
  withDeliveryPolicyPrompt,
  withClaudeDeliverySystemArgs,
};
