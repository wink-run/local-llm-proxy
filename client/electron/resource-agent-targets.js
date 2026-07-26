// client/electron/resource-agent-targets.js
// Agent Skill / Prompt / 智能体 投射目标
// - prompt / skill：默认「已安装即可投射」
// - assistant：需 handler 勾选 resource_project（是否可投射智能体）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let shimInstaller = null;
let agentLinker = null;
try { shimInstaller = require('./shim-installer'); } catch { /* optional in CLI */ }
try { agentLinker = require('./agent-linker'); } catch { /* optional in CLI */ }

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
  'kimi-code': {
    id: 'kimi-code',
    label: 'Kimi Code',
    getSkillRoot: () => path.join(os.homedir(), '.kimi-code', 'skills'),
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    getSkillRoot: () => {
      const candidates = [
        path.join(os.homedir(), '.config', 'opencode', 'skills'),
        path.join(os.homedir(), '.opencode', 'skills'),
      ];
      return candidates.find(p => fs.existsSync(p)) || candidates[0];
    },
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    getSkillRoot: () => path.join(os.homedir(), '.hermes', 'skills'),
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    getSkillRoot: () => path.join(os.homedir(), '.openclaw', 'skills'),
  },
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    getSkillRoot: () => path.join(os.homedir(), '.workbuddy', 'skills'),
  },
};

/** 从应用目录读取勾选了 resource_project（可投射智能体）的实体 id */
function listResourceProjectableAppIds() {
  const allowed = new Set();
  try {
    const cl = require('./config-loader');
    const expanded = cl.appEntitiesExpanded?.() || [];
    for (const e of expanded) {
      if (!e?.id) continue;
      const caps = e.capabilities || {};
      if (caps.resource_project || e.resource_project) allowed.add(String(e.id));
    }
    if (!allowed.size) {
      const { expandEntity } = require('./app-handlers');
      for (const compact of cl.appEntities?.() || []) {
        if (!compact?.id || !compact?.handler) continue;
        try {
          const e = expandEntity(compact);
          if (e.resource_project || e.capabilities?.resource_project) allowed.add(String(e.id));
        } catch { /* skip unknown handler */ }
      }
    }
  } catch { /* config 未就绪 */ }
  return allowed;
}

/** macOS：/Applications 或 ~/Applications 下是否有 <Name>.app */
function macAppExists(appName) {
  if (process.platform !== 'darwin' || !appName) return false;
  for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    try {
      if (fs.existsSync(path.join(base, `${appName}.app`))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** Codex Desktop：嵌在 ChatGPT.app，或 Application Support / 本地配置存在 */
function isCodexDesktopPresent() {
  try {
    if (fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Codex'))) return true;
  } catch { /* ignore */ }
  try {
    if (fs.existsSync('/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework')) return true;
  } catch { /* ignore */ }
  // Desktop/CLI 共用配置；有 config.toml 即视为可投射目标
  try {
    if (fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml'))) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * 本机是否已安装该 Agent（投射目标用，比网关托管更宽）：
 * CLI 可执行 / App bundle / Desktop 信号均可。
 * 注意：agent-linker 未装时不要提前 false，需继续认 Desktop。
 */
function isAgentInstalled(agentId) {
  const id = String(agentId || '');
  if (!id) return false;

  try {
    const tool = agentLinker?.list?.()?.find(t => t.id === id);
    if (tool?.installed) return true;
  } catch { /* ignore */ }

  try {
    const cl = require('./config-loader');
    const ent = cl.appEntityById?.(id);
    if (ent?.detect_command && shimInstaller?.resolveRealCommand?.(ent.detect_command)) return true;
    if (ent?.proxy_mode === 'api_key') {
      if (ent.detect_type === 'command' && ent.detect_value) {
        if (shimInstaller?.resolveRealCommand?.(ent.detect_value)) return true;
      }
      if (ent.detect_type === 'appx' && ent.detect_value) {
        const appName = String(ent.detect_value).split('.').pop();
        if (macAppExists(appName)) return true;
        try {
          if (fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', appName))) return true;
        } catch { /* ignore */ }
        if (/codex/i.test(appName) && isCodexDesktopPresent()) return true;
      }
    }
  } catch { /* ignore */ }

  if (id === 'cursor') {
    if (macAppExists('Cursor')) return true;
    if (shimInstaller?.resolveRealCommand?.('cursor')) return true;
  }

  // codex CLI 未进 PATH 时，仍认 Desktop（投射目标 id 为 codex）
  if (id === 'codex' || id === 'codex-desktop') {
    if (isCodexDesktopPresent()) return true;
  }

  return false;
}

function getAgentTarget(agentId) {
  return AGENT_RESOURCE_TARGETS[agentId] || null;
}

const api = {
  AGENT_RESOURCE_TARGETS,
  listResourceProjectableAppIds,
  isAgentInstalled,
  getAgentTarget,

  /** Skill / 通用：有 Skill 根目录且本机已安装（不看 resource_project） */
  listSkillProjectableAgentIds() {
    return Object.keys(AGENT_RESOURCE_TARGETS)
      .filter(id => api.isAgentInstalled(id));
  },

  /** 智能体投射：勾选 resource_project 且已安装（codex-desktop 与 codex 共用目标） */
  listAssistantProjectableAgentIds() {
    const allowed = listResourceProjectableAppIds();
    return Object.keys(AGENT_RESOURCE_TARGETS)
      .filter(id => {
        if (!api.isAgentInstalled(id)) return false;
        if (allowed.has(id)) return true;
        // 桌面端勾选可投射时，CLI 目标 id 一并放开
        if (id === 'codex' && allowed.has('codex-desktop')) return true;
        return false;
      });
  },

  /** @deprecated 兼容旧名 → Skill 投射 */
  listProjectableAgentIds() {
    return api.listSkillProjectableAgentIds();
  },

  /**
   * prompt 投射：与 Skill 一致，本机已纳管的应用均可（不看 resource_project / sync）
   * 实际 MCP 写入仍由 mcp-client-sync 按目标格式处理
   */
  listPromptProjectableAgentIds() {
    return api.listSkillProjectableAgentIds();
  },
};

module.exports = api;
