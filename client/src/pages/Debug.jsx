import React, { useState, useEffect, useRef } from 'react';
import { getConfig, getLocalConfig, getGateway } from '../api/adapter';
import { useLang } from '../store/lang';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAnthropicUrl(url) {
  try { return /anthropic/i.test(new URL(url).hostname + new URL(url).pathname); } catch { return false; }
}

function buildChatUrl(base, anthropic) {
  const b = base.replace(/\/+$/, '');
  return b + (anthropic ? '/v1/messages' : '/v1/chat/completions');
}

function buildImageUrl(base) {
  return base.replace(/\/+$/, '') + '/v1/images/generations';
}

function toAnthropicBody(messages, model, stream) {
  const sys = messages.find(m => m.role === 'system');
  const sysText = !sys ? undefined
    : typeof sys.content === 'string' ? sys.content
    : Array.isArray(sys.content) ? sys.content.map(b => b.text || '').join('') : '';
  return {
    model, max_tokens: 8096, stream: !!stream,
    messages: messages.filter(m => m.role !== 'system'),
    ...(sysText ? { system: sysText } : {}),
  };
}

function parseSseLines(lines, anthropic, firstTokenTime, onChunk, evRef) {
  for (const line of lines) {
    const t = line.trimEnd();
    if (!t) { evRef.v = null; continue; }
    if (anthropic) {
      if (t.startsWith('event: ')) { evRef.v = t.slice(7).trim(); }
      else if (t.startsWith('data: ') && evRef.v === 'content_block_delta') {
        try {
          const d = JSON.parse(t.slice(6));
          const text = d.delta?.type === 'text_delta' ? d.delta.text : '';
          if (text) { if (firstTokenTime.v === null) firstTokenTime.v = Date.now(); onChunk(text); }
        } catch {}
      }
    } else {
      if (t === 'data: [DONE]') continue;
      if (t.startsWith('data: ')) {
        try {
          const d = JSON.parse(t.slice(6));
          const delta = d.choices?.[0]?.delta?.content ?? '';
          if (delta) { if (firstTokenTime.v === null) firstTokenTime.v = Date.now(); onChunk(delta); }
        } catch {}
      }
    }
  }
}

async function doStreamChat({ baseUrl, token, model, messages, stream, anthropic, onChunk, onDone, onError }) {
  const url = buildChatUrl(baseUrl, anthropic);
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    if (anthropic) { headers['x-api-key'] = token; headers['anthropic-version'] = '2023-06-01'; }
    else headers['Authorization'] = `Bearer ${token}`;
  }
  const body = JSON.stringify(anthropic ? toAnthropicBody(messages, model, stream) : { model, messages, stream });
  const startTime = Date.now();
  const firstTokenTime = { v: null };

  const useIpc = !!window.electronAPI?.llm;
  if (useIpc) {
    if (!stream) {
      try {
        const r = await window.electronAPI.llm.fetch(url, { method: 'POST', headers, body });
        if (r.status >= 300) { onError(`HTTP ${r.status}: ${r.body}`); return; }
        const data = JSON.parse(r.body);
        const content = anthropic
          ? (data.content || []).map(b => b.text || '').join('')
          : (data.choices?.[0]?.message?.content ?? '');
        onChunk(content);
        onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      } catch (e) { onError(e.message); }
      return;
    }
    await new Promise(resolve => {
      let buf = ''; const evRef = { v: null };
      window.electronAPI.llm.stream({ url, method: 'POST', headers, body },
        raw => {
          buf += raw;
          const lines = buf.split('\n'); buf = lines.pop();
          parseSseLines(lines, anthropic, firstTokenTime, onChunk, evRef);
        },
        () => { onDone({ firstTokenMs: firstTokenTime.v ? firstTokenTime.v - startTime : null, totalMs: Date.now() - startTime }); resolve(); },
        err => { onError(err); resolve(); }
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
        ? (data.content || []).map(b => b.text || '').join('')
        : (data.choices?.[0]?.message?.content ?? '');
      onChunk(content);
      onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      return;
    }
    const reader = resp.body.getReader(); const decoder = new TextDecoder();
    let buf = ''; const evRef = { v: null };
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      parseSseLines(lines, anthropic, firstTokenTime, onChunk, evRef);
    }
    onDone({ firstTokenMs: firstTokenTime.v ? firstTokenTime.v - startTime : null, totalMs: Date.now() - startTime });
  } catch (e) { onError(e.message); }
}

async function doGenerateImage({ baseUrl, token, model, prompt, ratio, resolution, onDone, onError, t }) {
  const url = buildImageUrl(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const extra = {};
  if (ratio) extra.ratio = ratio;
  if (resolution) extra.resolution = resolution;
  const body = JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json', ...extra });
  const startTime = Date.now();

  const parse = async (text) => {
    const data = JSON.parse(text);
    if (data.detail || data.error) throw new Error(data.detail || data.error?.message || 'Error');
    const images = (data.data || []).map(item => item.b64_json || item.url || '').filter(Boolean);
    if (!images.length) throw new Error(t('debug.emptyImageList', { text: text.slice(0, 200) }));
    onDone({ images, totalMs: Date.now() - startTime });
  };

  try {
    if (window.electronAPI?.llm) {
      const r = await window.electronAPI.llm.fetch(url, { method: 'POST', headers, body });
      if (r.status >= 300) { onError(`HTTP ${r.status}: ${r.body}`); return; }
      await parse(r.body);
    } else {
      const resp = await fetch(url, { method: 'POST', headers, body });
      if (!resp.ok) { onError(`HTTP ${resp.status}: ${await resp.text()}`); return; }
      await parse(await resp.text());
    }
  } catch (e) { onError(e.message); }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCAL_GW = { id: '__local_gw__', base_url: 'http://127.0.0.1:11430', token: '', models: [] };
const CUSTOM   = { id: '__custom__',   base_url: '', token: '', models: [] };

const TIER_ORDER = ['free', 'p2p', 'paid'];

function normModel(m) { return typeof m === 'string' ? { name: m, type: 'chat' } : { name: m.name, type: m.type || 'chat' }; }

function providerOptions(cfg, localCfg, localGw, t) {
  // Build local gateway model list: collect all enabled provider models tagged with tier
  const gwModels = [];
  const seen = new Set();
  for (const tier of TIER_ORDER) {
    for (const p of (cfg?.providers || [])) {
      if (!p.enabled || p.type !== tier) continue;
      if (p.type !== 'p2p' && !p.base_url) continue;
      for (const m of (p.models || [])) {
        const { name, type } = normModel(m);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        gwModels.push({ name, type, tier });
      }
    }
  }

  const opts = [{ ...localGw, label: t('debug.localGw'), models: gwModels }];
  for (const p of (cfg?.providers || [])) {
    if (!p.enabled || p.type === 'p2p' || !p.base_url) continue;
    const label = (() => { try { return new URL(p.base_url).hostname; } catch { return p.id; } })();
    opts.push({ id: p.id, label, base_url: p.base_url, token: p.token || '', models: (p.models || []).map(normModel) });
  }
  // P2P backend from local-config cloud_config
  const cc = localCfg?.cloud_config;
  if (cc?.url) {
    const label = (() => { try { return new URL(cc.url).hostname; } catch { return t('debug.p2pBackend'); } })();
    opts.push({ id: '__p2p__', label: `🌐 ${label}`, base_url: cc.url, token: cc.token || '', models: [] });
  }
  opts.push({ ...CUSTOM, label: t('debug.custom') });
  return opts;
}

const defaultPanel = () => ({ conversation: [], input: '', systemPrompt: '', showSystem: false, streamMode: true, imageMode: false, imageRatio: '', imageResolution: '' });

// ── Component ─────────────────────────────────────────────────────────────────

export default function Debug() {
  const { t } = useLang();
  const [cfg,            setCfg]           = useState(null);
  const [provOpts,       setProvOpts]      = useState([]);
  const [selectedId,     setSelectedId]    = useState('__local_gw__');
  const [manualBaseUrl,  setManualBaseUrl] = useState('');
  const [token,          setToken]         = useState('');
  const [showToken,      setShowToken]     = useState(false);
  const [models,         setModels]        = useState([]);   // {name, type}[]
  const [model,          setModel]         = useState('');
  const [manualModel,    setManualModel]   = useState(false);
  const [loadingModels,  setLoadingModels] = useState(false);
  const [panels,         setPanels]        = useState({ main: defaultPanel() });
  const [sending,        setSending]       = useState(false);
  const [lightbox,       setLightbox]      = useState(null);

  const panel = panels.main;
  const { conversation, input, systemPrompt, showSystem, streamMode, imageMode, imageRatio, imageResolution } = panel;

  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);

  // Load config + gateway status (to get actual running port)
  useEffect(() => {
    Promise.all([
      getConfig().read().catch(() => null),
      getLocalConfig().get().catch(() => null),
      getGateway().status().catch(() => null),
    ]).then(([c, lc, gwStatus]) => {
      setCfg(c);
      const gwPort = gwStatus?.port || 11430;
      const localGw = { ...LOCAL_GW, base_url: `http://127.0.0.1:${gwPort}` };
      setProvOpts(providerOptions(c, lc, localGw, t));
    });
  }, [t]);

  // When selected provider changes
  useEffect(() => {
    const opt = provOpts.find(o => o.id === selectedId) || LOCAL_GW;
    if (selectedId === '__custom__') {
      setToken(''); setModels([]); setModel(''); setManualModel(true); return;
    }
    setToken(opt.token || '');
    const staticMods = opt.models || [];
    if (staticMods.length > 0) {
      setModels(staticMods);
      const preferred = staticMods.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
      setModel((preferred[0] || staticMods[0])?.name || '');
      setManualModel(false);
      return;
    }
    // Try to fetch /v1/models from the provider
    const base = (opt.base_url || '').replace(/\/+$/, '');
    if (!base) { setModels([]); setModel(''); setManualModel(true); return; }
    const url = base + '/v1/models';
    const headers = {};
    if (opt.token) {
      if (/anthropic/i.test(base)) { headers['x-api-key'] = opt.token; headers['anthropic-version'] = '2023-06-01'; }
      else headers['Authorization'] = `Bearer ${opt.token}`;
    }
    setLoadingModels(true); setModels([]); setModel(''); setManualModel(false);
    const doFetch = async () => {
      try {
        let data;
        if (window.electronAPI?.llm) {
          const r = await window.electronAPI.llm.fetch(url, { headers });
          data = JSON.parse(r.body);
        } else {
          data = await fetch(url, { headers }).then(r => r.json());
        }
        const list = (data.data || []).map(m => ({ name: m.id || m.name, type: m.model_type || 'chat' })).filter(m => m.name);
        setModels(list);
        const preferred = list.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
        setModel((preferred[0] || list[0])?.name || '');
        setManualModel(list.length === 0);
      } catch {
        setModels([]); setManualModel(true);
      } finally {
        setLoadingModels(false);
      }
    };
    doFetch();
  }, [selectedId, provOpts]);

  // When imageMode changes, try to switch to right model type
  useEffect(() => {
    if (!models.length) return;
    const preferred = models.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
    if (preferred.length && !preferred.some(m => m.name === model)) setModel(preferred[0].name);
  }, [imageMode]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [conversation]);

  function setPanel(patch) { setPanels(prev => ({ ...prev, main: { ...prev.main, ...patch } })); }

  const effectiveBase = selectedId === '__custom__' ? manualBaseUrl : (provOpts.find(o => o.id === selectedId)?.base_url || '');
  const anthropic     = isAnthropicUrl(effectiveBase);
  const filteredModels = models.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');

  async function handleSend() {
    const text = input.trim();
    if (!text || !model || !effectiveBase || sending) return;

    if (imageMode) {
      const idx = conversation.length + 1;
      setPanel({ input: '', conversation: [...conversation, { role: 'user', content: text }, { role: 'assistant', images: null, generating: true }] });
      setSending(true);
      await doGenerateImage({
        baseUrl: effectiveBase, token, model, prompt: text,
        ratio: imageRatio || undefined, resolution: imageResolution || undefined, t,
        onDone: ({ images, totalMs }) => {
          setPanels(prev => {
            const p = prev.main; const next = [...p.conversation];
            next[idx] = { ...next[idx], images, generating: false, timing: { totalMs } };
            return { ...prev, main: { ...p, conversation: next } };
          });
          setSending(false);
        },
        onError: msg => {
          setPanels(prev => {
            const p = prev.main; const next = [...p.conversation];
            next[idx] = { ...next[idx], generating: false, error: msg };
            return { ...prev, main: { ...p, conversation: next } };
          });
          setSending(false);
        },
      });
      return;
    }

    const apiMessages = [];
    if (systemPrompt.trim()) apiMessages.push({ role: 'system', content: systemPrompt.trim() });
    conversation.forEach(m => { if (m.role === 'user' || m.role === 'assistant') apiMessages.push({ role: m.role, content: m.content }); });
    apiMessages.push({ role: 'user', content: text });

    const assistantIdx = conversation.length + 1;
    setPanel({ input: '', conversation: [...conversation, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true }] });
    setSending(true);

    await doStreamChat({
      baseUrl: effectiveBase, token, model, messages: apiMessages, stream: streamMode, anthropic,
      onChunk: delta => {
        setPanels(prev => {
          const p = prev.main; const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], content: next[assistantIdx].content + delta };
          return { ...prev, main: { ...p, conversation: next } };
        });
      },
      onDone: timing => {
        setPanels(prev => {
          const p = prev.main; const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, timing };
          return { ...prev, main: { ...p, conversation: next } };
        });
        setSending(false);
      },
      onError: msg => {
        setPanels(prev => {
          const p = prev.main; const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, error: msg };
          return { ...prev, main: { ...p, conversation: next } };
        });
        setSending(false);
      },
    });
  }

  function handleKeyDown(e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } }
  function handleInputChange(e) {
    setPanel({ input: e.target.value });
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }
  }

  return (
    <div className="flex flex-col h-screen">

      {/* ── Toolbar ── */}
      <div className="shrink-0 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 pt-3 pb-2 space-y-2">

        {/* Row 1: provider + token */}
        <div className="flex gap-2 items-center flex-wrap">
          {/* Provider dropdown */}
          <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
            className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500 shrink-0">
            {provOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>

          {/* Base URL (custom or display) */}
          {selectedId === '__custom__' ? (
            <input value={manualBaseUrl} onChange={e => setManualBaseUrl(e.target.value)}
              placeholder={t('debug.baseUrlPh')}
              className="flex-1 min-w-[200px] bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
          ) : (
            <code className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate max-w-[260px]">{effectiveBase}</code>
          )}

          {/* API Key/Token */}
          <div className="flex gap-1 items-center ml-auto">
            {anthropic && effectiveBase && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800/40 shrink-0">Anthropic</span>
            )}
            <input value={token} onChange={e => setToken(e.target.value)}
              type={showToken ? 'text' : 'password'} placeholder={t('debug.apiKeyPh')} autoComplete="off"
              className="w-36 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
            <button onClick={() => setShowToken(v => !v)}
              className="text-[10px] px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors shrink-0">
              {showToken ? t('debug.hide') : t('debug.show')}
            </button>
          </div>
        </div>

        {/* Row 2: model + mode + options */}
        <div className="flex gap-2 items-center flex-wrap">
          {/* Model selector */}
          {loadingModels ? (
            <span className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
              <span className="w-3 h-3 border border-gray-300 border-t-blue-400 rounded-full animate-spin" />
              {t('debug.loadingModels')}
            </span>
          ) : !manualModel && filteredModels.length > 0 ? (
            <select value={model} onChange={e => setModel(e.target.value)}
              className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500 max-w-[220px]">
              {filteredModels.some(m => m.tier)
                ? TIER_ORDER.map(tier => {
                    const tms = filteredModels.filter(m => m.tier === tier);
                    return tms.length ? (
                      <optgroup key={tier} label={t(`debug.tier.${tier}`)}>
                        {tms.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                      </optgroup>
                    ) : null;
                  })
                : filteredModels.map(m => <option key={m.name} value={m.name}>{m.name}</option>)
              }
            </select>
          ) : (
            <input value={model} onChange={e => setModel(e.target.value)}
              placeholder={t('debug.modelPh')}
              className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 w-44" />
          )}
          {/* Toggle dropdown ↔ manual */}
          {!loadingModels && models.length > 0 && (
            <button onClick={() => setManualModel(v => !v)}
              className="text-[10px] text-gray-400 hover:text-blue-500 transition-colors shrink-0">
              {manualModel ? t('debug.pickFromList') : t('debug.manualInput')}
            </button>
          )}

          {/* Mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 shrink-0">
            {[{ v: false, l: t('debug.modeChat') }, { v: true, l: t('debug.modeImage') }].map(({ v, l }) => (
              <button key={String(v)} onClick={() => setPanel({ imageMode: v })}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  imageMode === v ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}>{l}</button>
            ))}
          </div>

          {/* Image-only controls */}
          {imageMode && (
            <>
              <select value={imageRatio} onChange={e => setPanel({ imageRatio: e.target.value })}
                className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none">
                <option value="">{t('debug.ratioDefault')}</option>
                {['1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <select value={imageResolution} onChange={e => setPanel({ imageResolution: e.target.value })}
                className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none">
                <option value="">{t('debug.resolutionDefault')}</option>
                {['1k','2k','4k'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </>
          )}

          {/* Chat-only controls */}
          {!imageMode && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                <input type="checkbox" checked={streamMode} onChange={e => setPanel({ streamMode: e.target.checked })} className="w-3.5 h-3.5 accent-blue-600" />
                {t('debug.stream')}
              </label>
              <button onClick={() => setPanel({ showSystem: !showSystem })}
                className={`text-xs px-2 py-1 rounded-md transition-colors ${showSystem ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                System
              </button>
            </>
          )}

          {conversation.length > 0 && (
            <button onClick={() => setPanel({ conversation: [], input: '' })}
              className="ml-auto text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors">
              {t('debug.clear')}
            </button>
          )}
        </div>

        {/* System prompt */}
        {!imageMode && showSystem && (
          <textarea value={systemPrompt} onChange={e => setPanel({ systemPrompt: e.target.value })}
            rows={2} placeholder={t('debug.systemPh')}
            className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-none" />
        )}
      </div>

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {conversation.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 dark:text-gray-600 select-none">
            <p className="text-3xl mb-2">{imageMode ? '🎨' : '🐛'}</p>
            <p className="text-sm">{imageMode ? t('debug.emptyImage') : t('debug.emptyChat')}</p>
          </div>
        )}

        {conversation.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs shrink-0 mt-0.5 mr-2">AI</div>
            )}
            <div className="max-w-[75%]">
              {msg.error ? (
                <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-2xl px-4 py-2.5 text-sm text-red-600 dark:text-red-400">{msg.error}</div>
              ) : msg.role === 'assistant' && msg.images !== undefined ? (
                <div className="rounded-2xl overflow-hidden bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent">
                  {msg.generating ? (
                    <div className="px-4 py-6 flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500">
                      <span className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" /> {t('debug.generating')}
                    </div>
                  ) : (msg.images || []).length > 0 ? (
                    <div className="space-y-2 p-2">
                      {msg.images.map((src, j) => {
                        const imgSrc = src.startsWith('data:') || src.startsWith('http') ? src : `data:image/png;base64,${src}`;
                        return (
                          <div key={j} className="relative group">
                            <img src={imgSrc} alt={`gen-${j}`} className="rounded-xl max-w-full cursor-zoom-in" onClick={() => setLightbox(imgSrc)} />
                            <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={async () => { try { const b = await (await fetch(imgSrc)).blob(); await navigator.clipboard.write([new ClipboardItem({ [b.type]: b })]); } catch {} }}
                                className="px-2 py-1 text-xs bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm">{t('debug.copy')}</button>
                              <button onClick={() => { const a = document.createElement('a'); a.href = imgSrc; a.download = `gen-${Date.now()}.png`; a.click(); }}
                                className="px-2 py-1 text-xs bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm">{t('debug.saveImage')}</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">{t('debug.noImage')}</div>
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
                  {msg.timing.firstTokenMs != null ? t('debug.firstToken', { ms: msg.timing.firstTokenMs }) : ''}{t('debug.total', { ms: msg.timing.totalMs })}
                </p>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-300 text-xs shrink-0 mt-0.5 ml-2">{t('debug.me')}</div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ── */}
      <div className="shrink-0 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3">
        <div className="flex gap-2 items-end">
          <textarea ref={textareaRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
            placeholder={imageMode ? t('debug.inputImagePh') : t('debug.inputChatPh')}
            rows={1} style={{ resize: 'none' }}
            className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 overflow-hidden" />
          <button onClick={handleSend} disabled={sending || !input.trim() || !model || !effectiveBase}
            className="shrink-0 w-9 h-9 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-xl flex items-center justify-center transition-colors">
            {sending
              ? <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              : <span className="text-white text-sm">↑</span>}
          </button>
        </div>
      </div>

      {/* ── Lightbox ── */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="preview" className="max-w-full max-h-full object-contain" onClick={e => e.stopPropagation()} />
          <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl leading-none">✕</button>
        </div>
      )}
    </div>
  );
}
