// skill-signals.js
// 各 Agent 会话里 Skill 调用信号（对齐 tokentelemetry）：
// - Claude/WorkBuddy：工具名 Skill + input.skill
// - Cursor/Codex/其它：Read/工具参数里 skills…/SKILL.md 路径面包屑
'use strict';

/** skills/<name>/SKILL.md 或 skills-cursor/<name>/SKILL.md */
const SKILL_MD_BREADCRUMB_RE = /(?:^|[/\\])(?:skills-cursor|skills)[/\\]+([^/\\<>*]+)[/\\]+SKILL\.md/gi;

/** 读文件类工具：打开 SKILL.md 视为激活（不含 Shell，避免 ls 误报） */
const READ_SKILL_TOOLS = new Set([
  'Read', 'read_file', 'readFile', 'read',
  'Glob', 'glob_file_search', 'glob',
]);

function normalizeSkillKey(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const parts = s.split(/[/:]/);
  return parts[parts.length - 1].toLowerCase();
}

function parseToolInput(input) {
  if (!input) return {};
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch { return { _raw: input }; }
  }
  return typeof input === 'object' ? input : {};
}

/** 从路径/命令字符串提取 Skill 目录名 */
function extractSkillNamesFromPathText(text) {
  const names = new Set();
  if (!text || typeof text !== 'string') return [];
  const normalized = text.replace(/\\/g, '/');
  let m;
  SKILL_MD_BREADCRUMB_RE.lastIndex = 0;
  while ((m = SKILL_MD_BREADCRUMB_RE.exec(normalized)) !== null) {
    const raw = m[1];
    // 跳过文档占位符
    if (!raw || /^<.+>$/.test(raw) || raw === '*' || raw === 'foo') continue;
    names.add(raw);
  }
  return [...names];
}

/**
 * 通用：任意 Agent 的 tool 调用 → Skill 信号
 * @returns {{ raw: string, key: string, signal: string }[]}
 */
function extractSkillsFromToolCall(toolName, input, { signalPrefix = 'tool' } = {}) {
  const name = String(toolName || '');
  const inp = parseToolInput(input);
  const out = [];
  const seen = new Set();

  const push = (raw, signal) => {
    if (raw == null || raw === '') return;
    const s = String(raw).trim();
    if (!s) return;
    const key = normalizeSkillKey(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ raw: s, key, signal });
  };

  // 结构化 Skill 工具（Claude / WorkBuddy / 部分 IDE）
  if (name === 'Skill' || name.toLowerCase() === 'skill' || name === 'activate_skill') {
    push(inp.skill || inp.name || inp.command || inp.skill_name, `${signalPrefix}-skill`);
  }

  // 路径面包屑：Read/Glob 字段 + 任意工具参数序列化串（Codex 靠 arguments 里的路径）
  const texts = [];
  if (READ_SKILL_TOOLS.has(name)) {
    for (const key of ['path', 'file_path', 'target_file', 'file', 'glob_pattern', 'glob', 'pattern']) {
      if (typeof inp[key] === 'string') texts.push(inp[key]);
    }
  }
  // 整段 input（字符串或 JSON）含 SKILL.md 时扫描（对齐 tokentelemetry Codex）
  const blob = typeof input === 'string'
    ? input
    : (inp._raw || JSON.stringify(inp));
  if (typeof blob === 'string' && /SKILL\.md/i.test(blob)) texts.push(blob);

  for (const text of texts) {
    for (const raw of extractSkillNamesFromPathText(text)) {
      push(raw, `${signalPrefix}-path`);
    }
  }

  return out;
}

/** @deprecated 使用 extractSkillsFromToolCall；保留别名兼容 Cursor 调用方 */
function extractSkillsFromCursorTool(toolName, input) {
  return extractSkillsFromToolCall(toolName, input, { signalPrefix: 'cursor' });
}

/** Cursor agent-transcripts 单行 assistant 消息 */
function extractSkillsFromCursorRecord(data) {
  if (!data || data.role !== 'assistant') return [];
  const content = data.message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const t = item.type;
    if (t !== 'tool_use' && t !== 'tool-call') continue;
    out.push(...extractSkillsFromToolCall(item.name, item.input || item.arguments, { signalPrefix: 'cursor' }));
  }
  return out;
}

/**
 * WorkBuddy function span / OpenAI tool_call → Skill
 * @param {{ name?: string, toolName?: string, toolInput?: any, input?: any, arguments?: any }} spanOrCall
 */
function extractSkillsFromWorkbuddySpan(spanOrCall) {
  if (!spanOrCall || typeof spanOrCall !== 'object') return [];
  const name = spanOrCall.toolName || spanOrCall.name || spanOrCall.tool || '';
  const input = spanOrCall.toolInput ?? spanOrCall.input ?? spanOrCall.arguments;
  return extractSkillsFromToolCall(name, input, { signalPrefix: 'workbuddy' });
}

/** OpenAI 风格 tool_calls[]（generation 输出） */
function extractSkillsFromOpenAiToolCalls(toolCalls) {
  const out = [];
  for (const tc of toolCalls || []) {
    const fn = tc?.function || tc || {};
    const name = fn.name || tc?.name;
    const args = fn.arguments != null ? fn.arguments : (tc.input || tc.arguments);
    out.push(...extractSkillsFromToolCall(name, args, { signalPrefix: 'openai' }));
  }
  return out;
}

module.exports = {
  SKILL_MD_BREADCRUMB_RE,
  READ_SKILL_TOOLS,
  normalizeSkillKey,
  extractSkillNamesFromPathText,
  extractSkillsFromToolCall,
  extractSkillsFromCursorTool,
  extractSkillsFromCursorRecord,
  extractSkillsFromWorkbuddySpan,
  extractSkillsFromOpenAiToolCalls,
};
