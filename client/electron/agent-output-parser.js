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

  // Claude stream-json 系统事件（API 重试、hook 等）
  if (obj.type === 'system' && obj.subtype) {
    return [{
      stepType: 'system_event',
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
      const parsed = parseClaudeJsonLine(obj);
      if (parsed?.length) return parsed;
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

module.exports = {
  stripAnsi,
  parseAgentOutputLine,
};
