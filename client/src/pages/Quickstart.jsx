/**
 * Quickstart —— 60 秒上手 wizard。
 *
 * 设计文档：DESIGN_v2.md §8.3
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const LOCAL_GATEWAY_URL =
  typeof window !== 'undefined' && window.localStorage?.getItem('llp.gatewayUrl')
    ? window.localStorage.getItem('llp.gatewayUrl')
    : 'http://127.0.0.1:11435';

async function api(path, opts = {}) {
  const res = await fetch(LOCAL_GATEWAY_URL + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

export default function Quickstart() {
  const navigate = useNavigate();
  const [detect, setDetect] = useState(null);
  const [chosenProvider, setChosenProvider] = useState('ollama');
  const [apiKey, setApiKey] = useState('');
  const [chosenApps, setChosenApps] = useState([]);
  const [policy, setPolicy] = useState('cost-first');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      const { ok, body } = await api('/__local__/quickstart/detect');
      if (!ok) { setDetect(false); return; }
      setDetect(body);
      // 默认选 ollama（如果在线）否则 groq
      setChosenProvider(body.ollama.alive ? 'ollama' : 'groq');
      // 默认勾选已检测到配置的工具（claude_code 通常存在）
      setChosenApps(body.apps.filter((a) => a.config_exists).map((a) => a.app_name));
    })();
  }, []);

  const handleRun = async () => {
    if (!chosenProvider) return;
    setRunning(true);
    const { body } = await api('/__local__/quickstart/run', {
      method: 'POST',
      body: JSON.stringify({
        free_provider_id: chosenProvider,
        api_key: apiKey,
        app_names: chosenApps,
        policy_name: policy,
      }),
    });
    setRunning(false);
    setResult(body);
    if (body?.ok) {
      // 2 秒后跳转到 Dashboard
      setTimeout(() => navigate('/dashboard'), 2000);
    }
  };

  if (detect === false) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold mb-3">本地网关未启动</h1>
        <p className="text-sm text-gray-600">Quickstart 需要网关运行在 {LOCAL_GATEWAY_URL}。</p>
      </div>
    );
  }
  if (detect === null) return <div className="p-8 text-sm text-gray-500">探测中…</div>;

  const PROVIDERS = [
    { id: 'ollama',           label: '本地 Ollama',     hint: detect.ollama.alive ? `在线 (${detect.ollama.models.length} 个模型)` : '本机未检测到 Ollama', disabled: !detect.ollama.alive, needsKey: false },
    { id: 'groq',             label: 'Groq Cloud',      hint: '注册免费 1 分钟，速度最快',          disabled: false, needsKey: true },
    { id: 'gemini-ai-studio', label: 'Google AI Studio', hint: '免费 RPM 15 / TPM 1M / 1500 RPD',  disabled: false, needsKey: true },
    { id: 'cerebras',         label: 'Cerebras Cloud',  hint: '免费每日 1M tokens',                disabled: false, needsKey: true },
    { id: 'openrouter-free',  label: 'OpenRouter 免费',  hint: '免费 RPD 50',                       disabled: false, needsKey: true },
  ];

  const POLICIES = [
    { name: 'cost-first',     label: '⚡ 省钱优先', desc: 'Tier 1 → Tier 3 → Tier 2' },
    { name: 'quality-first',  label: '⭐ 质量优先', desc: 'Tier 2 → Tier 1 → Tier 3' },
    { name: 'free-only',      label: '🎁 仅免费',   desc: '只用 Tier 1，不动付费' },
  ];

  const chosen = PROVIDERS.find((p) => p.id === chosenProvider);
  const canRun = chosen && (!chosen.needsKey || apiKey) && chosenApps.length > 0 && !running;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <header className="mb-6 text-center">
        <h1 className="text-2xl font-bold">60 秒上手 Token Bank</h1>
        <p className="text-sm text-gray-500 mt-1">三步走，自动检测，一键完成</p>
      </header>

      {/* STEP 1 */}
      <section className="mb-6 border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-5">
        <h3 className="font-semibold mb-3"><span className="text-blue-600 dark:text-blue-400">STEP 1</span> · 选一个免费 token 来源</h3>
        <div className="space-y-2">
          {PROVIDERS.map((p) => (
            <label key={p.id} className={`flex items-center gap-3 p-3 rounded border ${chosenProvider === p.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700'} ${p.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
              <input type="radio" name="provider" value={p.id} checked={chosenProvider === p.id} disabled={p.disabled} onChange={(e) => setChosenProvider(e.target.value)} />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm">{p.label}</p>
                <p className="text-xs text-gray-500">{p.hint}</p>
              </div>
              {p.id === 'ollama' && detect.ollama.alive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">已就绪</span>}
            </label>
          ))}
        </div>
        {chosen?.needsKey && (
          <div className="mt-3">
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-1.5">
              粘贴 {chosen.label} 的 API key（注册地址会在引导页给出）：
            </p>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                   placeholder="粘贴 API Key..."
                   className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
            <button onClick={() => window.open(
              chosenProvider === 'groq' ? 'https://console.groq.com/keys'
              : chosenProvider === 'gemini-ai-studio' ? 'https://aistudio.google.com/apikey'
              : chosenProvider === 'cerebras' ? 'https://cloud.cerebras.ai/platform/'
              : 'https://openrouter.ai/settings/keys', '_blank')}
              className="mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">
              ↗ 打开注册页
            </button>
          </div>
        )}
      </section>

      {/* STEP 2 */}
      <section className="mb-6 border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-5">
        <h3 className="font-semibold mb-3"><span className="text-blue-600 dark:text-blue-400">STEP 2</span> · 选要接入的工具</h3>
        <div className="space-y-1.5">
          {detect.apps.map((a) => (
            <label key={a.app_name} className={`flex items-center gap-3 p-2.5 rounded border ${chosenApps.includes(a.app_name) ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700'} cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800`}>
              <input type="checkbox" checked={chosenApps.includes(a.app_name)} onChange={(e) => {
                if (e.target.checked) setChosenApps([...chosenApps, a.app_name]);
                else setChosenApps(chosenApps.filter((x) => x !== a.app_name));
              }} />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm">{a.display}</p>
                <p className="text-xs text-gray-500 truncate font-mono">{a.path}</p>
              </div>
              {a.config_exists && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">已存在</span>}
            </label>
          ))}
        </div>
      </section>

      {/* STEP 3 */}
      <section className="mb-6 border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-5">
        <h3 className="font-semibold mb-3"><span className="text-blue-600 dark:text-blue-400">STEP 3</span> · 选默认路由策略</h3>
        <div className="grid grid-cols-3 gap-2">
          {POLICIES.map((p) => (
            <button key={p.name}
                    onClick={() => setPolicy(p.name)}
                    className={`p-3 rounded border text-left ${policy === p.name ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
              <p className="text-sm font-medium">{p.label}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{p.desc}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Run */}
      {result ? (
        <div className={`p-4 rounded-lg ${result.ok ? 'bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-300 border border-green-200' : 'bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-300 border border-red-200'}`}>
          {result.ok ? (
            <>
              <p className="font-semibold">✓ Quickstart 完成！</p>
              <p className="text-xs mt-1">Provider: {result.provider_id} · Policy: {policy} · 已写入 {result.written.length} 个工具配置</p>
              <p className="text-xs mt-2">2 秒后跳转到 Dashboard…</p>
            </>
          ) : (
            <>
              <p className="font-semibold">✗ 部分失败</p>
              <pre className="text-xs mt-2 whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre>
            </>
          )}
        </div>
      ) : (
        <button onClick={handleRun} disabled={!canRun}
                className="w-full text-base font-medium py-3 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">
          {running ? '运行中…' : '⚡ 一键完成'}
        </button>
      )}

      <p className="text-xs text-gray-400 text-center mt-4">
        每个工具的真实配置文件在写入前会自动备份到 ~/.local-llm-proxy/backups/
      </p>
    </div>
  );
}
