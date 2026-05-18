import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getStats, getSettlements, listKeys, createKey, toggleKey, deleteKey } from '../api/client';
import { useAuth } from '../store/index';
import { getServerUrl } from '../config';
import RateChart from '../components/RateChart';
import { LLM_PROVIDER_PRESETS, matchPresetId } from '../data/llmProviderPresets';

function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}


function LLMConfigCard() {
  const [cfg, setCfg]               = useState(null);   // saved config
  const [editing, setEditing]       = useState(false);
  const [providerId, setProviderId] = useState('custom');
  const [llmUrl, setLlmUrl]         = useState('');
  const [llmToken, setLlmToken]     = useState('');
  const [modelsText, setModelsText] = useState('');
  const [nodeName, setNodeName]     = useState('');
  const [autoStart, setAutoStart]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const [savedMsg, setSavedMsg]     = useState('');
  const [scanning, setScanning]     = useState(false);
  /** 贡献节点 API Key：是否明文显示（默认隐藏） */
  const [showLlmToken, setShowLlmToken] = useState(false);
  /** 用于「推荐模型」下拉重置，便于连续选同一项 */
  const [modelPickNonce, setModelPickNonce] = useState(0);

  const presetHint = LLM_PROVIDER_PRESETS.find((p) => p.id === providerId)?.hint || '';
  const suggestedModels = LLM_PROVIDER_PRESETS.find((p) => p.id === providerId)?.defaultModels || [];

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then(async (saved) => {
      if (saved?.llm_base_url) {
        setCfg(saved);
      } else {
        // silently scan and auto-save the best match
        try {
          const results = await window.electronAPI.config.scan();
          const best = results[0];
          if (best?.base_url) {
            const models = best.models || [];
            const current = saved || {};
            const updated = {
              ...current,
              llm_base_url: best.base_url,
              llm_token:    best.token || '',
              models,
            };
            await window.electronAPI.config.write(updated);
            setCfg(updated);
            return;
          }
        } catch {}
        // nothing found — open the manual form
        setCfg(saved || {});
        setEditing(true);
      }
    });
  }, []);

  function openEdit() {
    const url = cfg?.llm_base_url || '';
    setLlmUrl(url);
    setProviderId(matchPresetId(url));
    setLlmToken(cfg?.llm_token || '');
    setModelsText((cfg?.models || []).join(', '));
    setNodeName(cfg?.name || '');
    setAutoStart(!!cfg?.auto_start);
    setShowLlmToken(false);
    setEditing(true);
  }

  /** 选择厂商模板时仅更新 Base URL（模型由下方下拉追加或手工填写，不自动填充） */
  function onProviderChange(id) {
    setProviderId(id);
    if (id === 'custom') return;
    const p = LLM_PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p?.baseUrl) return;
    setLlmUrl(p.baseUrl);
  }

  /** 从当前厂商推荐列表追加一个模型（去重，逗号分隔） */
  function appendSuggestedModel(m) {
    if (!m) return;
    setModelsText((prev) => {
      const parts = prev.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.includes(m)) return prev;
      return parts.length ? `${parts.join(', ')}, ${m}` : m;
    });
  }

  async function autoScan() {
    if (!window.electronAPI) return;
    setScanning(true);
    try {
      const results = await window.electronAPI.config.scan();
      const best = results[0];
      if (best?.base_url) {
        const current = (await window.electronAPI.config.read()) || {};
        const updated = {
          ...current,
          llm_base_url: best.base_url,
          llm_token:    best.token || '',
          models:       best.models || [],
        };
        await window.electronAPI.config.write(updated);
        setCfg(updated);
        setSavedMsg('已自动配置');
        setTimeout(() => setSavedMsg(''), 2000);
      } else {
        setSavedMsg('未找到配置');
        setTimeout(() => setSavedMsg(''), 2000);
      }
    } finally {
      setScanning(false);
    }
  }

  async function save() {
    if (!window.electronAPI) return;
    setSaving(true);
    try {
      const models  = modelsText.split(',').map(s => s.trim()).filter(Boolean);
      const current = (await window.electronAPI.config.read()) || {};
      const updated = { ...current, llm_base_url: llmUrl, llm_token: llmToken, models, name: nodeName, auto_start: autoStart };
      await window.electronAPI.config.write(updated);
      setCfg(updated);
      setEditing(false);
      setSavedMsg('已保存');
      setTimeout(() => setSavedMsg(''), 2000);
    } finally {
      setSaving(false);
    }
  }

  const configured = !!(cfg?.llm_base_url && cfg?.models?.length);

  // ── View mode ────────────────────────────────────────────────────────────────
  if (!editing) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${configured ? 'bg-green-400' : 'bg-yellow-400'}`} />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">贡献节点配置</span>
            {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={autoScan} disabled={scanning}
              className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 disabled:opacity-50 transition-colors">
              {scanning ? '扫描中…' : '自动配置'}
            </button>
            <button onClick={openEdit}
              className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 transition-colors">
              手动配置
            </button>
          </div>
        </div>
        {configured ? (
          <div className="mt-3 space-y-1 text-xs text-gray-500 dark:text-gray-400">
            <p><span className="text-gray-400 dark:text-gray-500 inline-block w-16">BaseURL</span>{cfg.llm_base_url}</p>
            <p><span className="text-gray-400 dark:text-gray-500 inline-block w-12">模型</span>{cfg.models.join(', ')}</p>
            {cfg.name && <p><span className="text-gray-400 dark:text-gray-500 inline-block w-12">节点</span>{cfg.name}</p>}
            <p><span className="text-gray-400 dark:text-gray-500 inline-block w-12">自启动</span>{cfg.auto_start ? '开启' : '关闭'}</p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-yellow-600 dark:text-yellow-400">未找到可用配置，请点击「手动配置」填写。</p>
        )}
      </div>
    );
  }

  // ── Edit mode ────────────────────────────────────────────────────────────────
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">贡献节点配置</span>
        {cfg?.llm_base_url && (
          <button onClick={() => setEditing(false)}
            className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
            取消
          </button>
        )}
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">厂商模板</label>
        <select
          value={providerId}
          onChange={(e) => onProviderChange(e.target.value)}
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500 mb-1.5"
        >
          {LLM_PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {presetHint && (
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mb-2">{presetHint}</p>
        )}
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Base URL（可手工修改）</label>
        <input value={llmUrl} onChange={(e) => { setLlmUrl(e.target.value); setProviderId('custom'); }}
          placeholder="http://127.0.0.1:11434/v1 或 https://api.openai.com/v1"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key（可选）</label>
        <div className="flex gap-2 items-stretch">
          <input
            value={llmToken}
            onChange={(e) => setLlmToken(e.target.value)}
            placeholder="无则留空"
            type={showLlmToken ? 'text' : 'password'}
            autoComplete="off"
            className="flex-1 min-w-0 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => setShowLlmToken((v) => !v)}
            aria-label={showLlmToken ? '隐藏 API Key' : '显示 API Key'}
            className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            {showLlmToken ? '隐藏' : '显示'}
          </button>
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">支持的模型</label>
        {suggestedModels.length > 0 ? (
          <select
            key={`${providerId}-${modelPickNonce}`}
            defaultValue=""
            aria-label="从当前厂商推荐列表追加模型"
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              appendSuggestedModel(v);
              setModelPickNonce((n) => n + 1);
            }}
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500 mb-2"
          >
            <option value="">— 从推荐列表选择（追加到下方）—</option>
            {suggestedModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">当前模板无内置推荐列表，请在下方手工填写模型 ID。</p>
        )}
        <input
          value={modelsText}
          onChange={(e) => { setModelsText(e.target.value); setProviderId('custom'); }}
          placeholder="多个模型用英文逗号分隔，例如：qwen2.5:7b, gpt-4o-mini"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">节点名称</label>
        <input value={nodeName} onChange={e => setNodeName(e.target.value)}
          placeholder="留空使用主机名"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
      </div>
      <label className="flex items-center gap-3 cursor-pointer select-none pt-1">
        <div onClick={() => setAutoStart(v => !v)}
          className={`relative w-10 h-6 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
          <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-5' : 'translate-x-1'}`} />
        </div>
        <span className="text-sm text-gray-700 dark:text-gray-300">启动应用时自动运行 Agent</span>
      </label>
      <div className="pt-1">
        <button onClick={save} disabled={saving || !llmUrl}
          className="px-5 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>
    </div>
  );
}

function ApiKeysSection({ canCreate }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState('');

  const load = useCallback(() => {
    listKeys()
      .then((r) => setKeys(r.data.keys || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (canCreate) load(); else setLoading(false); }, [canCreate, load]);

  async function handleCreate() {
    setCreating(true);
    setNewKey('');
    try {
      const r = await createKey(note.trim());
      setNewKey(r.data.key);
      setNote('');
      load();
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(k) {
    await toggleKey(k.id, !k.is_active).catch(() => {});
    load();
  }

  async function handleDelete(k) {
    if (!window.confirm(`删除 Key ${k.key?.slice(0, 12)}…？`)) return;
    await deleteKey(k.id).catch(() => {});
    load();
  }

  if (!canCreate) {
    return (
      <div className="text-sm text-gray-400 dark:text-gray-500 space-y-2">
        <p>尚未开通 API Key 权限。请先购买积分：打开左侧「个人中心」，在「购买积分」中提交申请并按管理员提供的联系方式完成线下付款，审核通过后即可在此创建 Key。</p>
        <p>
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline font-medium">前往个人中心 → 购买积分</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="备注（可选）"
          className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
        <button onClick={handleCreate} disabled={creating}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors whitespace-nowrap">
          {creating ? '创建中…' : '创建 Key'}
        </button>
      </div>

      {newKey && (
        <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-xl px-4 py-3">
          <p className="text-xs text-green-600 dark:text-green-400 mb-1">Key 已创建，请立即复制保存，之后不再显示</p>
          <p className="font-mono text-sm text-green-800 dark:text-green-300 break-all select-all">{newKey}</p>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">加载中…</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">暂无 API Key</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id}
              className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-gray-700 dark:text-gray-300 truncate">{k.key}</p>
                {k.note && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{k.note}</p>}
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${k.is_active ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}`}>
                {k.is_active ? '启用' : '禁用'}
              </span>
              <button onClick={() => handleToggle(k)}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition-colors">
                {k.is_active ? '禁用' : '启用'}
              </button>
              <button onClick={() => handleDelete(k)}
                className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors">
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label = '复制' }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button onClick={copy}
      className="shrink-0 text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
      {copied ? '已复制 ✓' : label}
    </button>
  );
}


function ModelsSection({ models }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">可用模型</h2>
      {models.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">暂无可用模型</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {models.map((m) => (
            <span key={m}
              className="inline-flex items-center gap-1.5 bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-lg px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
              {m}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function ConsumeTab({ user }) {
  const serverUrl = getServerUrl();
  const base      = serverUrl.replace(/\/+$/, '');
  const openaiUrl = base + '/v1';
  const anthropicUrl = base;

  const [style, setStyle] = useState('openai');
  const [activeSnippet, setActiveSnippet] = useState(0);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');

  // Claude Code one-click config state
  const [ccStatus, setCcStatus]       = useState(null);
  const [ccConfiguring, setCcConfiguring] = useState(false);
  const [ccMsg, setCcMsg]             = useState('');

  // Fetch available models once
  useEffect(() => {
    const jwt = localStorage.getItem('token');
    fetch(`${base}/user/keys`, { headers: { Authorization: `Bearer ${jwt}` } })
      .then((r) => r.ok ? r.json() : { keys: [] })
      .then((d) => {
        const apiKey = (d.keys || []).find((k) => k.is_active)?.key;
        return fetch(`${base}/v1/models`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
      })
      .then((r) => r.json())
      .then((d) => {
        const ids = (d.data || []).map((m) => m.id || m);
        setModels(ids);
        if (ids.length) setSelectedModel(ids[0]);
      })
      .catch(() => {});
  }, [base]);

  useEffect(() => {
    window.electronAPI?.claude.status().then((r) => setCcStatus(r.configured));
  }, []);

  async function handleClaudeConfigure() {
    setCcConfiguring(true);
    setCcMsg('');
    try {
      const keysRes = await listKeys().catch(() => ({ data: { keys: [] } }));
      const activeKey = (keysRes.data.keys || []).find((k) => k.is_active);
      if (!activeKey) { setCcMsg('请先创建并启用一个 API Key'); return; }
      await window.electronAPI.claude.configure(base, activeKey.key, models);
      setCcStatus(true);
      setCcMsg(`配置成功${models.length ? `，${models.length} 个模型` : ''}，重启 Claude Code 生效`);
      setTimeout(() => setCcMsg(''), 4000);
    } finally {
      setCcConfiguring(false);
    }
  }

  const STYLES = [
    { id: 'openai',    label: 'OpenAI 风格' },
    { id: 'anthropic', label: 'Anthropic 风格' },
    { id: 'image',     label: '图像生成' },
  ];

  const m = selectedModel || '<模型名>';

  const snippetsByStyle = {
    image: [
      {
        label: 'curl',
        code: `curl "${base}/v1/images/generations" \\\n  -H "Authorization: Bearer <你的 API Key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${m}","prompt":"a cat","n":1,"size":"1024x1024","response_format":"b64_json"}'`,
      },
      {
        label: 'Python',
        code: `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${openaiUrl}",\n    api_key="<你的 API Key>",\n)\n\nresponse = client.images.generate(\n    model="${m}",\n    prompt="a cat",\n    n=1,\n    size="1024x1024",\n    response_format="b64_json",\n)\nprint(response.data[0].b64_json[:40], "...")`,
      },
      {
        label: 'Node.js',
        code: `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: '${openaiUrl}',\n  apiKey: '<你的 API Key>',\n});\n\nconst response = await client.images.generate({\n  model: '${m}',\n  prompt: 'a cat',\n  n: 1,\n  size: '1024x1024',\n  response_format: 'b64_json',\n});\nconsole.log(response.data[0].b64_json.slice(0, 40), '...');`,
      },
    ],
    openai: [
      {
        label: '环境变量',
        code: `export OPENAI_BASE_URL="${openaiUrl}"\nexport OPENAI_API_KEY="<你的 API Key>"`,
      },
      {
        label: 'curl',
        code: `curl "${openaiUrl}/chat/completions" \\\n  -H "Authorization: Bearer <你的 API Key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${m}","messages":[{"role":"user","content":"Hello"}]}'`,
      },
      {
        label: 'Python',
        code: `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${openaiUrl}",\n    api_key="<你的 API Key>",\n)\n\nresponse = client.chat.completions.create(\n    model="${m}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`,
      },
      {
        label: 'Node.js',
        code: `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: '${openaiUrl}',\n  apiKey: '<你的 API Key>',\n});\n\nconst response = await client.chat.completions.create({\n  model: '${m}',\n  messages: [{ role: 'user', content: 'Hello' }],\n});\nconsole.log(response.choices[0].message.content);`,
      },
    ],
    anthropic: [
      {
        label: '环境变量',
        code: `export ANTHROPIC_BASE_URL="${anthropicUrl}"\nexport ANTHROPIC_AUTH_TOKEN="<你的 API Key>"`,
      },
      {
        label: 'Claude Code',
        code: `ANTHROPIC_BASE_URL="${anthropicUrl}" \\\nANTHROPIC_AUTH_TOKEN="<你的 API Key>" \\\nclaude`,
      },
      {
        label: 'curl',
        code: `curl "${anthropicUrl}/v1/messages" \\\n  -H "x-api-key: <你的 API Key>" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${m}","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'`,
      },
      {
        label: 'Python',
        code: `import anthropic\n\nclient = anthropic.Anthropic(\n    base_url="${anthropicUrl}",\n    api_key="<你的 API Key>",\n)\n\nmessage = client.messages.create(\n    model="${m}",\n    max_tokens=1024,\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(message.content[0].text)`,
      },
      {
        label: 'Node.js',
        code: `import Anthropic from '@anthropic-ai/sdk';\n\nconst client = new Anthropic({\n  baseURL: '${anthropicUrl}',\n  apiKey: '<你的 API Key>',\n});\n\nconst message = await client.messages.create({\n  model: '${m}',\n  max_tokens: 1024,\n  messages: [{ role: 'user', content: 'Hello' }],\n});\nconsole.log(message.content[0].text);`,
      },
    ],
  };

  const snippets = snippetsByStyle[style];

  function switchStyle(s) {
    setStyle(s);
    setActiveSnippet(0);
  }

  const endpointUrl = style === 'anthropic' ? anthropicUrl : base;
  const endpointDesc = style === 'openai' ? 'POST /v1/chat/completions'
    : style === 'anthropic' ? 'POST /v1/messages'
    : 'POST /v1/images/generations';

  return (
    <div className="space-y-6">
      {/* Endpoint card */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">接入配置</h2>
          <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
            {STYLES.map(({ id, label }) => (
              <button key={id} onClick={() => switchStyle(id)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  style === id
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">Base URL</p>
              <p className="font-mono text-sm text-gray-800 dark:text-gray-200 truncate">{endpointUrl}</p>
            </div>
            <CopyButton text={endpointUrl} />
          </div>
          <div className="flex items-center gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-3">
            <div>
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">Chat 端点</p>
              <p className="font-mono text-sm text-gray-700 dark:text-gray-300">{endpointDesc}</p>
            </div>
          </div>
        </div>

        {/* Usage snippets */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400 dark:text-gray-500">快速接入</p>
            {models.length > 0 && (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1 text-gray-700 dark:text-gray-300 focus:outline-none focus:border-blue-500"
              >
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
          </div>
          <div className="flex gap-1 mb-2 flex-wrap">
            {snippets.map((s, i) => (
              <button key={i} onClick={() => setActiveSnippet(i)}
                className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                  activeSnippet === i
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="relative bg-gray-900 dark:bg-gray-950 rounded-xl px-4 py-3">
            <pre className="font-mono text-xs text-gray-300 whitespace-pre-wrap leading-relaxed pr-12">
              {snippets[activeSnippet].code}
            </pre>
            <div className="absolute top-2.5 right-3">
              <CopyButton text={snippets[activeSnippet].code} />
            </div>
          </div>

          {style === 'anthropic' && snippets[activeSnippet].label === 'Claude Code' && window.electronAPI?.claude && (
            <div className="mt-2 flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                {ccStatus !== null && (
                  <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${ccStatus ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                    {ccStatus ? '已配置' : '未配置'}
                  </span>
                )}
                {ccMsg
                  ? <span className={`text-xs truncate ${ccMsg.includes('成功') ? 'text-green-600 dark:text-green-400' : 'text-yellow-600 dark:text-yellow-400'}`}>{ccMsg}</span>
                  : <span className="text-xs text-gray-400 dark:text-gray-500 truncate">写入 ~/.claude/settings.local.json</span>
                }
              </div>
              <button onClick={handleClaudeConfigure} disabled={ccConfiguring}
                className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
                {ccConfiguring ? '配置中…' : '一键配置'}
              </button>
            </div>
          )}
        </div>
      </div>

      <ModelsSection serverUrl={serverUrl} models={models} />

      {/* API Key section */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">API Key</h2>
        <ApiKeysSection canCreate={!!user?.can_create_apikey} />
      </section>
    </div>
  );
}

export default function Agent() {
  const { user } = useAuth();
  const [tab, setTab] = useState('consume');

  // ── 贡献 state ─────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [logs, setLogs] = useState([]);
  const logRef = useRef(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.agent.getStatus().then(({ running: r }) => setRunning(r));
    const disposeStatus = window.electronAPI.agent.onStatus(({ running: r, error }) => {
      setRunning(r);
      if (error) setLogs((prev) => [...prev.slice(-99), `[error] ${error}`]);
    });
    const disposeLog = window.electronAPI.agent.onLog((line) =>
      setLogs((prev) => [...prev.slice(-99), line.trimEnd()])
    );
    return () => { disposeStatus?.(); disposeLog?.(); };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    function poll() {
      getStats()
        .then((r) => {
          setStats(r.data);
          const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          setChartData((prev) => [...prev.slice(-29), { time: t, value: r.data.contribute_req_per_min ?? 0 }]);
        })
        .catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getSettlements()
      .then((r) => setSettlements((r.data.settlements || []).slice(0, 10)))
      .catch(() => {});
  }, []);

  const handleStart = () => window.electronAPI?.agent.start();
  const handleStop = () => window.electronAPI?.agent.stop();

  const TABS = [{ id: 'consume', label: '消费' }, { id: 'contribute', label: '贡献' }];

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Agent</h1>

      {/* Tab bar */}
      <div className="flex rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 w-fit">
        {TABS.map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-6 py-2 text-sm font-medium transition-colors ${
              tab === id
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 消费 Tab ─────────────────────────────────────────────────────────── */}
      {tab === 'consume' && <ConsumeTab user={user} />}

      {/* ── 贡献 Tab ─────────────────────────────────────────────────────────── */}
      {tab === 'contribute' && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${running ? 'bg-green-400 animate-pulse' : 'bg-gray-400 dark:bg-gray-600'}`} />
              <span className="text-lg font-medium text-gray-700 dark:text-gray-200">{running ? '运行中' : '已停止'}</span>
            </div>
            <div className="flex gap-3">
              <button onClick={handleStart} disabled={running}
                className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
                启动
              </button>
              <button onClick={handleStop} disabled={!running}
                className="px-5 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
                停止
              </button>
            </div>
          </div>

          <LLMConfigCard />

          {stats && (
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">贡献速率</p>
                <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.contribute_req_per_min ?? 0}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">req/min</p>
              </div>
              <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">活跃请求</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_requests ?? 0}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">在线节点</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_workers ?? 0}</p>
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-4">
            <p className="text-sm text-gray-400 dark:text-gray-400 mb-2">贡献请求速率 (req/min)</p>
            <RateChart data={chartData} />
          </div>

          <section>
            <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">最近结算</h2>
            {settlements.length === 0 ? (
              <p className="text-gray-400 dark:text-gray-500 text-sm">暂无结算记录</p>
            ) : (
              <div className="space-y-2">
                {settlements.map((s) => (
                  <div key={s.id ?? s.period_end}
                    className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 grid grid-cols-5 gap-2 text-sm items-center">
                    <span className="text-gray-400 dark:text-gray-400 text-xs">{s.period_end?.slice(0, 16)}</span>
                    <span className="text-gray-700 dark:text-gray-300">{(s.output_tokens ?? 0).toLocaleString()} tok</span>
                    <span className="text-yellow-500 dark:text-yellow-400 text-xs">{multiplierToStars(s.multiplier ?? 1)}</span>
                    <span className="text-gray-700 dark:text-gray-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                    <span className="text-green-600 dark:text-green-400 font-medium">+{(s.credits_awarded ?? 0).toFixed(1)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">Agent 日志</h2>
            <div ref={logRef}
              className="bg-gray-100 dark:bg-gray-900 rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
              {logs.length === 0
                ? <span className="text-gray-400 dark:text-gray-600">（日志为空）</span>
                : logs.map((line, i) => <div key={i}>{line}</div>)
              }
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
