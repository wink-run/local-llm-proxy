// Agent CLI  stdout/stderr 解析：去 ANSI、过滤噪声、解析 Claude stream-json
'use strict';

const { expandMixedOutputSteps, normalizeLoose, looksLikeInlineReasoning, hasReasoningMeta, splitInlineReasoning, dedupeRepeatedText } = require('./inline-reasoning-split.cjs');

/** 去掉 ANSI 转义（含未带 ESC 的 [33m 形式） */
function stripAnsi(text) {
  return String(text || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\[[0-9;]+m/g, '');
}

const NOISE_PATTERNS = [
  /^Warning: no stdin data received/i,
  /^Reading additional input from stdin/i,
  /^failed to load skill/i,
  /^ERROR:/i,
  /^$/,
  /^[\s\-_=]+$/,
  // Codex CLI stderr（Rust 日志 / OAuth / MCP 连接失败）
  /Failed to refresh token/i,
  /failed to refresh available models/i,
  /worker quit with fatal/i,
  /failed to connect to websocket/i,
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+ERROR\s/i,
];

function isNoise(line) {
  const t = line.trim();
  if (!t) return true;
  return NOISE_PATTERNS.some(p => p.test(t));
}

function msgText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(b => (b?.type === 'text' ? b.text : b?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => b?.text || '').filter(Boolean).join('\n');
  }
  return JSON.stringify(content, null, 2);
}

/** 解析 hook_response.output 内嵌 JSON，提取可读文本 */
function parseHookResponseOutput(obj) {
  const hookName = obj.hook_name || obj.hook_event || 'Hook';
  let payload = obj.output;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }

  const ctx = payload?.hookSpecificOutput?.additionalContext;
  if (typeof ctx === 'string' && ctx.trim()) {
    const text = ctx.trim();
    // 会话启动 hook 常注入超长 skill 说明，UI 只展示摘要
    if (/using-superpowers|EXTREMELY_IMPORTANT/i.test(text) && text.length > 400) {
      return [{
        stepType: 'system_event',
        content: `${hookName}：会话上下文已加载`,
        system_subtype: 'hook_response',
      }];
    }
    if (text.length <= 1200) {
      return [{ stepType: 'output', content: text }];
    }
    return [{
      stepType: 'system_event',
      content: `${hookName}：上下文就绪（${text.length} 字）`,
      system_subtype: 'hook_response',
    }];
  }

  const msg = payload?.message || obj.message;
  if (typeof msg === 'string' && msg.trim()) {
    return [{ stepType: 'system_event', content: msg.trim(), system_subtype: 'hook_response' }];
  }

  return [{
    stepType: 'system_event',
    content: `${hookName} 已响应`,
    system_subtype: 'hook_response',
  }];
}

/** Claude CLI 顶层 SDK 事件（参考 claude-code-reverse SDKMessageSchema），UI 不展示 */
const SKIP_TOP_LEVEL_JSON_TYPES = new Set([
  'rate_limit_event',
  'keep_alive',
  'auth_status',
  'tool_progress',
  'tool_use_summary',
  'prompt_suggestion',
  'control_request',
  'control_response',
  'control_cancel_request',
  'update_environment_variables',
  'task_notification',
  'task_started',
  'task_progress',
]);

/** Claude Code 启动警告：注入 API Key 时 CLI 会 prepend 到回复里 */
const CONNECTOR_WARNING_RE = /⚠️\s*claude\.ai connectors are disabled[\s\S]*?(?=\n\n|\n[^·]|$)/i;

function splitConnectorWarning(text) {
  const raw = String(text || '');
  const m = raw.match(CONNECTOR_WARNING_RE);
  if (!m) return { steps: [{ stepType: 'output', content: raw }], changed: false };
  const warning = m[0].trim();
  const rest = raw.slice(m.index + m[0].length).replace(/^\s+/, '');
  const steps = [];
  if (warning) {
    steps.push({
      stepType: 'system_event',
      content: warning,
      system_subtype: 'claude_connector_warning',
    });
  }
  if (rest) steps.push({ stepType: 'output', content: rest });
  return { steps, changed: true };
}

/** thinking 增量末尾误含 markdown/诗题开头 → 拆出 output */
function splitThinkingDeltaLeak(text) {
  const raw = String(text || '');
  const m = raw.match(/^(.*?)(\*\*\s*[《「][\s\S]*)$/)
    || raw.match(/^(.*?)(\*\s*[《「][\s\S]*)$/);
  if (m && m[1].trim().length >= 12 && hasReasoningMeta(m[1])) {
    return [
      { stepType: 'thinking', content: m[1].trim() },
      { stepType: 'output', content: m[2].trim() },
    ];
  }
  return null;
}

/** 是否与前序 output 重复（delta + 快照 + assistant 块） */
function isRedundantOutput(state, text) {
  const t = String(text || '').trim();
  const prev = String(state?.lastOutput || '').trim();
  if (!t || !prev) return false;
  if (t === prev) return true;
  const tn = normalizeLoose(t);
  const pn = normalizeLoose(prev);
  if (tn === pn) return true;
  return pn.startsWith(tn) || tn.startsWith(pn);
}

/** 是否与前序 thinking 重复（delta + 快照 + assistant 块） */
function isRedundantThinking(state, text) {
  const t = String(text || '').trim();
  const prev = String(state?.lastThinking || '').trim();
  if (!t || !prev) return false;
  if (t === prev) return true;
  const tn = normalizeLoose(t);
  const pn = normalizeLoose(prev);
  if (tn === pn) return true;
  return pn.startsWith(tn) || tn.startsWith(pn);
}

/** 合并 thinking 增量（供 streamState 跟踪） */
function mergeThinkingText(prev, next) {
  const a = String(prev || '');
  const b = String(next || '');
  if (!b) return a;
  if (!a || b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  return a + b;
}

/** 初始化/补全 stream-json 解析状态（对齐 CC stream_event 生命周期） */
function ensureStreamState(streamState) {
  if (!streamState) return null;
  if (!streamState.blockTypes) streamState.blockTypes = new Map();
  if (!streamState.blockTexts) streamState.blockTexts = new Map();
  if (streamState.streaming == null) streamState.streaming = false;
  if (streamState.messageId == null) streamState.messageId = null;
  if (streamState.lastThinking == null) streamState.lastThinking = '';
  if (streamState.lastOutput == null) streamState.lastOutput = '';
  return streamState;
}

/**
 * 解析 content_block_delta 文本：区分 token 增量 vs CCR 全量快照
 * （ccrClient.accumulateStreamEvents 会把 text_delta 合并为 full-so-far）
 */
function resolveBlockDelta(state, index, incoming) {
  const next = String(incoming || '');
  if (!next) return null;

  const prev = state?.blockTexts?.get(index) || '';
  if (next === prev) return null;

  // 全量快照：新文本包含已有内容 → 替换而非拼接
  if (prev && next.startsWith(prev)) {
    state?.blockTexts?.set(index, next);
    return { text: next, is_delta: false, is_snapshot: true };
  }

  // 单 token 增量
  const merged = prev + next;
  state?.blockTexts?.set(index, merged);
  return { text: next, is_delta: true, is_snapshot: false };
}

function hasBlockType(blocks, type) {
  if (!blocks) return false;
  for (const t of blocks.values()) {
    if (t === type) return true;
  }
  return false;
}

/** 解析 Claude Code stream-json 单行；streamState 跟踪 content_block 类型 */
function parseClaudeJsonLine(obj, streamState) {
  if (!obj || typeof obj !== 'object') return null;

  const state = ensureStreamState(streamState);

  // 顶层 rate_limit_event 等遥测，与 system.subtype 形式等价处理
  if (SKIP_TOP_LEVEL_JSON_TYPES.has(obj.type)) return null;

  // stream-json + --include-partial-messages：token 级 text/thinking 增量
  if (obj.type === 'stream_event') {
    const evt = obj.event || {};
    const blocks = state?.blockTypes;

    // CC 流式生命周期：message_start → content_block_* → message_delta → message_stop
    if (evt.type === 'message_start') {
      blocks?.clear();
      state?.blockTexts?.clear();
      if (state) {
        state.streaming = true;
        state.messageId = evt.message?.id || null;
        state.lastThinking = '';
        state.lastOutput = '';
      }
      return [];
    }
    if (evt.type === 'message_stop') {
      // 流式结束前刷新 blockTexts，避免仅有 assistant 快照、无 delta 时丢回复
      const flushSteps = [];
      if (state?.blockTexts?.size) {
        for (const [idx, text] of state.blockTexts.entries()) {
          const t = String(text || '').trim();
          if (!t) continue;
          const blockType = blocks?.get(idx);
          if (blockType === 'thinking' || blockType === 'redacted_thinking') {
            if (isRedundantThinking(state, t)) continue;
            if (state) state.lastThinking = t;
            flushSteps.push({ stepType: 'thinking', content: t, is_snapshot: true });
          } else {
            if (isRedundantOutput(state, t)) continue;
            if (state) state.lastOutput = t;
            flushSteps.push({ stepType: 'output', content: t, is_snapshot: true });
          }
        }
      }
      blocks?.clear();
      state?.blockTexts?.clear();
      if (state) {
        state.streaming = false;
        state.messageId = null;
      }
      return flushSteps;
    }
    if (evt.type === 'message_delta') {
      return [];
    }

    if (evt.type === 'content_block_start') {
      const bt = evt.content_block?.type || 'text';
      blocks?.set(evt.index, bt);
      return [];
    }
    // 保留 block 类型直到 message_stop（不在 stop 时 delete，避免后续 delta 误判）
    if (evt.type === 'content_block_stop') {
      return [];
    }

    if (evt.type === 'content_block_delta') {
      const delta = evt.delta || {};
      const blockType = blocks?.get(evt.index);

      if (delta.type === 'signature_delta' || delta.type === 'input_json_delta') return [];

      // thinking 块：thinking_delta（CC claude.ts 严格校验 block.type === 'thinking'）
      const isThinkingBlock = blockType === 'thinking' || blockType === 'redacted_thinking';
      if (delta.type === 'thinking_delta' || (isThinkingBlock && delta.type !== 'text_delta')) {
        const raw = delta.thinking || delta.text || '';
        const resolved = resolveBlockDelta(state, evt.index, raw);
        if (!resolved) return [];

        const leak = splitThinkingDeltaLeak(resolved.text);
        if (leak) {
          return leak.map(s => ({
            ...s,
            is_delta: resolved.is_delta,
            is_snapshot: resolved.is_snapshot,
          }));
        }
        if (state) {
          state.lastThinking = resolved.is_snapshot
            ? resolved.text
            : mergeThinkingText(state.lastThinking, resolved.text);
        }
        return [{
          stepType: 'thinking',
          content: resolved.text,
          is_delta: resolved.is_delta,
          is_snapshot: resolved.is_snapshot,
        }];
      }

      // text 块：text_delta → 用户可见回复（CC extractTextContent 仅取 text 块）
      if (delta.type === 'text_delta' && delta.text) {
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          const resolved = resolveBlockDelta(state, evt.index, delta.text);
          if (!resolved) return [];
          if (state) {
            state.lastThinking = resolved.is_snapshot
              ? resolved.text
              : mergeThinkingText(state.lastThinking, resolved.text);
          }
          return [{
            stepType: 'thinking',
            content: resolved.text,
            is_delta: resolved.is_delta,
            is_snapshot: resolved.is_snapshot,
          }];
        }
        if (blockType && blockType !== 'text') return [];

        const resolved = resolveBlockDelta(state, evt.index, delta.text);
        if (!resolved) return [];

        // 异常：尚无 text 块、text_delta 却像英文 meta → 归入 thinking（兜底）
        if (!hasBlockType(blocks, 'text') && hasBlockType(blocks, 'thinking')
          && looksLikeInlineReasoning(resolved.text)) {
          if (state) {
            state.lastThinking = resolved.is_snapshot
              ? resolved.text
              : mergeThinkingText(state.lastThinking, resolved.text);
          }
          return [{
            stepType: 'thinking',
            content: resolved.text,
            is_delta: resolved.is_delta,
            is_snapshot: resolved.is_snapshot,
          }];
        }

        const split = splitConnectorWarning(resolved.text);
        if (split.changed) {
          return split.steps.map(s => ({
            ...s,
            is_delta: s.system_subtype ? false : resolved.is_delta,
            is_snapshot: s.system_subtype ? false : resolved.is_snapshot,
          }));
        }
        if (state) {
          const full = String(state.blockTexts?.get(evt.index) || resolved.text || '').trim();
          if (full) state.lastOutput = full;
        }
        return [{
          stepType: 'output',
          content: resolved.text,
          is_delta: resolved.is_delta,
          is_snapshot: resolved.is_snapshot,
        }];
      }
    }
    return [];
  }

  // CC streamlined 输出：仅保留 text，thinking/tool_use 已剥离
  if (obj.type === 'streamlined_text' && obj.text?.trim()) {
    return [{ stepType: 'output', content: obj.text.trim(), is_snapshot: true }];
  }
  if (obj.type === 'streamlined_tool_use_summary' && obj.tool_summary?.trim()) {
    return [{
      stepType: 'system_event',
      content: obj.tool_summary.trim(),
      system_subtype: 'tool_use_summary',
    }];
  }

  if (obj.type === 'assistant') {
    // partial-messages 流式快照与 stream_event 重复，streaming 期间跳过
    if (state?.streaming) return null;

    const msg = obj.message || {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const parts = [];
    const steps = [];

    // CC content_block_stop 逐块产出 assistant（thinking-only / text-only 分离）
    if (blocks.length) {
      for (const b of blocks) {
        if (b?.type === 'thinking' || b?.type === 'reasoning' || b?.type === 'redacted_thinking') {
          // --include-partial-messages 下与 stream_event 重复
          if (state?.streaming) continue;
          if (parts.length) {
            steps.push({ stepType: 'output', content: parts.join('\n'), is_snapshot: true });
            parts.length = 0;
          }
          const think = String(b.thinking || b.text || '').trim();
          if (think) {
            if (isRedundantThinking(state, think)) continue;
            if (state) state.lastThinking = think;
            steps.push({ stepType: 'thinking', content: think, is_snapshot: true });
          }
        } else if (b?.type === 'text' && b.text?.trim()) {
          parts.push(b.text.trim());
        } else if (b?.type === 'tool_use') {
          if (parts.length) {
            steps.push({ stepType: 'output', content: parts.join('\n') });
            parts.length = 0;
          }
          const inputStr = b.input && typeof b.input === 'object'
            ? JSON.stringify(b.input, null, 2)
            : String(b.input || '');
          steps.push({
            stepType: 'tool_call',
            tool_name: b.name || 'tool',
            content: inputStr || '(无参数)',
          });
        }
      }
    } else {
      const text = msgText(msg).trim();
      if (text) parts.push(text);
    }

    if (parts.length) {
      const joined = parts.join('\n');
      if (isRedundantOutput(state, joined)) {
        parts.length = 0;
      }
    }

    if (parts.length) {
      const joined = parts.join('\n');
      const split = splitConnectorWarning(joined);
      if (split.changed) {
        for (const s of split.steps) {
          if (s.stepType === 'output' && isRedundantOutput(state, s.content)) continue;
          if (s.stepType === 'output' && state) state.lastOutput = String(s.content || '').trim();
          steps.push({ ...s, is_snapshot: s.stepType === 'output' });
        }
      } else {
        if (state) state.lastOutput = joined;
        steps.push({ stepType: 'output', content: joined, is_snapshot: true });
      }
    }
    return steps.length ? steps : null;
  }

  if (obj.type === 'user') {
    const msg = obj.message || {};
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'tool_result') {
          const text = toolResultText(b.content).trim();
          if (text) {
            return [{ stepType: b.is_error ? 'terminal' : 'output', content: text }];
          }
        }
      }
    }
    return null;
  }

  if (obj.type === 'result') {
    let text = '';
    if (typeof obj.result === 'string') text = obj.result;
    else if (obj.result && typeof obj.result === 'object') {
      text = String(obj.result.text || obj.result.content || obj.result.message || '').trim();
    }
    if (!text) text = String(obj.message || obj.output || '').trim();
    if (!text) return null;
    if (isRedundantOutput(state, text)) return null;
    if (state) state.lastOutput = text;
    return [{ stepType: 'output', content: text, is_snapshot: true }];
  }

  if (obj.type === 'system' && obj.subtype === 'init') return null;

  // 内部遥测/进度事件（对齐 CC print.ts 过滤列表）
  const SKIP_SYSTEM = new Set([
    'thinking_tokens', 'thinking', 'rate_limit_event', 'hook_started',
    'hook_progress', 'task_notification', 'task_started', 'task_progress',
    'post_turn_summary', 'session_state_changed', 'status',
  ]);
  if (obj.type === 'system' && obj.subtype && SKIP_SYSTEM.has(obj.subtype)) return null;

  // SessionStart 等 hook 回调：解析 output 内嵌 JSON
  if (obj.type === 'system' && obj.subtype === 'hook_response') {
    return parseHookResponseOutput(obj);
  }

  // Claude stream-json 系统事件（API 重试等）
  if (obj.type === 'system' && obj.subtype) {
    const content = obj.subtype === 'api_retry'
      ? `API 重试 ${obj.attempt ?? '?'}/${obj.max_retries ?? '?'}`
      : String(obj.message || obj.subtype || 'system');
    return [{
      stepType: 'system_event',
      content,
      system_subtype: obj.subtype,
      attempt: obj.attempt,
      max_retries: obj.max_retries,
      retry_delay_ms: obj.retry_delay_ms,
      error_status: obj.error_status,
      message: obj.message || obj.error || null,
    }];
  }

  return null;
}

/** 解析 Codex exec --json JSONL 单行（含新版 item.completed 格式） */
function parseCodexJsonLine(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // 会话/轮次元数据，UI 不展示
  const SKIP_TYPES = new Set([
    'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
    'item.started',
  ]);
  if (SKIP_TYPES.has(obj.type)) return [];

  // 新版 Codex JSONL：item.completed 携带 reasoning / agent_message
  if (obj.type === 'item.completed') {
    const item = obj.item || {};
    const text = String(item.text || item.message || msgText(item) || '').trim();
    if (!text) return [];

    if (item.type === 'reasoning') {
      return [{ stepType: 'thinking', content: text }];
    }
    if (item.type === 'agent_message' || item.type === 'message') {
      return [{ stepType: 'output', content: text }];
    }
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const inputStr = typeof item.arguments === 'string'
        ? item.arguments
        : JSON.stringify(item.arguments || item.input || {}, null, 2);
      return [{
        stepType: 'tool_call',
        tool_name: item.name || 'tool',
        content: inputStr || text || '(无参数)',
      }];
    }
    if (item.type === 'function_call_output' || item.type === 'tool_result') {
      return [{ stepType: 'output', content: toolResultText(item.output ?? item.content ?? text).trim() }];
    }
    return [{ stepType: 'output', content: text }];
  }

  if (obj.type === 'event_msg') {
    const pt = obj.payload?.type;
    if (pt === 'agent_message') {
      const text = String(obj.payload.message || '').trim();
      if (text) return [{ stepType: 'output', content: text }];
    }
    if (pt === 'token_count' || pt === 'stream_error') return null;
    return null;
  }

  if (obj.type === 'response_item') {
    const p = obj.payload || {};
    if (p.type === 'function_call') {
      const inputStr = typeof p.arguments === 'string'
        ? p.arguments
        : JSON.stringify(p.arguments || {}, null, 2);
      return [{
        stepType: 'tool_call',
        tool_name: p.name || 'tool',
        content: inputStr || '(无参数)',
      }];
    }
    if (p.type === 'function_call_output' || p.type === 'tool_result') {
      const text = toolResultText(p.output ?? p.content).trim();
      if (text) return [{ stepType: 'output', content: text }];
    }
    if (p.type === 'message' && p.role === 'assistant') {
      const text = msgText({ content: p.content }).trim();
      if (text) return [{ stepType: 'output', content: text }];
    }
    if (p.type === 'reasoning') {
      const text = msgText({ content: p.content }).trim();
      if (text) return [{ stepType: 'thinking', content: text }];
    }
  }

  return null;
}

function detectPlainStepType(line) {
  if (/thinking|analyzing|reasoning/i.test(line)) return 'thinking';
  if (/tool use|using tool|calling tool|tool:|^\s*⎿/i.test(line)) return 'tool_call';
  if (/edit:|modif|wrote|created|updated file/i.test(line)) return 'code_edit';
  if (/^\$\s|run:|execut|bash:|shell:/i.test(line)) return 'terminal';
  return 'output';
}

/**
 * 解析单行 CLI 输出 → 0..n 个步骤 { stepType, content, tool_name? }
 */
function parseAgentOutputLine(rawLine, agentId, streamState) {
  const line = stripAnsi(rawLine).trimEnd();
  if (isNoise(line)) return [];

  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line);
      const isCodex = agentId === 'codex';
      const parsed = isCodex ? parseCodexJsonLine(obj) : parseClaudeJsonLine(obj, streamState);
      if (parsed?.length) return expandMixedOutputSteps(parsed);
      // 已消费的 JSONL 行不再当纯文本展示
      if (isCodex) return [];
      if (obj.type === 'assistant' || obj.type === 'system'
        || obj.type === 'event_msg' || obj.type === 'response_item'
        || obj.type === 'stream_event'
        || obj.type === 'streamlined_text'
        || obj.type === 'streamlined_tool_use_summary'
        || SKIP_TOP_LEVEL_JSON_TYPES.has(obj.type)) {
        return [];
      }
    } catch {
      // 非完整 JSON，走纯文本
    }
  }

  const trimmed = line.trim();
  if (!trimmed || isNoise(trimmed)) return [];

  return [{
    stepType: detectPlainStepType(trimmed),
    content: trimmed,
  }];
}

/** 判断字符串是否像文件路径（排除误匹配的 skill 正文等） */
function isLikelyFilePath(raw) {
  const p = String(raw || '').trim();
  if (!p || p.length > 512) return false;
  // 含转义换行或真实换行 → 多半是正文而非路径
  if (/\\n|\\r|[\n\r]/.test(p)) return false;
  if (/^#+\s|^---|\*\*/.test(p)) return false;
  if (/^(true|false|null)$/i.test(p)) return false;
  return /[/\\]/.test(p) || /\.[a-z0-9]{1,8}$/i.test(p) || /^[\w.-]+$/.test(p);
}

/**
 * 从 CLI stdout 提取 Write/Edit 等工具修改的文件路径
 * - 优先解析 stream-json 中的 tool_use
 * - 跳过 JSON 行内的 Created: 误匹配（避免把 skill 正文当路径）
 */
function extractModifiedFiles(rawStdout) {
  const files = [];
  const seen = new Set();

  const addFile = (filePath, operation) => {
    const p = String(filePath || '').trim();
    if (!isLikelyFilePath(p)) return;
    const op = String(operation || 'modified').toLowerCase();
    const key = `${op}:${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ path: p, operation: op });
  };

  for (const line of String(rawStdout || '').split('\n')) {
    const trimmed = stripAnsi(line).trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          for (const b of obj.message.content) {
            if (b?.type !== 'tool_use') continue;
            const name = String(b.name || '').toLowerCase();
            const input = b.input && typeof b.input === 'object' ? b.input : {};
            const fp = input.file_path || input.path || input.file;
            if (!fp) continue;
            if (name === 'write') addFile(fp, 'created');
            else if (name === 'edit' || name === 'multiedit') addFile(fp, 'modified');
          }
        }
      } catch { /* 非完整 JSON */ }
      continue;
    }

    // 纯文本行 fallback（整行匹配，避免 JSON 子串误伤）
    const match = trimmed.match(/^(Created|Modified|Edited):\s+(.+)$/i);
    if (match) addFile(match[2].trim(), match[1].toLowerCase());
  }

  return files;
}

/** Claude Code --output-format json：提取最终 result 对象 */
function extractClaudeResultObject(rawStdout) {
  const lines = stripAnsi(rawStdout).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.type === 'result') return obj;
    } catch { /* ignore */ }
  }
  const trimmed = stripAnsi(rawStdout).trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.type === 'result') return obj;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Claude Code 同步 JSON 输出 → 步骤（进程结束后一次性解析）
 */
function parseClaudeSyncStdout(rawStdout) {
  const obj = extractClaudeResultObject(rawStdout);
  if (!obj) return { steps: [], sessionId: extractCliSessionId(rawStdout, 'claude-code') };

  const sessionId = normalizeCliSessionId(obj.session_id || obj.sessionId);

  if (obj.is_error || obj.subtype === 'error_during_execution') {
    const err = Array.isArray(obj.errors) && obj.errors.length
      ? obj.errors.join('\n')
      : (typeof obj.error === 'string' ? obj.error.trim() : 'Agent 执行失败');
    return {
      steps: [{ stepType: 'terminal', content: err, is_snapshot: true }],
      sessionId,
      error: err,
    };
  }

  let rawResult = dedupeRepeatedText(String(obj.result || '').trim());
  if (!rawResult) return { steps: [], sessionId };

  const steps = expandMixedOutputSteps(splitInlineReasoning(rawResult))
    .map(s => ({ ...s, is_snapshot: true }));

  if (!steps.length) {
    steps.push({ stepType: 'output', content: rawResult, is_snapshot: true });
  }

  return { steps, sessionId, error: null };
}

/** 从 CLI stdout 提取 session/thread id，供续接对话 */
function normalizeCliSessionId(raw) {
  const s = String(raw || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    ? s
    : null;
}

function extractCliSessionId(rawStdout, agentId = 'claude-code') {
  for (const line of String(rawStdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (agentId === 'codex' && obj.type === 'thread.started') {
        return normalizeCliSessionId(obj.thread_id || obj.threadId);
      }
      if (obj.type === 'system' && obj.subtype === 'init') {
        return normalizeCliSessionId(obj.session_id || obj.sessionId);
      }
      if (obj.type === 'result') {
        return normalizeCliSessionId(obj.session_id || obj.sessionId);
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** stream-json 中 result 标记失败（exit 0 但执行出错，如 --resume 无效） */
function detectAgentExecutionFailure(rawStdout) {
  for (const line of String(rawStdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type !== 'result') continue;
      if (!obj.is_error && obj.subtype !== 'error_during_execution') continue;
      if (Array.isArray(obj.errors) && obj.errors.length) return obj.errors.join('\n');
      if (typeof obj.error === 'string' && obj.error.trim()) return obj.error.trim();
      return 'Agent 执行失败';
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 将原始 stdout 解析为步骤后，拼成可读摘要（供 MCP / 任务结果展示）
 */
function summarizeAgentStdout(rawStdout, agentId = 'claude-code') {
  if (agentId === 'claude-code') {
    const sync = parseClaudeSyncStdout(rawStdout);
    const outputs = sync.steps
      .filter(s => s.stepType === 'output' && s.content?.trim())
      .map(s => s.content.trim());
    if (outputs.length) return outputs.join('\n\n');
  }

  const lines = String(rawStdout || '').split('\n');
  const parts = [];
  for (const line of lines) {
    for (const step of parseAgentOutputLine(line, agentId)) {
      if (step.stepType === 'output' && step.content?.trim()) {
        parts.push(step.content.trim());
      } else if (step.stepType === 'tool_call' && step.content) {
        parts.push(`[工具 ${step.tool_name || 'call'}]\n${step.content}`);
      } else if (step.stepType === 'system_event' && step.content) {
        parts.push(step.content);
      }
    }
  }
  const summary = parts.join('\n\n').trim();
  if (summary) return summary;

  // 兜底：尝试从原始 JSONL 提取 agent_message / item.completed
  if (agentId === 'codex') {
    const fallback = [];
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
          const t = String(obj.item.text || '').trim();
          if (t) fallback.push(t);
        }
      } catch { /* ignore */ }
    }
    if (fallback.length) return fallback.join('\n\n');
  }

  const trimmed = stripAnsi(rawStdout).trim();
  return trimmed || '(无输出)';
}

/** 从 stderr 内嵌 JSON 提取 error.message */
function extractJsonErrorMessage(text) {
  const m = String(text || '').match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

/**
 * Agent 非零退出时，将冗长 stderr 提炼为可读错误（避免整墙日志抛给 UI）
 */
function formatAgentExitError(rawStderr, rawStdout, exitCode, agentId = 'claude-code', signal = null) {
  const execFail = detectAgentExecutionFailure(rawStdout);
  if (execFail) return execFail;

  const stderr = stripAnsi(rawStderr || '');
  const stdout = stripAnsi(rawStdout || '');
  const combined = `${stderr}\n${stdout}`.trim();

  if (!combined) {
    if (signal) return `Agent 进程被中断 (${signal})，请重试或检查工作目录与 CLI 状态`;
    if (exitCode == null) {
      return 'Agent 进程异常结束（无输出），可能被中断、工作目录无效或 CLI 未正常启动';
    }
    return `Agent 异常退出 (code ${exitCode})`;
  }

  // Codex / OpenAI OAuth：refresh token 已被轮换
  if (/refresh_token_reused|refresh token.*already been used|refresh token was already used/i.test(combined)) {
    const hint = agentId === 'codex'
      ? '请在终端执行 `codex logout && codex login` 重新登录，或在 Codex Desktop 退出后重新登录。'
      : '请在对应 CLI 中退出并重新登录。';
    return `Agent 登录凭证已失效（refresh token 已被使用）。${hint}`;
  }

  if (/token_expired|authentication token is expired/i.test(combined)) {
    const hint = agentId === 'codex' ? '请执行 `codex login` 重新登录。' : '请重新登录对应 Agent CLI。';
    return `Agent 访问令牌已过期。${hint}`;
  }

  if (/failed to refresh token/i.test(combined)) {
    const jsonMsg = extractJsonErrorMessage(combined);
    const hint = agentId === 'codex' ? '建议执行 `codex logout && codex login`。' : '';
    if (jsonMsg && !/already been used|already used/i.test(jsonMsg)) {
      return `Agent 无法刷新登录凭证：${jsonMsg}${hint ? ` ${hint}` : ''}`;
    }
    return `Agent 认证失败，无法刷新登录凭证。${hint || '请重新登录。'}`;
  }

  if (/401 unauthorized/i.test(combined) && /websocket|codex_api|chatgpt\.com/i.test(combined)) {
    const hint = agentId === 'codex' ? '请执行 `codex login` 重新登录。' : '';
    return `Agent 无法连接服务 (401 Unauthorized)。${hint || '请检查登录状态。'}`;
  }

  if (/401 unauthorized/i.test(combined)) {
    return 'Agent 认证失败 (401 Unauthorized)。请重新登录。';
  }

  // 兜底：去重、去噪后取前几行
  const seen = new Set();
  const lines = [];
  for (const line of combined.split('\n')) {
    let t = line.trim();
    if (!t || isNoise(t)) continue;
    t = t.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+ERROR\s+\S+:\s*/i, '');
    t = t.replace(/^ERROR:\s*/i, '').trim();
    if (!t || isNoise(t)) continue;
    const key = t.replace(/\s+/g, ' ').slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(t);
  }

  if (lines.length) {
    const summary = lines.slice(0, 3).join('\n');
    const truncated = summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;
    return `Agent 异常退出 (code ${exitCode})：\n${truncated}`;
  }

  return `Agent 异常退出 (code ${exitCode})`;
}

module.exports = {
  stripAnsi,
  parseAgentOutputLine,
  summarizeAgentStdout,
  extractModifiedFiles,
  isLikelyFilePath,
  extractCliSessionId,
  normalizeCliSessionId,
  detectAgentExecutionFailure,
  formatAgentExitError,
  extractClaudeResultObject,
  parseClaudeSyncStdout,
};
