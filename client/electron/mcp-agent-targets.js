// client/electron/mcp-agent-targets.js
// Token Bank 纳管 Agent 的 MCP 配置扫描/同步目标
'use strict';

const os = require('os');
const path = require('path');

function expandHome(p) {
  if (!p) return p;
  return String(p).replace(/^~(?=\/|$)/, os.homedir());
}

/**
 * 各 Agent 的 MCP 配置文件定义
 * format:
 *   json-mcp        — { mcpServers: { key: { command, args, env, url } } }
 *   toml-mcp        — [mcp_servers.key] 段（Codex）
 *   yaml-mcp-servers — config.yaml 顶层 mcp_servers（Hermes）
 *   json-nested     — 嵌套路径如 mcp.servers（OpenClaw）
 */
const AGENT_MCP_TARGETS = {
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    getPaths: () => [path.join(os.homedir(), '.cursor', 'mcp.json')],
    format: 'json-mcp',
    sync: true,
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    // Claude Code 用户级 MCP 在 ~/.claude.json 的 mcpServers（不是 ~/.claude/mcp.json）
    // CLAUDE_CONFIG_DIR 若设置，则写到 $CLAUDE_CONFIG_DIR/.claude.json
    getPaths: () => {
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      if (configDir) return [path.join(expandHome(configDir), '.claude.json')];
      return [path.join(os.homedir(), '.claude.json')];
    },
    format: 'json-mcp',
    sync: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    getPaths: () => [path.join(os.homedir(), '.codex', 'config.toml')],
    format: 'toml-mcp',
    sync: true,
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    getPaths: () => [path.join(os.homedir(), '.hermes', 'config.yaml')],
    format: 'yaml-mcp-servers',
    sync: false,
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    getPaths: () => {
      const paths = [];
      if (process.env.OPENCLAW_CONFIG_PATH) {
        paths.push(expandHome(process.env.OPENCLAW_CONFIG_PATH));
      }
      paths.push(
        path.join(os.homedir(), '.openclaw', 'openclaw.json'),
        path.join(os.homedir(), '.config', 'openclaw', 'openclaw.json'),
      );
      return [...new Set(paths)];
    },
    format: 'json-nested',
    nestedKey: 'mcp.servers',
    sync: false,
  },
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    // 官方主配置为 mcp.json；.mcp.json 亦可能含 connector-proxy 等条目，扫描时一并读取
    getPaths: () => [
      path.join(os.homedir(), '.workbuddy', 'mcp.json'),
      path.join(os.homedir(), '.workbuddy', '.mcp.json'),
    ],
    format: 'json-mcp',
    sync: true,
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    getPaths: () => [path.join(os.homedir(), '.gemini', 'settings.json')],
    format: 'json-mcp',
    sync: false,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    getPaths: () => [
      path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
      path.join(os.homedir(), '.opencode', 'opencode.json'),
    ],
    format: 'json-mcp',
    sync: false,
  },
};

/** 兼容旧 CLIENT_TARGETS 结构（mcp-client-sync 内部使用） */
const CLIENT_TARGETS = Object.fromEntries(
  Object.entries(AGENT_MCP_TARGETS).map(([id, t]) => [
    id,
    {
      id,
      label: t.label,
      getPath: () => t.getPaths()[0],
      getPaths: t.getPaths,
      format: t.format,
      nestedKey: t.nestedKey,
      sync: t.sync !== false,
    },
  ]),
);

function listAgentMcpTargets() {
  return Object.values(AGENT_MCP_TARGETS);
}

/** 支持 Token Bank 写入 MCP 配置的 Agent id 列表 */
function listSyncEnabledClientIds() {
  return Object.entries(CLIENT_TARGETS)
    .filter(([, t]) => t.sync !== false)
    .map(([id]) => id);
}

module.exports = {
  AGENT_MCP_TARGETS,
  CLIENT_TARGETS,
  listAgentMcpTargets,
  listSyncEnabledClientIds,
  expandHome,
};
