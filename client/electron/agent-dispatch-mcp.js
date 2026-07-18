#!/usr/bin/env node
// Token Bank Agent 派发 MCP（stdio）
// 供主 Agent（Claude Code）调用，向已纳管的其他 Agent 派发子任务
'use strict';

const readline = require('readline');
const { summarizeAgentStdout } = require('./agent-output-parser');
const dispatchClient = require('./agent-dispatch-client');

const PARENT_TASK_ID = process.env.TB_PARENT_TASK_ID || '';
const PARENT_SESSION_KEY = process.env.TB_PARENT_SESSION_KEY || '';
const PARENT_SESSION_INSTANCE = process.env.TB_PARENT_SESSION_INSTANCE || '';
const WORKING_DIR = process.env.TB_WORKING_DIR || process.cwd();

const TOOLS = [
  {
    name: 'tb_list_agents',
    description: '列出 Token Bank 已纳管、可派发的目标：专业智能体（assistant:*）与通用 CLI Agent。派发前必先调用，优先选专业智能体。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_dispatch_agent',
    description: '向指定 Agent/专业智能体派发子任务并等待完成。优先派发给匹配的专业智能体（assistant:*）；无匹配时再派发通用 CLI（codex/claude-code）。禁止自己在终端运行 CLI。',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: '目标 ID：优先 assistant:<resourceId>；兜底可用 codex、claude-code',
        },
        prompt: {
          type: 'string',
          description: '交给该 Agent 的具体任务描述',
        },
      },
      required: ['agent_id', 'prompt'],
    },
  },
  {
    name: 'tb_get_prompt',
    description: '按名称或 #id 取回 Token Bank 已纳管的提示词正文（可带参数，模板里的 $ARGUMENTS 会被填充）。用于快速引用提示词模板，无需自己拼写全文。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '提示词名称，或 #<id>' },
        args: { type: 'string', description: '可选参数，填充模板里的 $ARGUMENTS' },
      },
      required: ['name'],
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
    const agents = await dispatchClient.listAgents();
    // 专业智能体优先展示，便于编排层匹配后派发
    const sorted = [...agents].sort((a, b) => {
      const wa = a.type === 'assistant' ? 0 : 1;
      const wb = b.type === 'assistant' ? 0 : 1;
      return wa - wb || String(a.name || '').localeCompare(String(b.name || ''));
    });
    const lines = sorted.map((a) => {
      const kind = a.type === 'assistant' ? '专业智能体' : 'CLI';
      const caps = (a.capabilities || []).join(', ');
      const desc = a.description ? ` — ${String(a.description).slice(0, 160)}` : '';
      const ver = a.version ? ` (v${a.version})` : '';
      return `- ${a.id}: ${a.name}${ver} [${kind}]${caps ? ` (${caps})` : ''}${desc}`;
    });
    const hint = '提示：有匹配的专业智能体时优先 tb_dispatch_agent 派发；无匹配再自行执行或派发 CLI。';
    return textResult(lines.length ? `${hint}\n${lines.join('\n')}` : '（无可用 Agent）');
  }

  if (name === 'tb_dispatch_agent') {
    const agentId = String(args.agent_id || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!agentId || !prompt) {
      return textResult('缺少 agent_id 或 prompt', true);
    }

    try {
      const status = await dispatchClient.dispatchAndWait(agentId, prompt, {
        workingDir: WORKING_DIR,
        parentTaskId: PARENT_TASK_ID,
        parentSessionKey: PARENT_SESSION_KEY || undefined,
        parentSessionInstanceId: PARENT_SESSION_INSTANCE || undefined,
        mode: 'worker',
      });

      const canonicalId = status.agent_id || agentId;
      const parseAs = canonicalId === 'codex' ? 'codex' : 'claude-code';
      if (status.status === 'completed') {
        const raw = status.result?.output || status.result?.summary || '';
        const out = status.result?.summary
          || summarizeAgentStdout(raw, parseAs)
          || '(无输出)';
        return textResult(`[${canonicalId}] 任务完成:\n${out}`);
      }

      const err = status.error || status.result?.output || '未知错误';
      return textResult(`[${canonicalId}] 任务失败 (${status.status}):\n${err}`, true);
    } catch (e) {
      return textResult(`派发失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_get_prompt') {
    const ref = String(args.name || args.ref || '').trim();
    const argStr = String(args.args || args.arguments || '').trim();
    if (!ref) return textResult('缺少 name', true);
    const clientId = process.env.TB_CLIENT_ID || process.env.TB_MAIN_AGENT_ID || '';
    const r = await dispatchClient.resolvePrompt(ref, argStr, clientId);
    if (!r || !r.found) {
      return textResult(`未找到提示词: ${ref}(仅投射给当前 Agent 的提示词可用)`, true);
    }
    return textResult(r.text);
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

// stdio JSON-RPC（每行一条消息）——仅作为独立进程运行时启动，便于单测 require
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
