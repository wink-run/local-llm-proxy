// client/electron/resource-assistant.js
// 智能体资源解析：作为 Debug 自定义 Agent 运行
'use strict';

const ASSISTANT_ID_PREFIX = 'assistant:';

const DEFAULT_RUNTIME_AGENT = 'claude-code';

function isAssistantAgentId(agentId) {
  return String(agentId || '').startsWith(ASSISTANT_ID_PREFIX);
}

function assistantResourceId(agentId) {
  if (!isAssistantAgentId(agentId)) return null;
  return String(agentId).slice(ASSISTANT_ID_PREFIX.length);
}

/** 解析智能体配置（JSON 或纯文本 soul） */
function parseAssistantConfig(content) {
  const text = String(content || '').trim();
  if (!text) {
    return {
      soul: '',
      skills: [],
      prompts: [],
      parameters: {},
      runtime_agent: DEFAULT_RUNTIME_AGENT,
    };
  }

  if (text.startsWith('{')) {
    try {
      const raw = JSON.parse(text);
      return {
        // soul 为主字段；兼容旧版 system_prompt / systemPrompt
        soul: String(raw.soul || raw.system_prompt || raw.systemPrompt || '').trim(),
        skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
        prompts: Array.isArray(raw.prompts) ? raw.prompts.map(String) : [],
        parameters: raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : {},
        runtime_agent: String(raw.runtime_agent || raw.runtimeAgent || DEFAULT_RUNTIME_AGENT).trim()
          || DEFAULT_RUNTIME_AGENT,
      };
    } catch {
      // 回退为纯文本 soul
    }
  }

  return {
    soul: text,
    skills: [],
    prompts: [],
    parameters: {},
    runtime_agent: DEFAULT_RUNTIME_AGENT,
  };
}

/** 拼接关联 Prompt / Skill 说明到 system 上下文 */
function resolveAssistantContext(config, resourceManager) {
  const parts = [];
  if (config.soul) parts.push(config.soul);

  for (const promptName of config.prompts || []) {
    const row = resourceManager._findByTypeName('prompt', promptName);
    if (row?.content) {
      parts.push(`## ${row.display_name || promptName}\n${row.content}`);
    }
  }

  if (config.skills?.length) {
    parts.push(
      `## 可用 Skill\n请在任务中按需遵循以下 Skill：${config.skills.join('、')}`,
    );
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * 生成底层 CLI Agent 的启动参数
 * @returns {{ runtimeAgentId: string, claudeExtraArgs?: string[], promptPrefix?: string }}
 */
function buildAssistantLaunch(runtimeAgentId, systemText) {
  const system = String(systemText || '').trim();

  if (runtimeAgentId === 'claude-code') {
    const extra = [
      '-p', '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];
    if (system) extra.push('--append-system-prompt', system);
    return { runtimeAgentId, claudeExtraArgs: extra };
  }

  if (runtimeAgentId === 'codex') {
    return {
      runtimeAgentId,
      promptPrefix: system ? `${system}\n\n` : '',
    };
  }

  throw new Error(`智能体暂不支持运行时 Agent: ${runtimeAgentId}`);
}

/** 将智能体 JSON 规范为 soul 字段（去掉 system_prompt / systemPrompt） */
function formatAssistantContent(content) {
  const text = String(content || '').trim();
  if (!text) return text;
  if (!text.startsWith('{')) return text;

  try {
    const raw = JSON.parse(text);
    const config = parseAssistantConfig(text);
    const out = {};
    if (config.soul) out.soul = config.soul;
    if (config.skills?.length) out.skills = config.skills;
    if (config.prompts?.length) out.prompts = config.prompts;
    if (config.runtime_agent && config.runtime_agent !== DEFAULT_RUNTIME_AGENT) {
      out.runtime_agent = config.runtime_agent;
    }
    if (config.parameters && Object.keys(config.parameters).length) {
      out.parameters = config.parameters;
    }
    // 保留其它扩展字段，但丢弃旧版 system_prompt 键
    for (const [key, val] of Object.entries(raw)) {
      if (key === 'system_prompt' || key === 'systemPrompt' || key === 'soul'
        || key === 'skills' || key === 'prompts' || key === 'runtime_agent'
        || key === 'runtimeAgent' || key === 'parameters') continue;
      out[key] = val;
    }
    return `${JSON.stringify(out, null, 2)}\n`;
  } catch {
    return text;
  }
}

function assistantContentNeedsMigration(content) {
  const text = String(content || '').trim();
  if (!text.startsWith('{')) return false;
  try {
    const raw = JSON.parse(text);
    return Object.prototype.hasOwnProperty.call(raw, 'system_prompt')
      || Object.prototype.hasOwnProperty.call(raw, 'systemPrompt');
  } catch {
    return false;
  }
}

module.exports = {
  ASSISTANT_ID_PREFIX,
  DEFAULT_RUNTIME_AGENT,
  isAssistantAgentId,
  assistantResourceId,
  parseAssistantConfig,
  resolveAssistantContext,
  buildAssistantLaunch,
  formatAssistantContent,
  assistantContentNeedsMigration,
};
