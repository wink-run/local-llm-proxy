// Claude Desktop 透明 mask 名（与 tokenbank.default.yaml claude_models 保持一致）

export const DEFAULT_CLAUDE_MASK_MODELS = [
  'claude-opus-4-8',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
];

/** 合并内置 + 服务端/配置下发的 mask 名 */
export function claudeMaskModelSet(extra = []) {
  const list = [...DEFAULT_CLAUDE_MASK_MODELS];
  for (const x of extra || []) {
    if (typeof x === 'string' && x.trim()) list.push(x.trim());
  }
  return new Set(list);
}
