#!/usr/bin/env node
// Token Bank Agent 派发 MCP（stdio）
// 供主 Agent（Claude Code）调用，向已纳管的其他 Agent 派发子任务
'use strict';

const readline = require('readline');
const agentExecutor = require('./agent-executor');

const PARENT_TASK_ID = process.env.TB_PARENT_TASK_ID || '';
const WORKING_DIR = process.env.TB_WORKING_DIR || process.cwd();

const TOOLS = [
  {
    name: 'tb_list_agents',
    description: '列出 Token Bank 已纳管、可派发的 Agent（不要用 shell which 探测）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_dispatch_agent',
    description: '向指定 Agent 派发子任务并等待完成。禁止自己在终端运行 codex/claude 等 CLI，必须用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: '目标 Agent ID，如 codex、claude-code',
        },
        prompt: {
          type: 'string',
          description: '交给该 Agent 的具体任务描述',
        },
      },
      required: ['agent_id', 'prompt'],
    },
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
  if (name === 'tb_list_agents') {
    const agents = await agentExecutor.listAvailableAgents();
    const lines = agents.map(a =>
      `- ${a.id}: ${a.name}${a.version ? ` (v${a.version})` : ''} [${(a.capabilities || []).join(', ')}]`,
    );
    return textResult(lines.length ? lines.join('\n') : '（无可用 Agent）');
  }

  if (name === 'tb_dispatch_agent') {
    const agentId = String(args.agent_id || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!agentId || !prompt) {
      return textResult('缺少 agent_id 或 prompt', true);
    }

    try {
      const status = await agentExecutor.dispatchAndWait(agentId, prompt, {
        workingDir: WORKING_DIR,
        parentTaskId: PARENT_TASK_ID,
        mode: 'worker',
      });

      if (status.status === 'completed') {
        const out = status.result?.output || status.result?.summary || '(无输出)';
        return textResult(`[${agentId}] 任务完成:\n${out}`);
      }

      const err = status.error || status.result?.output || '未知错误';
      return textResult(`[${agentId}] 任务失败 (${status.status}):\n${err}`, true);
    } catch (e) {
      return textResult(`派发失败: ${e.message}`, true);
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
        serverInfo: { name: 'tokenbank-agent-bridge', version: '1.0.0' },
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

// stdio JSON-RPC（每行一条消息）
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
