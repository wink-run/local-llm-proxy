#!/usr/bin/env node
// Token Bank 资源发现 MCP（stdio）
// 常驻同步：能力总览、已纳管资源、社区目录、网关 API——把本软件能力体系暴露给 Agent
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  CAPABILITY_DOMAINS,
  GATEWAY_ENDPOINTS,
  gatewayBaseUrl,
  formatCapabilitiesOverview,
} = require('./tb-capabilities');
const { resolveAuthorityDir } = require('./resource-canonical');
const { parseAssistantConfig } = require('./resource-assistant');

const TOOLS = [
  {
    name: 'tb_capabilities',
    description:
      'Token Bank 能力体系总览：有哪些内置 MCP、工具、推荐工作流。'
      + '不确定能做什么、该用哪个工具时，先调本工具。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_list_resources',
    description:
      '列出 Token Bank 已纳管的资源（skill / assistant / prompt）。'
      + '做任务前可查有哪些技能与专业智能体可用；prompt 完整正文仍优先用 tb_get_prompt。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '资源类型：skill | assistant | prompt | all（默认 all）',
          enum: ['skill', 'assistant', 'prompt', 'all'],
        },
        query: {
          type: 'string',
          description: '可选关键词，匹配名称/显示名/描述',
        },
      },
    },
  },
  {
    name: 'tb_get_resource',
    description:
      '按类型+名称（或 #id）取回已纳管资源详情：skill 正文、assistant 配置摘要、prompt 元数据。'
      + 'prompt 需展开参数时请改用 tb_get_prompt。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '资源类型：skill | assistant | prompt（按名查找时建议提供）',
          enum: ['skill', 'assistant', 'prompt'],
        },
        name: {
          type: 'string',
          description: '资源 name，或 #<id>',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'tb_list_catalog',
    description:
      '列出社区/内置推荐目录中的资源（未必已纳管）。'
      + '发现未安装项后，请提示用户在 Token Bank 客户端安装，本工具不执行安装。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '目录类型：skill | assistant | prompt | all',
          enum: ['skill', 'assistant', 'prompt', 'all'],
        },
        query: { type: 'string', description: '可选关键词' },
      },
    },
  },
  {
    name: 'tb_list_gateway',
    description:
      '列出 Token Bank 本地网关可调用的 HTTP API（chat / image / embedding / tts 等）。'
      + '模型列表请用 tb_list_models；此处只说明端点与用途。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 可注入：单测 mock resource-manager */
let _resourceManager = null;

function setResourceManager(rm) {
  _resourceManager = rm || null;
}

function getResourceManager() {
  if (_resourceManager) return _resourceManager;
  return require('./resource-manager');
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    isError: !!isError,
  };
}

function readSkillBody(resource) {
  try {
    const dir = resolveAuthorityDir(resource);
    if (dir) {
      const skillMd = path.join(dir, 'SKILL.md');
      if (fs.existsSync(skillMd)) return fs.readFileSync(skillMd, 'utf8');
    }
  } catch { /* ignore */ }
  return String(resource.content || '');
}

function findManagedResource(rm, type, ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  if (raw.startsWith('#')) {
    const byId = rm.getResource(raw.slice(1).trim());
    if (byId && (!type || byId.type === type)) return byId;
    return null;
  }
  if (type) {
    const list = rm.listResources({ type });
    const hit = list.find(r => r.name === raw || r.id === raw);
    if (hit) return hit;
  }
  // 未指定 type：按 id 再按各类型名尝试
  const byId = rm.getResource(raw);
  if (byId) return byId;
  for (const t of ['skill', 'assistant', 'prompt']) {
    const list = rm.listResources({ type: t });
    const hit = list.find(r => r.name === raw);
    if (hit) return hit;
  }
  return null;
}

function formatResourceLine(r) {
  const disp = r.display_name && r.display_name !== r.name ? ` (${r.display_name})` : '';
  const desc = r.description ? `: ${String(r.description).slice(0, 120)}` : '';
  const proj = Array.isArray(r.projections) && r.projections.length
    ? ` [投射→${r.projections.map(p => p.agentId || p.agent_id).filter(Boolean).join(',')}]`
    : '';
  return `- [${r.type}] ${r.name}${disp}${desc}${proj}`;
}

function formatResourceDetail(r) {
  if (r.type === 'skill') {
    const body = readSkillBody(r);
    return [
      `# Skill: ${r.name}`,
      r.description ? `描述: ${r.description}` : '',
      r.authorityPath ? `路径: ${r.authorityPath}` : '',
      '',
      body || '(无正文)',
    ].filter(Boolean).join('\n');
  }
  if (r.type === 'assistant') {
    const cfg = parseAssistantConfig(r.content);
    return JSON.stringify({
      type: 'assistant',
      id: r.id,
      name: r.name,
      display_name: r.display_name,
      description: r.description,
      dispatch_id: `assistant:${r.id}`,
      soul_preview: String(cfg.soul || '').slice(0, 400),
      skills: cfg.skills,
      prompts: cfg.prompts,
      mcp: cfg.mcp,
      model: cfg.model || null,
      runtime_agent: cfg.runtime_agent,
      hint: '派发请用 tokenbank-agent-bridge 的 tb_dispatch_agent，agent_id=dispatch_id',
    }, null, 2);
  }
  // prompt：只返回元数据，正文走 tb_get_prompt（支持投射门控与 $ARGUMENTS）
  return JSON.stringify({
    type: 'prompt',
    id: r.id,
    name: r.name,
    display_name: r.display_name,
    description: r.description,
    hint: '取正文请用 tb_get_prompt（tokenbank-prompts）',
  }, null, 2);
}

async function handleToolCall(name, args = {}) {
  if (name === 'tb_capabilities') {
    const domainLines = CAPABILITY_DOMAINS.map(
      d => `- ${d.id}: ${d.mcp} → ${d.tools.join(', ')}`,
    ).join('\n');
    return textResult(`${formatCapabilitiesOverview()}\n\n## 域速查\n${domainLines}`);
  }

  if (name === 'tb_list_gateway') {
    const base = gatewayBaseUrl();
    const lines = GATEWAY_ENDPOINTS.map(
      e => `- ${e.method} ${base}${e.path}  [${e.capability}] ${e.note}`,
    );
    return textResult(
      `网关 base: ${base}\n模型请用 tb_list_models；鉴权用本机 Agent/应用已配置的 API Key。\n${lines.join('\n')}`,
    );
  }

  const rm = getResourceManager();

  if (name === 'tb_list_resources') {
    try {
      const type = String(args.type || 'all').toLowerCase();
      const query = String(args.query || '').trim();
      const filters = {};
      if (type && type !== 'all') filters.type = type;
      if (query) filters.query = query;
      const rows = rm.listResources(filters);
      if (!rows.length) {
        return textResult(
          type !== 'all'
            ? `（暂无已纳管的 ${type}；可用 tb_list_catalog 查看社区目录）`
            : '（暂无已纳管资源；可用 tb_list_catalog 查看社区目录）',
        );
      }
      const counts = { skill: 0, assistant: 0, prompt: 0 };
      for (const r of rows) {
        if (counts[r.type] != null) counts[r.type] += 1;
      }
      const summary = `已纳管 ${rows.length} 项：skill=${counts.skill} assistant=${counts.assistant} prompt=${counts.prompt}`;
      const lines = rows.map(formatResourceLine);
      return textResult(`${summary}\n${lines.join('\n')}`);
    } catch (e) {
      return textResult(`列出资源失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_get_resource') {
    const ref = String(args.name || args.ref || '').trim();
    if (!ref) return textResult('缺少 name', true);
    const type = args.type ? String(args.type).toLowerCase() : '';
    try {
      const r = findManagedResource(rm, type || null, ref);
      if (!r) {
        return textResult(
          `未找到资源: ${ref}${type ? ` (type=${type})` : ''}。可先 tb_list_resources 或 tb_list_catalog。`,
          true,
        );
      }
      return textResult(formatResourceDetail(r));
    } catch (e) {
      return textResult(`读取资源失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_list_catalog') {
    try {
      const type = String(args.type || 'all').toLowerCase();
      const query = String(args.query || '').trim();
      const filters = {};
      if (type && type !== 'all') filters.type = type;
      if (query) filters.query = query;
      const { items } = rm.listCatalog(filters);
      if (!items.length) return textResult('（社区目录为空）');
      const lines = items.map((it) => {
        const flag = it.installed ? '已纳管' : '未安装';
        const disp = it.display_name && it.display_name !== it.name ? ` (${it.display_name})` : '';
        const desc = it.description ? `: ${String(it.description).slice(0, 100)}` : '';
        return `- [${it.type}|${flag}] ${it.name}${disp}${desc}`;
      });
      return textResult(
        `社区/内置目录 ${items.length} 项（未安装请在 Token Bank 客户端安装）\n${lines.join('\n')}`,
      );
    } catch (e) {
      return textResult(`列出目录失败: ${e.message}`, true);
    }
  }

  return textResult(`未知工具: ${name}`, true);
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tokenbank-resources', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    handleToolCall(params?.name, params?.arguments || {})
      .then(result => send({ jsonrpc: '2.0', id, result }))
      .catch(err => send({
        jsonrpc: '2.0',
        id,
        result: textResult(err.message, true),
      }));
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      handleMessage(JSON.parse(t));
    } catch (e) {
      // 忽略非法行
    }
  });
}

module.exports = {
  TOOLS,
  handleToolCall,
  handleMessage,
  setResourceManager,
  findManagedResource,
  formatResourceDetail,
};
