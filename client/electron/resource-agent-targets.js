// client/electron/resource-agent-targets.js
// Agent Skill 投射目标路径（参考 aweskill / 各 Agent 默认目录）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 支持 Skill 投射的 Agent */
const AGENT_RESOURCE_TARGETS = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    getSkillRoot: () => path.join(os.homedir(), '.claude', 'skills'),
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    getSkillRoot: () => path.join(os.homedir(), '.codex', 'skills'),
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    getSkillRoot: () => {
      const candidates = [
        path.join(os.homedir(), '.cursor', 'skills'),
        path.join(os.homedir(), '.cursor', 'skills-cursor'),
      ];
      return candidates.find(p => fs.existsSync(p)) || candidates[0];
    },
  },
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    getSkillRoot: () => path.join(os.homedir(), '.workbuddy', 'skills'),
  },
};

/** 支持「提示词 → 原生斜杠命令」投射的 Agent（各自的命令/提示词目录约定不同） */
const AGENT_PROMPT_TARGETS = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    // 命名空间子目录：TB 独占，避免与用户自建 /name 命令撞名
    getPromptRoot: () => path.join(os.homedir(), '.claude', 'commands', 'tokenbank'),
    fileName: name => `${name}.md`,
    invoke: name => `/tokenbank:${name}`,
    withFrontmatter: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    getPromptRoot: () => path.join(os.homedir(), '.codex', 'prompts'),
    fileName: name => `${name}.md`,
    invoke: name => `/${name}`,
    withFrontmatter: false,
  },
};

function listProjectableAgentIds() {
  return Object.keys(AGENT_RESOURCE_TARGETS);
}

function getAgentTarget(agentId) {
  return AGENT_RESOURCE_TARGETS[agentId] || null;
}

function listPromptProjectableAgentIds() {
  return Object.keys(AGENT_PROMPT_TARGETS);
}

function getPromptTarget(agentId) {
  return AGENT_PROMPT_TARGETS[agentId] || null;
}

module.exports = {
  AGENT_RESOURCE_TARGETS,
  AGENT_PROMPT_TARGETS,
  listProjectableAgentIds,
  getAgentTarget,
  listPromptProjectableAgentIds,
  getPromptTarget,
};
