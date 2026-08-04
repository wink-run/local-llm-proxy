'use strict';
// Codex Responses⇄Chat：custom/local_shell/namespace/tool_search 与多轮 tool 历史转换
const { test } = require('node:test');
const assert = require('node:assert');
const {
  responsesToChat, chatToResponses, ChatToResponsesStream, collectFreeformToolNames,
  buildCodexToolContext,
  _internal: { responsesToolToChat, freeformInputFromArgs, normalizeFunctionParameters, flattenNamespaceToolName },
} = require('../codex-transform');

test('responsesToolToChat：custom / local_shell 转成 function，不丢工具', () => {
  const custom = responsesToolToChat({
    type: 'custom', name: 'apply_patch', description: 'Apply a patch',
  });
  assert.equal(custom.type, 'function');
  assert.equal(custom.function.name, 'apply_patch');
  assert.equal(custom.function.parameters.required[0], 'input');
  assert.match(custom.function.description, /Original tool definition/);

  const shell = responsesToolToChat({ type: 'local_shell' });
  assert.equal(shell.function.name, 'local_shell');
  assert.ok(shell.function.parameters.properties.command);

  assert.equal(responsesToolToChat({ type: 'web_search' }), null);
});

test('normalizeFunctionParameters：type null / 缺省 → object', () => {
  assert.equal(normalizeFunctionParameters(null).type, 'object');
  assert.equal(normalizeFunctionParameters({ type: null, properties: {} }).type, 'object');
  assert.equal(normalizeFunctionParameters({ type: 'object', properties: { a: {} } }).type, 'object');
});

test('responsesToChat：namespace / tool_search 展平为扁平 function', () => {
  const chat = responsesToChat({
    model: 'k3',
    input: 'check mail',
    tools: [
      { type: 'tool_search' },
      {
        type: 'namespace',
        name: 'mcp__codex_apps__gmail',
        tools: [
          {
            type: 'function',
            name: 'search',
            description: 'Search mail',
            parameters: { type: null, properties: { q: { type: 'string' } } },
          },
        ],
      },
      { type: 'custom', name: 'apply_patch' },
    ],
  });
  const names = chat.tools.map(t => t.function.name).sort();
  assert.deepEqual(names, [
    'apply_patch',
    'mcp__codex_apps__gmail__search',
    'tool_search',
  ]);
  const nsTool = chat.tools.find(t => t.function.name === 'mcp__codex_apps__gmail__search');
  assert.equal(nsTool.function.parameters.type, 'object');
  delete chat._codexToolContext;
});

test('chatToResponses：namespace 工具回写带 namespace 字段', () => {
  const body = {
    model: 'k3',
    tools: [{
      type: 'namespace',
      name: 'mcp__codex_apps__gmail',
      tools: [{
        type: 'function', name: 'search',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      }],
    }],
  };
  const toolContext = buildCodexToolContext(body);
  const flat = flattenNamespaceToolName('mcp__codex_apps__gmail', 'search');
  const resp = chatToResponses({
    id: 'chatcmpl-ns',
    model: 'k3',
    created: 1,
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'call_ns', type: 'function',
          function: { name: flat, arguments: '{"q":"invoice"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }, { toolContext });

  const fc = resp.output.find(i => i.type === 'function_call');
  assert.ok(fc);
  assert.equal(fc.name, 'search');
  assert.equal(fc.namespace, 'mcp__codex_apps__gmail');
  assert.equal(fc.call_id, 'call_ns');
});

test('ChatToResponsesStream：namespace 流式还原', () => {
  const toolContext = buildCodexToolContext({
    tools: [{
      type: 'namespace',
      name: 'mcp__x',
      tools: [{ type: 'function', name: 'list', parameters: { type: 'object', properties: {} } }],
    }],
  });
  const flat = flattenNamespaceToolName('mcp__x', 'list');
  const sm = new ChatToResponsesStream({ toolContext });
  let out = '';
  out += sm.handleChunk({
    id: 'chatcmpl-1', model: 'k3',
    choices: [{
      delta: {
        tool_calls: [{
          index: 0, id: 'call_1',
          function: { name: flat, arguments: '{}' },
        }],
      },
      finish_reason: null,
    }],
  });
  out += sm.handleChunk({
    id: 'chatcmpl-1',
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
  });
  out += sm.finalize();
  assert.match(out, /"namespace":"mcp__x"/);
  assert.match(out, /"name":"list"/);
});

test('responsesToChat：tools 含 custom 时仍带进 Chat 请求', () => {
  const chat = responsesToChat({
    model: 'k3',
    input: 'fix the bug',
    tools: [
      { type: 'custom', name: 'apply_patch', description: 'patch' },
      { type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } },
      { type: 'local_shell' },
    ],
    temperature: 0.7,
    top_p: 0.9,
    n: 2,
    stream: true,
  });
  assert.equal(chat.tools.length, 3);
  assert.deepEqual(chat.tools.map(t => t.function.name).sort(), ['apply_patch', 'local_shell', 'read_file']);
  // Kimi Coding 等不接受采样参数
  assert.equal(chat.temperature, undefined);
  assert.equal(chat.top_p, undefined);
  assert.equal(chat.n, undefined);
  assert.equal(chat.stream, true);
  assert.equal(chat.parallel_tool_calls, false);
  delete chat._codexToolContext;
});

test('responsesToChat：custom_tool_call / output 多轮历史不丢', () => {
  const chat = responsesToChat({
    model: 'k3',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch it' }] },
      {
        type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
      },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
      {
        type: 'local_shell_call', call_id: 'call_2',
        action: { command: ['ls', '-la'], working_directory: '/tmp' },
      },
      { type: 'local_shell_call_output', call_id: 'call_2', output: 'file.txt\n' },
    ],
  });
  const roles = chat.messages.map(m => m.role);
  assert.ok(roles.includes('user'));
  assert.ok(roles.includes('assistant'));
  assert.ok(roles.includes('tool'));
  const asst = chat.messages.find(m => m.role === 'assistant' && m.tool_calls);
  assert.equal(asst.tool_calls[0].function.name, 'apply_patch');
  assert.match(asst.tool_calls[0].function.arguments, /Begin Patch/);
  assert.ok(asst.reasoning_content, 'kimi 要求 tool_calls 带 reasoning_content');
  const toolMsgs = chat.messages.filter(m => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool_call_id, 'call_1');
  assert.equal(toolMsgs[1].tool_call_id, 'call_2');
  delete chat._codexToolContext;
});

test('responsesToChat：带 namespace 的历史 function_call 展平为 chat 名', () => {
  const chat = responsesToChat({
    model: 'k3',
    tools: [{
      type: 'namespace',
      name: 'mcp__ns',
      tools: [{ type: 'function', name: 'get', parameters: { type: 'object', properties: {} } }],
    }],
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      {
        type: 'function_call', call_id: 'c1', name: 'get',
        namespace: 'mcp__ns', arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  });
  const asst = chat.messages.find(m => m.role === 'assistant' && m.tool_calls);
  assert.equal(asst.tool_calls[0].function.name, 'mcp__ns__get');
  delete chat._codexToolContext;
});

test('chatToResponses：freeform 工具回写 custom_tool_call', () => {
  const freeform = collectFreeformToolNames([{ type: 'custom', name: 'apply_patch' }]);
  const resp = chatToResponses({
    id: 'chatcmpl-abc',
    model: 'k3',
    created: 1,
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_x', type: 'function',
          function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }, { freeformToolNames: freeform });

  const ctc = resp.output.find(i => i.type === 'custom_tool_call');
  assert.ok(ctc, '应回写 custom_tool_call');
  assert.equal(ctc.name, 'apply_patch');
  assert.match(ctc.input, /Begin Patch/);
  assert.equal(ctc.call_id, 'call_x');
});

test('ChatToResponsesStream：freeform 工具流式结束产出 custom_tool_call', () => {
  const sm = new ChatToResponsesStream({ freeformToolNames: new Set(['apply_patch']) });
  let out = '';
  out += sm.handleChunk({
    id: 'chatcmpl-1', model: 'k3',
    choices: [{
      delta: {
        tool_calls: [{
          index: 0, id: 'call_1',
          function: { name: 'apply_patch', arguments: '{"input":"hello patch"}' },
        }],
      },
      finish_reason: null,
    }],
  });
  out += sm.handleChunk({
    id: 'chatcmpl-1',
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
  });
  out += sm.finalize();
  assert.match(out, /custom_tool_call/);
  assert.match(out, /hello patch/);
  assert.ok(!/type":"function_call"/.test(out) || out.includes('custom_tool_call'));
});

test('freeformInputFromArgs 解析', () => {
  assert.equal(freeformInputFromArgs('{"input":"abc"}'), 'abc');
  assert.equal(freeformInputFromArgs('plain text'), 'plain text');
});

test('additional_tools 中的 exec 提升进 Chat tools（否则无工具日志）', () => {
  const chat = responsesToChat({
    model: 'k3',
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }],
    input: [
      { type: 'message', role: 'user', content: 'fetch it' },
      {
        type: 'additional_tools',
        tools: [{ type: 'custom', name: 'exec', description: 'Execute code' }],
      },
    ],
  });
  const names = chat.tools.map(t => t.function.name).sort();
  assert.deepEqual(names, ['exec', 'read_file']);
  assert.match(chat.tools.find(t => t.function.name === 'exec').function.description, /Original tool definition/);
  delete chat._codexToolContext;
});

test('已知 freeform 名 exec 无上下文也回写 custom_tool_call', () => {
  const resp = chatToResponses({
    id: 'chatcmpl-exec',
    model: 'k3',
    created: 1,
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'call_e', type: 'function',
          function: { name: 'exec', arguments: '{"input":"await tools.exec_command({cmd:\\"ls\\"})"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }, {});
  const ctc = resp.output.find(i => i.type === 'custom_tool_call');
  assert.ok(ctc);
  assert.equal(ctc.name, 'exec');
});
