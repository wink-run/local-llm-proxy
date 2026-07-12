#!/usr/bin/env node
// Token Bank 提示词 MCP(stdio)
// 常驻同步进各 Agent 客户端;按 TB_CLIENT_ID 只暴露投射给该 client 的 prompt
'use strict';

const readline = require('readline');
const resourceManager = require('./resource-manager');

function clientId() {
  return process.env.TB_CLIENT_ID || process.env.TB_MAIN_AGENT_ID || '';
}

const TOOLS = [
  {
    name: 'tb_get_prompt',
    description: '当用户提到「使用/按 某某 prompt(提示词)做某事」时,先用本工具按名取回该提示词正文,再据其内容执行任务。不要凭记忆臆造提示词内容。名字不确定时先用 tb_list_prompts 查询。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '提示词名称,或 #<id>' },
        args: { type: 'string', description: '可选参数,填充模板里的 $ARGUMENTS' },
      },
      required: ['name'],
    },
  },
  {
    name: 'tb_list_prompts',
    description: '列出当前 Agent 可用的 Token Bank 提示词(名称/显示名/描述),供按名取回前查询。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    isError: !!isError,
  };
}

async function handleToolCall(name, args = {}) {
  if (name === 'tb_get_prompt') {
    const ref = String(args.name || '').trim();
    const argStr = String(args.args || '').trim();
    if (!ref) return textResult('缺少 name', true);
    const r = resourceManager.resolvePromptForClient(ref, argStr, clientId());
    if (!r.found) return textResult(`未找到提示词: ${ref}(仅投射给当前 Agent 的提示词可用,可先 tb_list_prompts)`, true);
    return textResult(r.text);
  }

  if (name === 'tb_list_prompts') {
    const rows = resourceManager.listPromptsForClient(clientId());
    if (!rows.length) return textResult('(当前 Agent 暂无已投射的提示词)');
    const lines = rows.map(p => {
      const disp = p.display_name && p.display_name !== p.name ? `(${p.display_name})` : '';
      return `- ${p.name}${disp}${p.description ? `: ${p.description}` : ''}`;
    });
    return textResult(lines.join('\n'));
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
        serverInfo: { name: 'tokenbank-prompts', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    handleToolCall(toolName, toolArgs)
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

// stdio JSON-RPC(每行一条消息)——仅作为独立进程运行时启动,便于单测 require
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

module.exports = { TOOLS, handleToolCall, handleMessage };
