// 模型排行：剔除工具名、组合标签、中文说明句等非模型字符串
'use strict';

/** 常见 Agent 工具名（Cursor / Claude Code 等） */
const KNOWN_TOOL_NAMES = new Set([
  'Grep', 'Read', 'Write', 'Bash', 'Shell', 'Edit', 'Search', 'Glob', 'List',
  'Task', 'Skill', 'WebFetch', 'WebSearch', 'Delete', 'StrReplace', 'ApplyPatch',
  'EditNotebook', 'TodoWrite', 'AskQuestion', 'GenerateImage', 'NotebookEdit',
  'LS', 'Cd', 'RunTerminalCmd', 'SemanticSearch', 'CreatePlan', 'SwitchMode',
  'MultiEdit', 'Execute', 'CallMcpTool', 'FetchMcpResource',
]);

/** 是否应计入「模型调用排行」
 * @param {string} name
 * @param {{ maskedModels?: Set<string> }} [opts] — claude_models 等客户端透明名
 */
function isRankableModelName(name, opts = {}) {
  if (name == null) return false;
  const s = String(name).trim();
  if (!s || s === '<synthetic>') return false;
  const masked = opts.maskedModels;
  if (masked && masked.has(s)) return false;
  if (KNOWN_TOOL_NAMES.has(s)) return false;
  // 工具组合摘要：Read · Grep
  if (/\s[·•]\s/.test(s)) return false;
  // 中文说明句误入 model（如 Cursor 改动说明）
  if (/[\u4e00-\u9fff]/.test(s) && (s.length > 10 || /[，。！？、]/.test(s))) return false;
  return true;
}

function filterRankableModels(rows, opts = {}) {
  return (rows || []).filter(r => isRankableModelName(r.model, opts));
}

module.exports = { isRankableModelName, filterRankableModels, KNOWN_TOOL_NAMES };
