import React, { useState, useEffect, useRef } from 'react';

// Fetch the first active API key for the current user via the /user/keys endpoint.
// /user/keys uses the JWT session token; the returned key.key is used for /v1/* calls.
async function resolveApiKey() {
  const serverUrl = localStorage.getItem('serverUrl') || 'http://localhost:8000';
  const jwt = localStorage.getItem('token');
  if (!jwt) return null;
  try {
    const r = await fetch(`${serverUrl}/user/keys`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const active = (data.keys || []).find((k) => k.is_active);
    return active?.key ?? null;
  } catch {
    return null;
  }
}

function fetchModels(source, localCfg, apiKey) {
  if (source === 'local') {
    if (!localCfg?.llm_base_url) return Promise.resolve([]);
    const headers = {};
    if (localCfg.llm_token) headers['Authorization'] = `Bearer ${localCfg.llm_token}`;
    return fetch(`${localCfg.llm_base_url}/v1/models`, { headers })
      .then((r) => r.json())
      .then((d) => (d.data || []).map((m) => m.id))
      .catch(() => []);
  } else {
    const serverUrl = localStorage.getItem('serverUrl') || 'http://localhost:8000';
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    return fetch(`${serverUrl}/v1/models`, { headers })
      .then((r) => r.json())
      .then((d) => (d.data || []).map((m) => m.id))
      .catch(() => []);
  }
}

async function streamChat({ source, localCfg, apiKey, model, messages, stream, onChunk, onDone, onError }) {
  let baseUrl, headers;
  if (source === 'local') {
    baseUrl = localCfg?.llm_base_url || '';
    headers = { 'Content-Type': 'application/json' };
    if (localCfg?.llm_token) headers['Authorization'] = `Bearer ${localCfg.llm_token}`;
  } else {
    baseUrl = localStorage.getItem('serverUrl') || 'http://localhost:8000';
    headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const startTime = Date.now();
  let firstTokenTime = null;

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      onError(`HTTP ${resp.status}: ${errText}`);
      return;
    }

    if (!stream) {
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      onChunk(content);
      onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const d = JSON.parse(trimmed.slice(6));
            const delta = d.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              if (firstTokenTime === null) firstTokenTime = Date.now();
              onChunk(delta);
            }
          } catch {}
        }
      }
    }
    onDone({
      firstTokenMs: firstTokenTime ? firstTokenTime - startTime : null,
      totalMs: Date.now() - startTime,
    });
  } catch (e) {
    onError(e.message);
  }
}

export default function Debug() {
  const [source, setSource] = useState('local');
  const [localCfg, setLocalCfg] = useState(null);
  const [apiKey, setApiKey] = useState(null);      // active API key for network calls
  const [apiKeyErr, setApiKeyErr] = useState(false); // true if no active key found
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [streamMode, setStreamMode] = useState(true);

  // conversation: [{role, content, timing?, error?}]
  const [conversation, setConversation] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    window.electronAPI?.config.read().then((cfg) => setLocalCfg(cfg));
  }, []);

  // Resolve API key when switching to network source
  useEffect(() => {
    if (source !== 'network') return;
    setApiKey(null);
    setApiKeyErr(false);
    resolveApiKey().then((key) => {
      setApiKey(key);
      setApiKeyErr(!key);
    });
  }, [source]);

  useEffect(() => {
    setModels([]);
    setModel('');
    if (source === 'network' && apiKeyErr) return;
    fetchModels(source, localCfg, apiKey).then((list) => {
      setModels(list);
      if (list.length > 0) setModel(list[0]);
    });
  }, [source, localCfg, apiKey, apiKeyErr]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation]);

  async function handleSend() {
    const text = input.trim();
    if (!text || !model || sending) return;

    setInput('');
    setSending(true);

    // Build full message list for the API (system + history + new user msg)
    const apiMessages = [];
    if (systemPrompt.trim()) apiMessages.push({ role: 'system', content: systemPrompt.trim() });
    conversation.forEach((m) => {
      if (m.role === 'user' || m.role === 'assistant') {
        apiMessages.push({ role: m.role, content: m.content });
      }
    });
    apiMessages.push({ role: 'user', content: text });

    // Append user message immediately
    setConversation((prev) => [...prev, { role: 'user', content: text }]);

    // Append empty assistant message to stream into
    const assistantIdx = conversation.length + 1;
    setConversation((prev) => [...prev, { role: 'assistant', content: '', streaming: true }]);

    await streamChat({
      source, localCfg, apiKey, model,
      messages: apiMessages,
      stream: streamMode,
      onChunk: (delta) => {
        setConversation((prev) => {
          const next = [...prev];
          next[assistantIdx] = { ...next[assistantIdx], content: next[assistantIdx].content + delta };
          return next;
        });
      },
      onDone: (timing) => {
        setConversation((prev) => {
          const next = [...prev];
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, timing };
          return next;
        });
        setSending(false);
      },
      onError: (msg) => {
        setConversation((prev) => {
          const next = [...prev];
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, error: msg };
          return next;
        });
        setSending(false);
      },
    });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleClear() {
    setConversation([]);
    setInput('');
  }

  // Auto-resize textarea
  function handleInputChange(e) {
    setInput(e.target.value);
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }
  }

  return (
    <div className="flex flex-col h-screen">

      {/* ── Toolbar ── */}
      <div className="shrink-0 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 space-y-2">
        <div className="flex gap-3 items-center flex-wrap">
          {/* Source toggle */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 shrink-0">
            {[{ v: 'local', l: '本地 LLM' }, { v: 'network', l: '全球网络' }].map(({ v, l }) => (
              <button key={v} onClick={() => setSource(v)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  source === v
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}>
                {l}
              </button>
            ))}
          </div>

          {/* Model selector */}
          {apiKeyErr ? (
            <span className="text-xs text-red-500 dark:text-red-400">
              需要先在「我的账户」中创建 API Key
            </span>
          ) : models.length > 0 ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}
              className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500 max-w-[200px]">
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {source === 'local' && !localCfg?.llm_base_url ? '请先配置本地 LLM 地址' : '加载模型…'}
            </span>
          )}

          {/* Stream toggle */}
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={streamMode} onChange={(e) => setStreamMode(e.target.checked)}
              className="w-3.5 h-3.5 accent-blue-600" />
            流式
          </label>

          {/* System prompt toggle */}
          <button onClick={() => setShowSystem((v) => !v)}
            className={`text-xs px-2 py-1 rounded-md transition-colors ${showSystem ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
            System
          </button>

          {/* Clear */}
          {conversation.length > 0 && (
            <button onClick={handleClear}
              className="ml-auto text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors">
              清空对话
            </button>
          )}
        </div>

        {/* System prompt textarea */}
        {showSystem && (
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
            rows={2} placeholder="System Prompt（可选）"
            className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-none" />
        )}
      </div>

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {conversation.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 dark:text-gray-600 select-none">
            <p className="text-3xl mb-2">🐛</p>
            <p className="text-sm">选择来源和模型，发送消息开始调试</p>
          </div>
        )}

        {conversation.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs shrink-0 mt-0.5 mr-2">
                AI
              </div>
            )}
            <div className={`max-w-[75%] ${msg.role === 'user' ? 'order-1' : ''}`}>
              {msg.error ? (
                <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-2xl px-4 py-2.5 text-sm text-red-600 dark:text-red-400">
                  {msg.error}
                </div>
              ) : (
                <div className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-sm'
                    : 'bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent text-gray-900 dark:text-gray-100 rounded-bl-sm'
                }`}>
                  {msg.content}
                  {msg.streaming && <span className="animate-pulse text-blue-300 dark:text-blue-400 ml-0.5">▊</span>}
                </div>
              )}
              {msg.timing && (
                <p className="text-xs text-gray-400 dark:text-gray-600 mt-1 px-1">
                  {msg.timing.firstTokenMs != null ? `首 token ${msg.timing.firstTokenMs} ms · ` : ''}
                  总计 {msg.timing.totalMs} ms
                </p>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-300 text-xs shrink-0 mt-0.5 ml-2">
                我
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ── */}
      <div className="shrink-0 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="输入消息… (Cmd+Enter 发送)"
            rows={1}
            style={{ resize: 'none' }}
            className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 overflow-hidden"
          />
          <button
            onClick={handleSend}
            disabled={sending || !input.trim() || !model}
            className="shrink-0 w-9 h-9 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-xl flex items-center justify-center transition-colors"
          >
            {sending
              ? <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              : <span className="text-white text-sm">↑</span>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
