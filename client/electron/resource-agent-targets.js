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

function listProjectableAgentIds() {
  return Object.keys(AGENT_RESOURCE_TARGETS);
}

function getAgentTarget(agentId) {
  return AGENT_RESOURCE_TARGETS[agentId] || null;
}

module.exports = {
  AGENT_RESOURCE_TARGETS,
  listProjectableAgentIds,
  getAgentTarget,
};
