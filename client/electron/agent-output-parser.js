// Agent CLI  stdout/stderr 解析：去 ANSI、过滤噪声、解析 Claude stream-json
'use strict';

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

/** 解析 Claude Code stream-json 单行 */
function parseClaudeJsonLine(obj) {
  if (!obj || typeof obj !== 'object') return null;

  if (obj.type === 'assistant') {
    const msg = obj.message || {};
    const parts = [];
    const steps = [];

    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'text' && b.text?.trim()) {
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
      steps.push({ stepType: 'output', content: parts.join('\n') });
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
    const text = (obj.result || obj.message || '').toString().trim();
    if (text) return [{ stepType: 'output', content: text }];
  }

  if (obj.type === 'system' && obj.subtype === 'init') return null;

  // 内部遥测/重复噪声，不在 UI 展示
  const SKIP_SYSTEM = new Set([
    'thinking_tokens', 'thinking', 'rate_limit_event', 'hook_started',
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
function parseAgentOutputLine(rawLine, agentId) {
  const line = stripAnsi(rawLine).trimEnd();
  if (isNoise(line)) return [];

  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line);
      const isCodex = agentId === 'codex';
      const parsed = isCodex ? parseCodexJsonLine(obj) : parseClaudeJsonLine(obj);
      if (parsed?.length) return parsed;
      // 已消费的 JSONL 行不再当纯文本展示
      if (isCodex) return [];
      if (obj.type === 'assistant' || obj.type === 'system'
        || obj.type === 'event_msg' || obj.type === 'response_item') {
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

/**
 * 将原始 stdout 解析为步骤后，拼成可读摘要（供 MCP / 任务结果展示）
 */
function summarizeAgentStdout(rawStdout, agentId = 'claude-code') {
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

module.exports = {
  stripAnsi,
  parseAgentOutputLine,
  summarizeAgentStdout,
};
