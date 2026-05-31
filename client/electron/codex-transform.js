// client/electron/codex-transform.js
// OpenAI Responses API ↔ Chat Completions API 双向转换。
//
// 用途：Codex 客户端走 Responses 协议（/v1/responses），而很多第三方模型只暴露
// Chat Completions（/v1/chat/completions）。本模块把 Responses 请求转成 Chat 请求转发上游，
// 再把上游 Chat 响应（流式 SSE 或非流式 JSON）转回 Responses 格式回给 Codex。
//
// 移植自 cc-switch 的 transform_codex_chat.rs + streaming_codex_chat.rs + codex_chat_common.rs，
// 保留 reasoning（思考）、tool calls（工具调用）、缓存 token 等高级语义。纯函数/纯状态机，便于单测。
'use strict';

// ── canonical JSON：对象 key 递归排序后序列化（与 cc-switch 的 canonicalize 行为一致）──
// 工具调用参数在流式分片拼接后可能是 `{ "b":2, "a":1 }`，需归一成稳定的 `{"a":1,"b":2}`，
// 否则 Codex 端按字符串比对历史会错乱。
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

// 把工具参数（可能是字符串化 JSON，也可能是对象）归一为字符串。无法解析时原样返回。
function canonicalizeArgs(args) {
  if (args == null) return '';
  if (typeof args === 'string') {
    const s = args.trim();
    if (!s) return '';
    try { return JSON.stringify(canonicalize(JSON.parse(s))); }
    catch { return args; } // 流式未拼完整时保持原样
  }
  try { return JSON.stringify(canonicalize(args)); } catch { return String(args); }
}

// ── <think> 块解析（codex_chat_common.rs 的 split_leading_think_block）──
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

// 返回 [reasoning, answer]，若开头不是 <think> 返回 null。
function splitLeadingThinkBlock(text) {
  const trimmed = text.replace(/^\s+/, '');
  const wsLen = text.length - trimmed.length;
  if (!trimmed.startsWith(THINK_OPEN)) return null;
  const bodyStart = wsLen + THINK_OPEN.length;
  const closeRel = text.indexOf(THINK_CLOSE, bodyStart);
  if (closeRel < 0) return null;
  const answerStart = closeRel + THINK_CLOSE.length;
  return [
    text.slice(bodyStart, closeRel).trim(),
    text.slice(answerStart).replace(/^[\r\n\t ]+/, ''),
  ];
}

function stripLeadingThinkOpenTag(text) {
  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed.startsWith(THINK_OPEN)) return null;
  return trimmed.slice(THINK_OPEN.length).trim();
}

// 从一个对象里抽 reasoning 文本：reasoning_content > reasoning(字符串/对象) > reasoning_details。
function extractReasoningFieldText(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['reasoning_content', 'reasoning']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  const r = value.reasoning;
  if (r && typeof r === 'object') {
    for (const key of ['content', 'text', 'summary']) {
      if (typeof r[key] === 'string' && r[key]) return r[key];
    }
  }
  const details = value.reasoning_details;
  if (details != null) {
    const t = extractReasoningDetailsText(details);
    if (t) return t;
  }
  return null;
}

function extractReasoningDetailsText(value) {
  if (typeof value === 'string') return value || null;
  if (Array.isArray(value)) {
    const t = value.map(extractReasoningDetailPartText).filter(Boolean).join('\n\n');
    return t || null;
  }
  if (value && typeof value === 'object') return extractReasoningDetailPartText(value);
  return null;
}

function extractReasoningDetailPartText(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['text', 'content', 'summary']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  if (Array.isArray(value.parts)) {
    const t = value.parts.map(extractReasoningDetailPartText).filter(Boolean).join('\n\n');
    return t || null;
  }
  return null;
}

// 从 Responses 的 reasoning item 抽文本（summary 数组/字符串）。
function extractReasoningSummaryText(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['reasoning_content', 'content', 'text']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  const summary = value.summary;
  if (summary == null) return null;
  if (typeof summary === 'string') return summary || null;
  if (Array.isArray(summary)) {
    const t = summary
      .map(p => (typeof p === 'string' ? p : (p && (p.text || p.content)) || ''))
      .filter(Boolean)
      .join('\n\n');
    return t || null;
  }
  return null;
}

function responseIdFromChatId(id) {
  const base = id || 'llmproxy';
  return base.startsWith('resp_') ? base : `resp_${base}`;
}

function responseStatusFromFinish(finishReason) {
  return finishReason === 'length' ? 'incomplete' : 'completed';
}

// 构造 Responses function_call output item（codex_chat_common.rs 的 response_function_call_item）。
function responseFunctionCallItem(itemId, status, callId, name, args, reasoning) {
  const item = { id: itemId, type: 'function_call', status, call_id: callId, name, arguments: args };
  const r = reasoning && reasoning.trim();
  if (r) item.reasoning_content = r;
  return item;
}

// ════════════════════════════════════════════════════════════════════════════
// 1) 请求转换：Responses → Chat Completions
// ════════════════════════════════════════════════════════════════════════════

const EXTRA_PASSTHROUGH = [
  'frequency_penalty', 'logit_bias', 'logprobs', 'metadata', 'n',
  'parallel_tool_calls', 'presence_penalty', 'response_format', 'seed',
  'service_tier', 'stop', 'stream_options', 'top_logprobs', 'user',
];

function instructionText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(p => (typeof p === 'string' ? p : (p && p.text) || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return value == null ? '' : String(value);
}

function responsesRoleToChat(role) {
  switch (role) {
    case 'system': case 'developer': return 'system';
    case 'assistant': return 'assistant';
    case 'tool': return 'tool';
    default: return 'user'; // user / latest_reminder / 未知 → user
  }
}

// Responses content 数组 → Chat content（纯文本时折叠成字符串，含图片时保留数组）。
function responsesContentToChat(content) {
  if (content == null || typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  const parts = [];
  let hasNonText = false;
  for (const part of content) {
    const t = (part && part.type) || '';
    if (t === 'input_text' || t === 'output_text' || t === 'text') {
      if (part.text) parts.push({ type: 'text', text: part.text });
    } else if (t === 'refusal') {
      if (part.refusal) parts.push({ type: 'text', text: part.refusal });
    } else if (t === 'input_image') {
      if (part.image_url != null) {
        const imageUrl = (part.image_url && typeof part.image_url === 'object')
          ? part.image_url : { url: String(part.image_url) };
        parts.push({ type: 'image_url', image_url: imageUrl });
        hasNonText = true;
      }
    }
  }
  if (!hasNonText) {
    return parts.map(p => p.text).filter(Boolean).join('\n');
  }
  return parts;
}

function responsesToolToChat(tool) {
  if (!tool || tool.type !== 'function') return null;
  if (tool.function) {
    const out = { ...tool };
    if (tool.strict !== undefined && out.function && typeof out.function === 'object') {
      if (out.function.strict === undefined) out.function = { ...out.function, strict: tool.strict };
      delete out.strict;
    }
    return out;
  }
  const fn = { name: tool.name || '', description: tool.description ?? null, parameters: tool.parameters ?? {} };
  if (tool.strict !== undefined) fn.strict = tool.strict;
  return { type: 'function', function: fn };
}

function responsesToolChoiceToChat(tc) {
  if (tc && typeof tc === 'object' && tc.type === 'function') {
    return { type: 'function', function: { name: tc.name || '' } };
  }
  return tc;
}

// 把 reasoning 文本追加到一条 assistant chat 消息的 reasoning_content 字段。
function appendReasoningContent(message, reasoning) {
  const r = (reasoning || '').trim();
  if (!r) return;
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    message.reasoning_content += '\n\n' + r;
  } else {
    message.reasoning_content = r;
  }
}

// 把所有 system 消息合并到队首（MiniMax 等要求 system 只能首条）。
function collapseSystemToHead(messages) {
  const sys = [];
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string') {
      if (m.content.trim()) sys.push(m.content);
      continue;
    }
    rest.push(m);
  }
  const out = [];
  if (sys.length) out.push({ role: 'system', content: sys.join('\n\n') });
  return out.concat(rest);
}

// 把 Responses input（字符串/单 item/数组）展开为 Chat messages。
function appendInputAsChatMessages(input, messages) {
  const pendingToolCalls = [];
  let pendingReasoning = null;       // 暂存、待挂到下一条 assistant
  let lastAssistantIndex = null;

  const flushTools = () => {
    if (!pendingToolCalls.length) return;
    const msg = { role: 'assistant', content: null, tool_calls: pendingToolCalls.splice(0) };
    if (pendingReasoning) { appendReasoningContent(msg, pendingReasoning); pendingReasoning = null; }
    lastAssistantIndex = messages.length;
    messages.push(msg);
  };

  const handleItem = (item) => {
    if (item == null || typeof item !== 'object') {
      if (typeof item === 'string') messages.push({ role: 'user', content: item });
      return;
    }
    const type = item.type;
    if (type === 'function_call') {
      const r = extractReasoningFieldText(item);
      if (r && (!pendingReasoning || !pendingReasoning.includes(r.trim()))) {
        pendingReasoning = pendingReasoning ? pendingReasoning + '\n\n' + r.trim() : r.trim();
      }
      const callId = (item.call_id || item.id || '');
      pendingToolCalls.push({
        id: callId, type: 'function',
        function: { name: item.name || '', arguments: canonicalizeArgs(item.arguments) },
      });
    } else if (type === 'function_call_output') {
      flushTools();
      const callId = item.call_id || '';
      let output = '';
      if (typeof item.output === 'string') {
        try { output = JSON.stringify(canonicalize(JSON.parse(item.output))); } catch { output = item.output; }
      } else if (item.output != null) {
        output = JSON.stringify(canonicalize(item.output));
      }
      messages.push({ role: 'tool', tool_call_id: callId, content: output });
    } else if (type === 'reasoning') {
      const reasoning = extractReasoningSummaryText(item);
      const r = reasoning && reasoning.trim();
      if (r) {
        // 优先回挂到上一条 assistant（无 pending tool call 时）
        if (!pendingToolCalls.length && lastAssistantIndex != null
            && messages[lastAssistantIndex] && messages[lastAssistantIndex].role === 'assistant') {
          appendReasoningContent(messages[lastAssistantIndex], r);
        } else {
          pendingReasoning = pendingReasoning ? pendingReasoning + '\n\n' + r : r;
        }
      }
    } else { // 'message' 或无 type
      flushTools();
      if (item.role !== undefined || item.content !== undefined) {
        const chatRole = responsesRoleToChat(item.role || 'user');
        const content = item.content !== undefined ? responsesContentToChat(item.content) : null;
        const msg = { role: chatRole, content };
        if (chatRole === 'assistant') {
          const embedded = extractReasoningFieldText(item);
          if (embedded) pendingReasoning = pendingReasoning ? pendingReasoning + '\n\n' + embedded.trim() : embedded.trim();
          if (pendingReasoning) { appendReasoningContent(msg, pendingReasoning); pendingReasoning = null; }
          lastAssistantIndex = messages.length;
        } else {
          pendingReasoning = null;
          lastAssistantIndex = (chatRole === 'tool') ? lastAssistantIndex : null;
        }
        messages.push(msg);
      }
    }
  };

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) handleItem(item);
  } else if (input && typeof input === 'object') {
    handleItem(input);
  }
  flushTools();

  // 末端兜底：带 tool_calls 的 assistant 必须有非空 reasoning_content（kimi/DeepSeek 要求）
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (!(typeof m.reasoning_content === 'string' && m.reasoning_content.trim())) {
        m.reasoning_content = 'tool call';
      }
    }
  }
}

// reasoning.effort 透传（简化版：直接映射顶层 reasoning_effort，未带 provider 能力声明）。
function applyReasoningOptions(result, body) {
  const effort = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning.effort : undefined;
  if (typeof effort === 'string') {
    const low = effort.trim().toLowerCase();
    if (!['none', 'off', 'disabled'].includes(low)) result.reasoning_effort = effort;
  }
}

/**
 * Responses 请求 → Chat Completions 请求。
 * @param {object} body Responses 格式请求体
 * @returns {object} Chat Completions 请求体
 */
function responsesToChat(body) {
  const result = {};
  if (body.model !== undefined) result.model = body.model;

  const messages = [];
  if (body.instructions !== undefined) {
    const it = instructionText(body.instructions);
    if (it) messages.push({ role: 'system', content: it });
  }
  if (body.input !== undefined) appendInputAsChatMessages(body.input, messages);
  result.messages = collapseSystemToHead(messages);

  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) result.max_completion_tokens = body.max_completion_tokens;

  for (const k of ['temperature', 'top_p', 'stream']) {
    if (body[k] !== undefined) result[k] = body[k];
  }

  applyReasoningOptions(result, body);

  if (Array.isArray(body.tools)) {
    const tools = body.tools.map(responsesToolToChat).filter(Boolean);
    if (tools.length) result.tools = tools;
  }
  if (body.tool_choice !== undefined) result.tool_choice = responsesToolChoiceToChat(body.tool_choice);

  for (const k of EXTRA_PASSTHROUGH) {
    if (body[k] !== undefined) result[k] = body[k];
  }

  // 流式必须显式 include_usage，否则第三方上游不在 SSE 末尾返回 usage（token 全漏记）。
  if (result.stream === true) {
    if (result.stream_options && typeof result.stream_options === 'object') {
      result.stream_options = { ...result.stream_options, include_usage: true };
    } else {
      result.stream_options = { include_usage: true };
    }
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// 2) 非流式响应转换：Chat Completions → Responses
// ════════════════════════════════════════════════════════════════════════════

function chatReasoningText(message) {
  const r = extractReasoningFieldText(message);
  if (r) return r;
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    if (split && split[0]) return split[0];
  }
  return null;
}

function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? (inTok + outTok);
  const out = { input_tokens: inTok, output_tokens: outTok, total_tokens: total };
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
  if (cached != null) out.input_tokens_details = { cached_tokens: cached };
  if (usage.completion_tokens_details !== undefined) out.output_tokens_details = usage.completion_tokens_details;
  if (usage.cache_read_input_tokens !== undefined) out.cache_read_input_tokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) out.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  return out;
}

function chatMessageToResponseItem(message, responseId) {
  const content = [];
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    const text = split ? split[1] : message.content;
    if (text) content.push({ type: 'output_text', text, annotations: [] });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const t = (part && part.type) || '';
      if (t === 'text' || t === 'output_text') {
        if (part.text) content.push({ type: 'output_text', text: part.text, annotations: [] });
      } else if (t === 'refusal') {
        if (part.refusal) content.push({ type: 'refusal', refusal: part.refusal });
      }
    }
  }
  if (typeof message.refusal === 'string' && message.refusal) {
    content.push({ type: 'refusal', refusal: message.refusal });
  }
  if (!content.length) return null;
  return { id: `${responseId}_msg`, type: 'message', status: 'completed', role: 'assistant', content };
}

function chatToolCallsToResponseItems(message, reasoning) {
  const out = [];
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tc, index) => {
      const callId = (tc.id && tc.id) || `call_${index}`;
      const fn = tc.function || {};
      out.push(responseFunctionCallItem(
        `fc_${callId}`, 'completed', callId, fn.name || '', canonicalizeArgs(fn.arguments), reasoning));
    });
  } else if (message.function_call) {
    const fc = message.function_call;
    const callId = (fc.id && fc.id) || 'call_0';
    out.push(responseFunctionCallItem(
      `fc_${callId}`, 'completed', callId, fc.name || '', canonicalizeArgs(fc.arguments), reasoning));
  }
  return out;
}

/**
 * 非流式 Chat Completions 响应 → Responses 响应。
 * @param {object} body Chat Completions 响应体
 * @returns {object} Responses 响应体
 */
function chatToResponses(body) {
  const choices = body.choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new Error('No choices in chat response');
  }
  const choice = choices[0];
  const message = choice.message;
  if (!message) throw new Error('No message in chat choice');

  const responseId = responseIdFromChatId(body.id);
  const model = body.model || '';
  const createdAt = body.created || 0;
  const finishReason = choice.finish_reason;

  const reasoning = chatReasoningText(message);
  const output = [];
  if (reasoning) {
    output.push({ id: `rs_${responseId}`, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] });
  }
  const msgItem = chatMessageToResponseItem(message, responseId);
  if (msgItem) output.push(msgItem);
  output.push(...chatToolCallsToResponseItems(message, reasoning));

  const response = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: responseStatusFromFinish(finishReason),
    model,
    output,
    usage: chatUsageToResponsesUsage(body.usage),
  };
  if (finishReason === 'length') response.incomplete_details = { reason: 'max_output_tokens' };
  return response;
}

// 把 Chat 上游错误体规整成 Responses 风格错误对象。
function chatErrorToResponseError(body) {
  if (body == null) {
    return { error: { message: 'Upstream returned an empty error response', type: 'upstream_error', code: null, param: null } };
  }
  if (typeof body === 'string') {
    return { error: { message: body, type: 'upstream_error', code: null, param: null } };
  }
  const source = (body && body.error) || body;
  const message = source.message || source.detail || source.status_msg
    || source.base_resp?.status_msg || (typeof source === 'string' ? source : null)
    || (() => { try { return JSON.stringify(source); } catch { return 'Upstream error'; } })();
  return {
    error: {
      message,
      type: source.type || 'upstream_error',
      code: source.code ?? source.base_resp?.status_code ?? null,
      param: source.param ?? null,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 3) 流式状态机：Chat Completions SSE chunk → Responses SSE 事件
// ════════════════════════════════════════════════════════════════════════════

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// inline <think> 检测三态
const THINK_DETECTING = 0, THINK_REASONING = 1, THINK_TEXT = 2;

// 决定缓冲区开头是否 <think>：'more'（需更多）| 'reasoning' | 'text'
function leadingThinkDecision(buffer) {
  const trimmed = buffer.replace(/^\s+/, '');
  if (!trimmed) return 'more';
  if (trimmed.startsWith(THINK_OPEN)) return 'reasoning';
  if (THINK_OPEN.startsWith(trimmed)) return 'more'; // 是 <think> 的前缀
  return 'text';
}

/**
 * Chat→Responses 流式状态机。逐个喂入 Chat SSE 解析出的 chunk 对象，吐出 Responses SSE 字符串。
 * 用法：
 *   const sm = new ChatToResponsesStream();
 *   out += sm.handleChunk(chatChunkObj);   // 每个 data: {...}
 *   out += sm.finalize();                  // 收到 [DONE] 或流结束
 *   // 出错：out += sm.failedEvent(msg, type)
 */
class ChatToResponsesStream {
  constructor() {
    this.responseStarted = false;
    this.completed = false;
    this.responseId = 'resp_llmproxy';
    this.model = '';
    this.createdAt = 0;
    this.nextIndex = 0;
    this.text = { outputIndex: null, itemId: '', text: '', added: false, done: false };
    this.reasoning = { outputIndex: null, itemId: '', text: '', added: false, done: false };
    this.inlineThink = { mode: THINK_DETECTING, buffer: '' };
    this.tools = new Map(); // chatIndex -> {outputIndex,itemId,callId,name,arguments,reasoningContent,added,done}
    this.outputItems = []; // [outputIndex, item]
    this.latestUsage = null;
    this.finishReason = null;
  }

  _nextIndex() { return this.nextIndex++; }

  _baseResponse(status, output) {
    return {
      id: this.responseId, object: 'response', created_at: this.createdAt,
      status, model: this.model, output,
      usage: this.latestUsage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
  }

  _ensureStarted() {
    if (this.responseStarted) return '';
    this.responseStarted = true;
    return sseEvent('response.created', { type: 'response.created', response: this._baseResponse('in_progress', []) })
         + sseEvent('response.in_progress', { type: 'response.in_progress', response: this._baseResponse('in_progress', []) });
  }

  handleChunk(chunk) {
    let out = '';
    if (typeof chunk.id === 'string') this.responseId = responseIdFromChatId(chunk.id);
    if (typeof chunk.model === 'string' && chunk.model) this.model = chunk.model;
    if (typeof chunk.created === 'number') this.createdAt = chunk.created;

    out += this._ensureStarted();

    if (chunk.usage != null) this.latestUsage = chatUsageToResponsesUsage(chunk.usage);

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return out;

    const delta = choice.delta;
    if (delta) {
      const reasoning = extractReasoningFieldText(delta);
      if (reasoning) out += this._pushReasoningDelta(reasoning);

      if (typeof delta.content === 'string' && delta.content) {
        out += this._pushContentDelta(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        out += this._flushInlineThinkAtBoundary();
        const reasoningForTool = this._currentReasoningText();
        out += this._finalizeReasoning();
        for (const tc of delta.tool_calls) out += this._pushToolCallDelta(tc, reasoningForTool);
      }
    }
    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;
    return out;
  }

  _pushContentDelta(delta) {
    const it = this.inlineThink;
    if (it.mode === THINK_TEXT) {
      return this._finalizeReasoning() + this._pushTextDelta(delta);
    }
    if (it.mode === THINK_DETECTING) {
      it.buffer += delta;
      const decision = leadingThinkDecision(it.buffer);
      if (decision === 'more') return '';
      if (decision === 'reasoning') { it.mode = THINK_REASONING; return this._drainInlineThink(); }
      // text
      it.mode = THINK_TEXT;
      const text = it.buffer; it.buffer = '';
      return this._finalizeReasoning() + this._pushTextDelta(text);
    }
    // THINK_REASONING
    it.buffer += delta;
    return this._drainInlineThink();
  }

  _drainInlineThink() {
    const split = splitLeadingThinkBlock(this.inlineThink.buffer);
    if (!split) return '';
    this.inlineThink.mode = THINK_TEXT;
    this.inlineThink.buffer = '';
    let out = '';
    if (split[0]) { out += this._pushReasoningDelta(split[0]); out += this._finalizeReasoning(); }
    if (split[1]) out += this._pushTextDelta(split[1]);
    return out;
  }

  _flushInlineThinkAtBoundary() {
    const it = this.inlineThink;
    if (it.mode === THINK_TEXT) return '';
    if (it.mode === THINK_DETECTING) {
      it.mode = THINK_TEXT;
      const text = it.buffer; it.buffer = '';
      if (!text) return '';
      return this._finalizeReasoning() + this._pushTextDelta(text);
    }
    // THINK_REASONING
    const buffered = it.buffer; it.buffer = ''; it.mode = THINK_TEXT;
    const split = splitLeadingThinkBlock(buffered);
    if (split) {
      let out = '';
      if (split[0]) { out += this._pushReasoningDelta(split[0]); out += this._finalizeReasoning(); }
      if (split[1]) out += this._pushTextDelta(split[1]);
      return out;
    }
    const reasoning = stripLeadingThinkOpenTag(buffered) ?? buffered;
    if (!reasoning) return '';
    return this._pushReasoningDelta(reasoning) + this._finalizeReasoning();
  }

  _pushReasoningDelta(delta) {
    let out = '';
    if (!this.reasoning.added) {
      const oi = this._nextIndex();
      const itemId = `rs_${this.responseId}`;
      this.reasoning.outputIndex = oi;
      this.reasoning.itemId = itemId;
      this.reasoning.added = true;
      out += sseEvent('response.output_item.added', {
        type: 'response.output_item.added', output_index: oi,
        item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] },
      });
      out += sseEvent('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added', item_id: itemId, output_index: oi,
        summary_index: 0, part: { type: 'summary_text', text: '' },
      });
    }
    this.reasoning.text += delta;
    out += sseEvent('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta', item_id: this.reasoning.itemId,
      output_index: this.reasoning.outputIndex ?? 0, summary_index: 0, delta,
    });
    return out;
  }

  _pushTextDelta(delta) {
    let out = '';
    if (!this.text.added) {
      const oi = this._nextIndex();
      const itemId = `${this.responseId}_msg`;
      this.text.outputIndex = oi;
      this.text.itemId = itemId;
      this.text.added = true;
      out += sseEvent('response.output_item.added', {
        type: 'response.output_item.added', output_index: oi,
        item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      out += sseEvent('response.content_part.added', {
        type: 'response.content_part.added', item_id: itemId, output_index: oi,
        content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    this.text.text += delta;
    out += sseEvent('response.output_text.delta', {
      type: 'response.output_text.delta', item_id: this.text.itemId,
      output_index: this.text.outputIndex ?? 0, content_index: 0, delta,
    });
    return out;
  }

  _currentReasoningText() {
    const t = this.reasoning.text.trim();
    return t || null;
  }

  _pushToolCallDelta(toolCall, reasoning) {
    const chatIndex = (typeof toolCall.index === 'number') ? toolCall.index : 0;
    const idDelta = (toolCall.id && typeof toolCall.id === 'string') ? toolCall.id : null;
    const fn = toolCall.function || {};
    const nameDelta = (typeof fn.name === 'string') ? fn.name : null;
    const argsDelta = (typeof fn.arguments === 'string') ? fn.arguments : '';

    let state = this.tools.get(chatIndex);
    if (!state) {
      state = { outputIndex: null, itemId: '', callId: '', name: '', arguments: '', reasoningContent: '', added: false, done: false };
      this.tools.set(chatIndex, state);
    }
    if (idDelta) state.callId = idDelta;
    if (nameDelta) state.name = nameDelta;
    if (argsDelta) state.arguments += argsDelta;
    if (!state.reasoningContent && reasoning && reasoning.trim()) state.reasoningContent = reasoning.trim();

    let out = '';
    if (!state.added && (state.callId || state.name)) {
      const assigned = this._nextIndex();
      state.added = true;
      if (!state.callId) state.callId = `call_${chatIndex}`;
      if (!state.name) state.name = 'unknown_tool';
      state.outputIndex = assigned;
      state.itemId = `fc_${state.callId}`;
      const item = responseFunctionCallItem(state.itemId, 'in_progress', state.callId, state.name, '', state.reasoningContent || null);
      out += sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: assigned, item });
      if (state.arguments) {
        out += sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', item_id: state.itemId,
          output_index: assigned, delta: state.arguments,
        });
      }
    } else if (state.added && argsDelta) {
      out += sseEvent('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta', item_id: state.itemId,
        output_index: state.outputIndex ?? 0, delta: argsDelta,
      });
    }
    return out;
  }

  _finalizeReasoning() {
    if (!this.reasoning.added || this.reasoning.done) return '';
    const oi = this.reasoning.outputIndex ?? 0;
    const text = this.reasoning.text;
    const item = { id: this.reasoning.itemId, type: 'reasoning', summary: [{ type: 'summary_text', text }] };
    this.outputItems.push([oi, item]);
    this.reasoning.done = true;
    return sseEvent('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done', item_id: this.reasoning.itemId,
        output_index: oi, summary_index: 0, text,
      })
      + sseEvent('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done', item_id: this.reasoning.itemId,
        output_index: oi, summary_index: 0, part: { type: 'summary_text', text },
      })
      + sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
  }

  _finalizeText() {
    if (!this.text.added || this.text.done) return '';
    const oi = this.text.outputIndex ?? 0;
    const item = {
      id: this.text.itemId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: this.text.text, annotations: [] }],
    };
    this.outputItems.push([oi, item]);
    this.text.done = true;
    return sseEvent('response.output_text.done', {
        type: 'response.output_text.done', item_id: this.text.itemId,
        output_index: oi, content_index: 0, text: this.text.text,
      })
      + sseEvent('response.content_part.done', {
        type: 'response.content_part.done', item_id: this.text.itemId, output_index: oi,
        content_index: 0, part: { type: 'output_text', text: this.text.text, annotations: [] },
      })
      + sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
  }

  _finalizeTools() {
    let out = '';
    for (const [, state] of this.tools) {
      if (state.done) continue;
      if (!state.added) {
        const assigned = this._nextIndex();
        state.added = true;
        if (!state.callId) state.callId = `call_${assigned}`;
        if (!state.name) state.name = 'unknown_tool';
        state.outputIndex = assigned;
        state.itemId = `fc_${state.callId}`;
        const item = responseFunctionCallItem(state.itemId, 'in_progress', state.callId, state.name, '', state.reasoningContent || null);
        out += sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: assigned, item });
      }
      const oi = state.outputIndex ?? 0;
      const args = canonicalizeArgs(state.arguments);
      const item = responseFunctionCallItem(state.itemId, 'completed', state.callId, state.name, args, state.reasoningContent || null);
      state.done = true;
      this.outputItems.push([oi, item]);
      out += sseEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done', item_id: state.itemId, output_index: oi, arguments: args,
      });
      out += sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
    }
    return out;
  }

  _completedOutputItems() {
    return this.outputItems.slice().sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  }

  finalize() {
    if (this.completed) return '';
    let out = this._ensureStarted();
    out += this._flushInlineThinkAtBoundary();
    out += this._finalizeReasoning();
    out += this._finalizeText();
    out += this._finalizeTools();
    const status = responseStatusFromFinish(this.finishReason);
    const response = this._baseResponse(status, this._completedOutputItems());
    if (status === 'incomplete') response.incomplete_details = { reason: 'max_output_tokens' };
    out += sseEvent('response.completed', { type: 'response.completed', response });
    this.completed = true;
    return out;
  }

  failedEvent(message, errorType) {
    this.completed = true;
    const error = { message };
    if (errorType) error.type = errorType;
    const response = this._baseResponse('failed', this._completedOutputItems());
    response.error = error;
    return sseEvent('response.failed', { type: 'response.failed', response });
  }

  // 给记账用：取已累计的 usage（Responses 形态，含 input/output/cached）。
  getUsage() { return this.latestUsage; }
  getResponseId() { return this.responseId; }
}

module.exports = {
  responsesToChat,
  chatToResponses,
  chatErrorToResponseError,
  ChatToResponsesStream,
  // 导出内部 helper 供单测
  _internal: {
    canonicalizeArgs, splitLeadingThinkBlock, extractReasoningFieldText,
    extractReasoningSummaryText, chatUsageToResponsesUsage, responseIdFromChatId,
    leadingThinkDecision,
  },
};
