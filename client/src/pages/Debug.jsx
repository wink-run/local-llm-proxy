import React, { useState, useEffect, useRef } from 'react';
import { getServerUrl } from '../config';

async function fetchApiKeys() {
  const serverUrl = getServerUrl();
  const jwt = localStorage.getItem('token');
  if (!jwt) return [];
  try {
    const r = await fetch(`${serverUrl}/user/keys`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.keys || []).filter((k) => k.is_active);
  } catch {
    return [];
  }
}

function isAnthropicStyle(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.pathname.toLowerCase().includes('anthropic') ||
           u.hostname.toLowerCase().includes('anthropic');
  } catch { return false; }
}

function buildChatUrl(baseUrl, anthropic) {
  const base = baseUrl.replace(/\/+$/, '');
  const v1Base = base.endsWith('/v1') ? base : base + '/v1';
  return v1Base + (anthropic ? '/messages' : '/chat/completions');
}

function buildImageUrl(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+(\/|$)/.test(base)) return base + '/images/generations';
  return base + '/v1/images/generations';
}

/** Find base_url + token for a model in the new group-based localCfg. */
function resolveLocalGroup(localCfg, modelName) {
  if (localCfg?.model_groups?.length) {
    const g = localCfg.model_groups.find((g) =>
      (g.models || []).some((m) => (typeof m === 'string' ? m : m.name) === modelName)
    );
    if (g) return { base_url: g.base_url || '', token: g.token || '' };
  }
  return { base_url: localCfg?.llm_base_url || '', token: localCfg?.llm_token || '' };
}

function toAnthropicBody(messages, model, stream) {
  const sys = messages.find((m) => m.role === 'system');
  const sysText = !sys ? undefined
    : typeof sys.content === 'string' ? sys.content
    : Array.isArray(sys.content) ? sys.content.map((b) => b.text || '').join('') : '';
  return {
    model,
    max_tokens: 8096,
    stream: !!stream,
    messages: messages.filter((m) => m.role !== 'system'),
    ...(sysText ? { system: sysText } : {}),
  };
}

// Returns [{id, model_type}]
function fetchModels(source, localCfg, apiKey) {
  if (source === 'local') {
    if (!localCfg?.llm_base_url && !localCfg?.model_groups?.length) return Promise.resolve([]);
    // Collect all models from groups or legacy config
    const allModels = [];
    if (localCfg?.model_groups?.length) {
      for (const g of localCfg.model_groups) {
        for (const m of g.models || []) {
          const name = typeof m === 'string' ? m : m.name;
          const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
          if (name) allModels.push({ id: name, model_type: type });
        }
      }
    }
    if (!allModels.length) {
      // Legacy: try /v1/models from the single base_url
      if (isAnthropicStyle(localCfg.llm_base_url)) {
        return Promise.resolve(
          (localCfg.models || []).map((m) =>
            typeof m === 'string' ? { id: m, model_type: 'chat' }
            : { id: m.name, model_type: m.type || 'chat' }
          )
        );
      }
      const base = localCfg.llm_base_url.replace(/\/+$/, '');
      const url = (base.endsWith('/v1') ? base : base + '/v1') + '/models';
      const headers = {};
      if (localCfg.llm_token) headers['Authorization'] = `Bearer ${localCfg.llm_token}`;
      const parse = (d) => (d.data || []).map((m) => ({
        id: m.id, model_type: m.model_type || 'chat',
      }));
      if (window.electronAPI?.llm) {
        return window.electronAPI.llm.fetch(url, { headers })
          .then((r) => parse(JSON.parse(r.body)))
          .catch(() => (localCfg.models || []).map((m) =>
            typeof m === 'string' ? { id: m, model_type: 'chat' }
            : { id: m.name, model_type: m.type || 'chat' }
          ));
      }
      return fetch(url, { headers })
        .then((r) => r.json()).then(parse)
        .catch(() => []);
    }
    return Promise.resolve(allModels);
  } else {
    const serverUrl = getServerUrl();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    return fetch(`${serverUrl}/v1/models`, { headers })
      .then((r) => r.json())
      .then((d) => (d.data || []).map((m) => ({ id: m.id, model_type: m.model_type || 'chat' })))
      .catch(() => []);
  }
}

function parseSseLines(lines, anthropic, firstTokenTime, onChunk, currentEventRef) {
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) { currentEventRef.v = null; continue; }
    if (anthropic) {
      if (trimmed.startsWith('event: ')) {
        currentEventRef.v = trimmed.slice(7).trim();
      } else if (trimmed.startsWith('data: ') && currentEventRef.v === 'content_block_delta') {
        try {
          const d = JSON.parse(trimmed.slice(6));
          const text = d.delta?.type === 'text_delta' ? d.delta.text : '';
          if (text) onChunk(text, firstTokenTime.v === null ? (firstTokenTime.v = Date.now()) : null);
        } catch {}
      }
    } else {
      if (trimmed === 'data: [DONE]') continue;
      if (trimmed.startsWith('data: ')) {
        try {
          const d = JSON.parse(trimmed.slice(6));
          const delta = d.choices?.[0]?.delta?.content ?? '';
          if (delta) onChunk(delta, firstTokenTime.v === null ? (firstTokenTime.v = Date.now()) : null);
        } catch {}
      }
    }
  }
}

async function streamChat({ source, localCfg, apiKey, model, messages, stream, onChunk, onDone, onError }) {
  const isLocal = source === 'local';
  const group = isLocal ? resolveLocalGroup(localCfg, model) : null;
  const anthropic = isLocal && isAnthropicStyle(group?.base_url || '');
  const useIpc = isLocal && !!window.electronAPI?.llm;

  const url = isLocal
    ? buildChatUrl(group?.base_url || '', anthropic)
    : `${getServerUrl()}/v1/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  if (isLocal && group?.token) headers['Authorization'] = `Bearer ${group.token}`;
  if (isLocal && anthropic) headers['anthropic-version'] = '2023-06-01';
  if (!isLocal && apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const body = anthropic
    ? JSON.stringify(toAnthropicBody(messages, model, stream))
    : JSON.stringify({ model, messages, stream });

  const startTime = Date.now();
  const firstTokenTime = { v: null };

  if (useIpc) {
    if (!stream) {
      const result = await window.electronAPI.llm.fetch(url, { method: 'POST', headers, body });
      if (result.status < 200 || result.status >= 300) { onError(`HTTP ${result.status}: ${result.body}`); return; }
      try {
        const data = JSON.parse(result.body);
        const content = anthropic
          ? (data.content || []).map((b) => b.text || '').join('')
          : (data.choices?.[0]?.message?.content ?? '');
        onChunk(content);
      } catch { onChunk(result.body); }
      onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      return;
    }
    await new Promise((resolve) => {
      let buf = '';
      const currentEventRef = { v: null };
      window.electronAPI.llm.stream(
        { url, method: 'POST', headers, body },
        (raw) => {
          buf += raw;
          const lines = buf.split('\n');
          buf = lines.pop();
          parseSseLines(lines, anthropic, firstTokenTime, (text) => {
            if (firstTokenTime.v === null) firstTokenTime.v = Date.now();
            onChunk(text);
          }, currentEventRef);
        },
        () => { onDone({ firstTokenMs: firstTokenTime.v ? firstTokenTime.v - startTime : null, totalMs: Date.now() - startTime }); resolve(); },
        (err) => { onError(err); resolve(); }
      );
    });
    return;
  }

  try {
    const resp = await fetch(url, { method: 'POST', headers, body });
    if (!resp.ok) { onError(`HTTP ${resp.status}: ${await resp.text()}`); return; }
    if (!stream) {
      const data = await resp.json();
      const content = anthropic
        ? (data.content || []).map((b) => b.text || '').join('')
        : (data.choices?.[0]?.message?.content ?? '');
      onChunk(content);
      onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const currentEventRef = { v: null };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      parseSseLines(lines, anthropic, firstTokenTime, (text) => {
        if (firstTokenTime.v === null) firstTokenTime.v = Date.now();
        onChunk(text);
      }, currentEventRef);
    }
    onDone({ firstTokenMs: firstTokenTime.v ? firstTokenTime.v - startTime : null, totalMs: Date.now() - startTime });
  } catch (e) { onError(e.message); }
}

async function generateImage({ source, localCfg, apiKey, model, prompt, ratio, resolution, onDone, onError }) {
  const isLocal = source === 'local';
  const group = isLocal ? resolveLocalGroup(localCfg, model) : null;
  const url = isLocal
    ? buildImageUrl(group?.base_url || '')
    : `${getServerUrl()}/v1/images/generations`;

  const headers = { 'Content-Type': 'application/json' };
  if (isLocal && group?.token) headers['Authorization'] = `Bearer ${group.token}`;
  if (!isLocal && apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const extra = {};
  if (ratio) extra.ratio = ratio;
  if (resolution) extra.resolution = resolution;
  const body = JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json', ...extra });

  const startTime = Date.now();

  const doFetch = async (fetchFn, rawBody) => {
    const result = await fetchFn();
    const totalMs = Date.now() - startTime;
    try {
      const data = typeof result === 'string' ? JSON.parse(result) : result;
      if (data.detail || data.error) throw new Error(data.detail || data.error?.message || 'Error');
      const images = (data.data || []).map((item) => item.b64_json || item.url || '').filter(Boolean);
      if (images.length === 0) {
        const hint = rawBody ? rawBody.slice(0, 300) : JSON.stringify(data).slice(0, 300);
        throw new Error(`上游返回空图像列表，原始响应：${hint}`);
      }
      onDone({ images, totalMs });
    } catch (e) { onError(e.message); }
  };

  if (isLocal && window.electronAPI?.llm) {
    try {
      const r = await window.electronAPI.llm.fetch(url, { method: 'POST', headers, body });
      if (r.status < 200 || r.status >= 300) { onError(`HTTP ${r.status}: ${r.body}`); return; }
      await doFetch(() => Promise.resolve(JSON.parse(r.body)), r.body);
    } catch (e) { onError(e.message); }
    return;
  }

  try {
    const resp = await fetch(url, { method: 'POST', headers, body });
    if (!resp.ok) { onError(`HTTP ${resp.status}: ${await resp.text()}`); return; }
    const rawText = await resp.text();
    await doFetch(() => Promise.resolve(JSON.parse(rawText)), rawText);
  } catch (e) { onError(e.message); }
}

const defaultPanel = () => ({
  conversation: [],
  input: '',
  systemPrompt: '',
  showSystem: false,
  streamMode: true,
  imageMode: false,
  imageRatio: '',
  imageResolution: '',
});

export default function Debug() {
  const [source, setSource] = useState('network');
  const [panels, setPanels] = useState(() => ({ local: defaultPanel(), network: defaultPanel() }));
  const [localCfg, setLocalCfg] = useState(null);
  const [apiKeys, setApiKeys] = useState([]);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState([]);   // [{id, model_type}]
  const [model, setModel] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [sending, setSending] = useState({ local: false, network: false });

  const [lightbox, setLightbox] = useState(null); // imgSrc or null

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  const panel = panels[source];
  const { conversation, input, systemPrompt, showSystem, streamMode, imageMode, imageRatio, imageResolution } = panel;

  // Derived: models filtered to current mode
  const chatModels = models.filter((m) => m.model_type !== 'image');
  const imageModels = models.filter((m) => m.model_type === 'image');
  const filteredModels = imageMode ? imageModels : chatModels;

  useEffect(() => { window.electronAPI?.config.read().then((cfg) => setLocalCfg(cfg)); }, []);

  useEffect(() => {
    if (source !== 'network') return;
    setApiKeys([]); setApiKey('');
    fetchApiKeys().then((keys) => { setApiKeys(keys); if (keys.length > 0) setApiKey(keys[0].key); });
  }, [source]);

  useEffect(() => {
    setModels([]); setModel('');
    if (source === 'network' && !apiKey) return;
    setLoadingModels(true);
    fetchModels(source, localCfg, apiKey).then((list) => {
      setModels(list);
      // pick first model matching current mode
      const preferred = list.filter((m) => imageMode ? m.model_type === 'image' : m.model_type !== 'image');
      const first = preferred[0] || list[0];
      if (first) setModel(first.id);
    }).finally(() => setLoadingModels(false));
  }, [source, localCfg, apiKey]);

  // When mode changes, try to switch to a model of the right type
  useEffect(() => {
    if (!models.length) return;
    const preferred = models.filter((m) => imageMode ? m.model_type === 'image' : m.model_type !== 'image');
    if (preferred.length && !preferred.some((m) => m.id === model)) {
      setModel(preferred[0].id);
    }
  }, [imageMode]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [conversation, source]);

  function setPanel(patch) {
    setPanels((prev) => ({ ...prev, [source]: { ...prev[source], ...patch } }));
  }

  async function handleSend() {
    const text = input.trim();
    const tabKey = source;
    if (!text || !model || sending[tabKey]) return;

    if (imageMode) {
      const idx = conversation.length + 1;
      setPanel({ input: '', conversation: [...conversation, { role: 'user', content: text }, { role: 'assistant', images: null, generating: true }] });
      setSending((s) => ({ ...s, [tabKey]: true }));
      await generateImage({
        source: tabKey, localCfg, apiKey, model, prompt: text,
        ratio: imageRatio || undefined, resolution: imageResolution || undefined,
        onDone: ({ images, totalMs }) => {
          setPanels((prev) => {
            const p = prev[tabKey];
            const next = [...p.conversation];
            next[idx] = { ...next[idx], images, generating: false, timing: { totalMs } };
            return { ...prev, [tabKey]: { ...p, conversation: next } };
          });
          setSending((s) => ({ ...s, [tabKey]: false }));
        },
        onError: (msg) => {
          setPanels((prev) => {
            const p = prev[tabKey];
            const next = [...p.conversation];
            next[idx] = { ...next[idx], generating: false, error: msg };
            return { ...prev, [tabKey]: { ...p, conversation: next } };
          });
          setSending((s) => ({ ...s, [tabKey]: false }));
        },
      });
      return;
    }

    const apiMessages = [];
    if (systemPrompt.trim()) apiMessages.push({ role: 'system', content: systemPrompt.trim() });
    conversation.forEach((m) => {
      if (m.role === 'user' || m.role === 'assistant') apiMessages.push({ role: m.role, content: m.content });
    });
    apiMessages.push({ role: 'user', content: text });

    const assistantIdx = conversation.length + 1;
    setPanel({ input: '', conversation: [...conversation, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true }] });
    setSending((s) => ({ ...s, [tabKey]: true }));

    await streamChat({
      source: tabKey, localCfg, apiKey, model, messages: apiMessages, stream: streamMode,
      onChunk: (delta) => {
        setPanels((prev) => {
          const p = prev[tabKey];
          const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], content: next[assistantIdx].content + delta };
          return { ...prev, [tabKey]: { ...p, conversation: next } };
        });
      },
      onDone: (timing) => {
        setPanels((prev) => {
          const p = prev[tabKey];
          const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, timing };
          return { ...prev, [tabKey]: { ...p, conversation: next } };
        });
        setSending((s) => ({ ...s, [tabKey]: false }));
      },
      onError: (msg) => {
        setPanels((prev) => {
          const p = prev[tabKey];
          const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, error: msg };
          return { ...prev, [tabKey]: { ...p, conversation: next } };
        });
        setSending((s) => ({ ...s, [tabKey]: false }));
      },
    });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); }
  }

  function handleClear() { setPanel({ conversation: [], input: '' }); }

  function handleInputChange(e) {
    const v = e.target.value;
    setPanel({ input: v });
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }
  }

  const apiKeyErr = source === 'network' && apiKeys.length === 0;

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
                  source === v ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}>{l}</button>
            ))}
          </div>

          {/* Mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 shrink-0">
            {[{ v: false, l: '对话' }, { v: true, l: '图像' }].map(({ v, l }) => (
              <button key={String(v)} onClick={() => setPanel({ imageMode: v })}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  imageMode === v ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}>{l}</button>
            ))}
          </div>

          {/* Model selector */}
          {!apiKeyErr && (filteredModels.length > 0 ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}
              className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500 max-w-[200px]">
              {filteredModels.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          ) : loadingModels ? (
            <span className="text-xs text-gray-400 dark:text-gray-500">加载模型…</span>
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {imageMode ? '无图像模型' : (source === 'local' && !localCfg?.llm_base_url && !localCfg?.model_groups?.length ? '请先配置本地 LLM 地址' : '暂无可用模型')}
            </span>
          ))}

          {/* Image-only controls */}
          {imageMode && (
            <>
              <select value={imageRatio} onChange={(e) => setPanel({ imageRatio: e.target.value })}
                className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:border-indigo-500">
                <option value="">比例(默认)</option>
                {['1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <select value={imageResolution} onChange={(e) => setPanel({ imageResolution: e.target.value })}
                className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:border-indigo-500">
                <option value="">分辨率(默认)</option>
                {['1k','2k','4k'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </>
          )}

          {/* Chat-only controls */}
          {!imageMode && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                <input type="checkbox" checked={streamMode}
                  onChange={(e) => setPanel({ streamMode: e.target.checked })}
                  className="w-3.5 h-3.5 accent-blue-600" />
                流式
              </label>
              <button
                onClick={() => setPanel({ showSystem: !showSystem })}
                className={`text-xs px-2 py-1 rounded-md transition-colors ${showSystem ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                System
              </button>
            </>
          )}

          {/* API Key + clear — right side */}
          <div className="ml-auto flex items-center gap-2">
            {source === 'network' && (apiKeys.length === 0 ? (
              <span className="text-xs text-red-500 dark:text-red-400">需要先在「供给源」中创建 API Key</span>
            ) : (
              <select value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500 max-w-[180px]"
                title="API Key">
                {apiKeys.map((k) => (
                  <option key={k.id} value={k.key}>{k.note ? k.note : k.key.slice(0, 16) + '…'}</option>
                ))}
              </select>
            ))}
            {conversation.length > 0 && (
              <button onClick={handleClear}
                className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                清空
              </button>
            )}
          </div>
        </div>

        {/* System prompt */}
        {!imageMode && showSystem && (
          <textarea value={systemPrompt}
            onChange={(e) => setPanel({ systemPrompt: e.target.value })}
            rows={2} placeholder="System Prompt（可选）"
            className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-none" />
        )}
      </div>

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {conversation.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 dark:text-gray-600 select-none">
            <p className="text-3xl mb-2">{imageMode ? '🎨' : '🐛'}</p>
            <p className="text-sm">{imageMode ? '输入提示词生成图片' : '选择来源和模型，发送消息开始调试'}</p>
          </div>
        )}

        {conversation.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs shrink-0 mt-0.5 mr-2">
                AI
              </div>
            )}
            <div className="max-w-[75%]">
              {msg.error ? (
                <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-2xl px-4 py-2.5 text-sm text-red-600 dark:text-red-400">
                  {msg.error}
                </div>
              ) : msg.role === 'assistant' && msg.images !== undefined ? (
                // Image result
                <div className="rounded-2xl overflow-hidden bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent">
                  {msg.generating ? (
                    <div className="px-4 py-6 flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500">
                      <span className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                      生成中…
                    </div>
                  ) : (msg.images || []).length > 0 ? (
                    <div className="space-y-2 p-2">
                      {msg.images.map((src, j) => {
                        const imgSrc = src.startsWith('data:') ? src : src.startsWith('http') ? src : `data:image/png;base64,${src}`;
                        const handleSave = () => {
                          const a = document.createElement('a');
                          a.href = imgSrc;
                          a.download = `generated-${Date.now()}.png`;
                          a.click();
                        };
                        const handleCopy = async () => {
                          try {
                            const resp = await fetch(imgSrc);
                            const blob = await resp.blob();
                            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
                          } catch {}
                        };
                        return (
                          <div key={j} className="relative group">
                            <img src={imgSrc} alt={`generated-${j}`} className="rounded-xl max-w-full cursor-zoom-in" onClick={() => setLightbox(imgSrc)} />
                            <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={handleCopy}
                                className="px-2 py-1 text-xs bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm">
                                复制
                              </button>
                              <button onClick={handleSave}
                                className="px-2 py-1 text-xs bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm">
                                保存
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">无图像返回</div>
                  )}
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
          <textarea ref={textareaRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
            placeholder={imageMode ? '输入图像提示词… (Cmd+Enter 发送)' : '输入消息… (Cmd+Enter 发送)'}
            rows={1} style={{ resize: 'none' }}
            className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 overflow-hidden" />
          <button onClick={handleSend}
            disabled={sending[source] || !input.trim() || !model}
            className="shrink-0 w-9 h-9 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-xl flex items-center justify-center transition-colors">
            {sending[source]
              ? <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              : <span className="text-white text-sm">↑</span>}
          </button>
        </div>
      </div>

      {/* ── Lightbox ── */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
          onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="preview" className="max-w-full max-h-full object-contain" onClick={(e) => e.stopPropagation()} />
          <button onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl leading-none">✕</button>
        </div>
      )}
    </div>
  );
}
