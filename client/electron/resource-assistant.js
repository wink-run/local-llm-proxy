// client/electron/resource-assistant.js
// Assistant 资源解析：作为 Debug 自定义 Agent 运行
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

/** 解析 Assistant 配置（JSON 或纯文本 system prompt） */
function parseAssistantConfig(content) {
  const text = String(content || '').trim();
  if (!text) {
    return {
      system_prompt: '',
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
        system_prompt: String(raw.system_prompt || raw.systemPrompt || '').trim(),
        skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
        prompts: Array.isArray(raw.prompts) ? raw.prompts.map(String) : [],
        parameters: raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : {},
        runtime_agent: String(raw.runtime_agent || raw.runtimeAgent || DEFAULT_RUNTIME_AGENT).trim()
          || DEFAULT_RUNTIME_AGENT,
      };
    } catch {
      // 回退为纯文本 system prompt
    }
  }

  return {
    system_prompt: text,
    skills: [],
    prompts: [],
    parameters: {},
    runtime_agent: DEFAULT_RUNTIME_AGENT,
  };
}

/** 拼接关联 Prompt / Skill 说明到 system 上下文 */
function resolveAssistantContext(config, resourceManager) {
  const parts = [];
  if (config.system_prompt) parts.push(config.system_prompt);

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
      '--output-format', 'stream-json', '--verbose',
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

  throw new Error(`Assistant 暂不支持运行时 Agent: ${runtimeAgentId}`);
}

module.exports = {
  ASSISTANT_ID_PREFIX,
  DEFAULT_RUNTIME_AGENT,
  isAssistantAgentId,
  assistantResourceId,
  parseAssistantConfig,
  resolveAssistantContext,
  buildAssistantLaunch,
};
