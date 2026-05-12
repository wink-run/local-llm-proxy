import React, { useState, useEffect, useRef } from 'react';

function fetchModels(source, localCfg) {
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
    const token = localStorage.getItem('token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    return fetch(`${serverUrl}/v1/models`, { headers })
      .then((r) => r.json())
      .then((d) => (d.data || []).map((m) => m.id))
      .catch(() => []);
  }
}

async function streamChat({ source, localCfg, model, systemPrompt, userMessage, stream, onChunk, onDone, onError }) {
  let baseUrl, headers;
  if (source === 'local') {
    baseUrl = localCfg?.llm_base_url || '';
    headers = { 'Content-Type': 'application/json' };
    if (localCfg?.llm_token) headers['Authorization'] = `Bearer ${localCfg.llm_token}`;
  } else {
    baseUrl = localStorage.getItem('serverUrl') || 'http://localhost:8000';
    headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const messages = [];
  if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
  messages.push({ role: 'user', content: userMessage });

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
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [userMessage, setUserMessage] = useState('');
  const [streamMode, setStreamMode] = useState(true);
  const [response, setResponse] = useState('');
  const [sending, setSending] = useState(false);
  const [timing, setTiming] = useState(null);
  const [error, setError] = useState('');
  const responseRef = useRef(null);

  useEffect(() => {
    window.electronAPI?.config.read().then((cfg) => setLocalCfg(cfg));
  }, []);

  useEffect(() => {
    setModels([]);
    setModel('');
    fetchModels(source, localCfg).then((list) => {
      setModels(list);
      if (list.length > 0) setModel(list[0]);
    });
  }, [source, localCfg]);

  useEffect(() => {
    if (responseRef.current) responseRef.current.scrollTop = responseRef.current.scrollHeight;
  }, [response]);

  async function handleSend() {
    if (!userMessage.trim() || !model) return;
    setSending(true);
    setResponse('');
    setTiming(null);
    setError('');

    await streamChat({
      source, localCfg, model,
      systemPrompt, userMessage, stream: streamMode,
      onChunk: (delta) => setResponse((prev) => prev + delta),
      onDone: (t) => { setTiming(t); setSending(false); },
      onError: (msg) => { setError(msg); setSending(false); },
    });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend();
  }

  return (
    <div className="p-8 space-y-5 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">调试</h1>

      {/* Source + Model row */}
      <div className="flex gap-3 items-end">
        <div className="space-y-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">来源</label>
          <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
            {[{ v: 'local', l: '本地 LLM' }, { v: 'network', l: '全球网络' }].map(({ v, l }) => (
              <button key={v} onClick={() => setSource(v)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  source === v
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 space-y-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">模型</label>
          {models.length > 0 ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500">
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <div className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400">
              {source === 'local' && !localCfg?.llm_base_url ? '请先配置本地 LLM 地址' : '加载中…'}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-2 cursor-pointer select-none">
          <input type="checkbox" checked={streamMode} onChange={(e) => setStreamMode(e.target.checked)}
            className="w-4 h-4 accent-blue-600" />
          流式
        </label>
      </div>

      {/* System prompt (collapsible) */}
      <div className="space-y-1">
        <button onClick={() => setShowSystem((v) => !v)}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1">
          {showSystem ? '▼' : '▶'} System Prompt（可选）
        </button>
        {showSystem && (
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3} placeholder="你是一个有帮助的助手…"
            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-none" />
        )}
      </div>

      {/* User message */}
      <div className="space-y-1">
        <label className="text-xs text-gray-500 dark:text-gray-400">消息 (Cmd+Enter 发送)</label>
        <textarea value={userMessage} onChange={(e) => setUserMessage(e.target.value)} onKeyDown={handleKeyDown}
          rows={4} placeholder="输入测试消息…"
          className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-none" />
      </div>

      <button onClick={handleSend} disabled={sending || !userMessage.trim() || !model}
        className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
        {sending ? '发送中…' : '发送'}
      </button>

      {/* Response */}
      {(response || error || sending) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-500 dark:text-gray-400">响应</label>
            {timing && (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {timing.firstTokenMs != null ? `首 token ${timing.firstTokenMs} ms · ` : ''}
                总计 {timing.totalMs} ms
              </span>
            )}
          </div>
          {error ? (
            <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-xl p-4 text-sm text-red-600 dark:text-red-400">{error}</div>
          ) : (
            <div ref={responseRef}
              className="bg-gray-100 dark:bg-gray-900 rounded-xl p-4 text-sm text-gray-900 dark:text-gray-100 font-mono whitespace-pre-wrap min-h-[80px] max-h-96 overflow-y-auto">
              {response}
              {sending && <span className="animate-pulse text-blue-500">▊</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
