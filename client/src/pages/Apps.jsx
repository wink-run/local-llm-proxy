/**
 * Apps —— 板块① Path B 一键写入器 UI（M2）
 *
 * 设计文档：DESIGN_v2.md §1.4 Path B
 *
 * 列出 8 个支持的工具，每张卡有：
 *   - 状态（配置文件已存在？已绑定？）
 *   - 预览 diff（写入前看会改什么）
 *   - 写入（atomic + backup + backfill）
 *   - 显示备份文件位置，便于回滚
 */
import React, { useEffect, useMemo, useState } from 'react';

const LOCAL_GATEWAY_URL =
  typeof window !== 'undefined' && window.localStorage?.getItem('llp.gatewayUrl')
    ? window.localStorage.getItem('llp.gatewayUrl')
    : 'http://127.0.0.1:11435';

async function gatewayFetch(path, opts = {}) {
  const res = await fetch(LOCAL_GATEWAY_URL + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// ── 子组件：单个 App 卡片 ──────────────────────────────────────────────

function AppCard({ schema, models, policies, gatewayUrl, gatewayKeyMasked, onChanged }) {
  const [selectedModel, setSelectedModel] = useState(models[0] || '');
  const [selectedPolicy, setSelectedPolicy] = useState(schema.binding?.routing_policy_id || '');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [writeLoading, setWriteLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { if (!selectedModel && models[0]) setSelectedModel(models[0]); }, [models]);
  useEffect(() => { setSelectedPolicy(schema.binding?.routing_policy_id || ''); }, [schema.binding?.routing_policy_id]);

  const persistPolicy = async (pid) => {
    setSelectedPolicy(pid);
    if (!schema.bound) return;  // 未写入前先不存策略
    await gatewayFetch(`/__local__/apps/${schema.app_name}/policy`, {
      method: 'POST',
      body: JSON.stringify({ policy_id: pid ? parseInt(pid, 10) : null }),
    });
    onChanged?.();
  };

  const doPreview = async () => {
    setPreviewLoading(true);
    setResult(null);
    const q = selectedModel ? `?preferred_model=${encodeURIComponent(selectedModel)}` : '';
    const { body } = await gatewayFetch(`/__local__/apps/${schema.app_name}/preview${q}`);
    setPreview(body);
    setPreviewLoading(false);
  };

  const doWrite = async () => {
    if (!confirm(
      `即将写入：${schema.path}\n\n` +
      `这会修改你的真实配置文件。写入前会自动备份到 ~/.local-llm-proxy/backups/。\n\n确认？`
    )) return;
    setWriteLoading(true);
    setResult(null);
    const { body } = await gatewayFetch(`/__local__/apps/${schema.app_name}/write`, {
      method: 'POST',
      body: JSON.stringify({ preferred_model: selectedModel || null }),
    });
    setResult(body);
    setWriteLoading(false);
    setPreview(null);
    onChanged?.();
  };

  const doRemove = async () => {
    if (!confirm(`移除 ${schema.display} 的 binding 记录？\n\n注意：这只清除数据库记录，工具配置文件不会自动回滚。如需恢复，去 ~/.local-llm-proxy/backups/ 找最近备份手动还原。`)) return;
    await gatewayFetch(`/__local__/apps/${schema.app_name}/binding`, { method: 'DELETE' });
    onChanged?.();
  };

  const fmtBadge = {
    json: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    yaml: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
    toml: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  }[schema.fmt] || 'bg-gray-100 dark:bg-gray-800 text-gray-600';

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm">{schema.display}</h3>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${fmtBadge}`}>{schema.fmt}</span>
            {schema.bound && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">
                已写入
              </span>
            )}
            {!schema.exists && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300">
                配置不存在（将创建）
              </span>
            )}
            {schema.needs_env_var && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300">
                需 env var
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate font-mono">
            {schema.path}
          </p>
          {schema.binding && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
              上次写入：{schema.binding.last_written_at}
              {schema.binding.last_error && (
                <span className="text-red-500 ml-2">⚠ {schema.binding.last_error}</span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* 模型选择 + 策略 + 操作 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-gray-500">模型：</label>
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-xs"
        >
          <option value="">（不指定）</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label className="text-xs text-gray-500 ml-2">策略：</label>
        <select
          value={selectedPolicy}
          onChange={(e) => persistPolicy(e.target.value)}
          className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-xs"
        >
          <option value="">（默认）</option>
          {(policies || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="flex-1" />
        <button
          onClick={doPreview}
          disabled={previewLoading}
          className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
        >
          {previewLoading ? '生成中…' : '预览 diff'}
        </button>
        <button
          onClick={doWrite}
          disabled={writeLoading}
          className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {writeLoading ? '写入中…' : schema.bound ? '重新写入' : '写入配置'}
        </button>
        {schema.bound && (
          <button
            onClick={doRemove}
            className="text-xs px-2 py-1 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
          >
            移除记录
          </button>
        )}
      </div>

      {/* Preview block */}
      {preview && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          <div className="text-xs text-gray-500 mb-1">
            将改变的顶层 key：
            {(preview.diff_keys || []).map((k) => (
              <code key={k} className="ml-1 px-1 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30">{k}</code>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-[10px] text-gray-400 mb-1">BEFORE</p>
              <pre className="bg-gray-50 dark:bg-gray-950 border border-gray-100 dark:border-gray-800 rounded p-2 text-[10px] overflow-x-auto max-h-48">
                {JSON.stringify(preview.before, null, 2)}
              </pre>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 mb-1">AFTER</p>
              <pre className="bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900 rounded p-2 text-[10px] overflow-x-auto max-h-48">
                {JSON.stringify(preview.after, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Write result */}
      {result && (
        <div
          className={`mt-3 text-xs rounded px-3 py-2 ${
            result.ok
              ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
          }`}
        >
          {result.ok ? (
            <>
              <div>✓ 已写入：<code>{result.path}</code></div>
              {result.backup_path && <div className="mt-1">↻ 备份：<code>{result.backup_path}</code></div>}
              {result.needs_env_var && (
                <div className="mt-2 p-2 bg-orange-50 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300 rounded">
                  ⚠ 还需要在 shell 中执行：
                  <pre className="mt-1 bg-gray-900 text-gray-100 p-2 rounded text-[10px] overflow-x-auto">{result.env_var_hint}</pre>
                </div>
              )}
            </>
          ) : (
            <>✗ 失败：{result.error}</>
          )}
        </div>
      )}
    </div>
  );
}

// ── 主页面 ─────────────────────────────────────────────────────────────

export default function Apps() {
  const [health, setHealth] = useState(null);
  const [apps, setApps] = useState([]);
  const [providerModels, setProviderModels] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [gatewayKey, setGatewayKey] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const h = await gatewayFetch('/__local__/health');
      if (!h.ok) { setHealth(false); return; }
      setHealth(h.body);
      const [a, p, pol] = await Promise.all([
        gatewayFetch('/__local__/apps'),
        gatewayFetch('/__local__/providers'),
        gatewayFetch('/__local__/policies'),
      ]);
      if (a.ok) setApps(a.body.apps || []);
      if (p.ok) {
        const allModels = new Set();
        (p.body.providers || []).forEach((pr) => (pr.models || []).forEach((m) => allModels.add(m)));
        setProviderModels(Array.from(allModels));
      }
      if (pol.ok) setPolicies(pol.body.policies || []);
    })();
  }, [refreshKey]);

  const revealKey = async () => {
    const { ok, body } = await gatewayFetch('/__local__/gateway-key');
    if (ok) {
      setGatewayKey(body.gateway_key);
      setShowKey(true);
    }
  };

  const rotateKey = async () => {
    if (!confirm(
      '轮换 gateway key 后，所有已写入的工具配置都需要重新写入。继续？',
    )) return;
    const { body } = await gatewayFetch('/__local__/gateway-key/rotate', { method: 'POST' });
    setGatewayKey(body.gateway_key);
    setShowKey(true);
    setRefreshKey((k) => k + 1);
  };

  if (health === false) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold mb-3">本地网关未启动</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          一键写入需要本地网关运行在 <code>{LOCAL_GATEWAY_URL}</code>。先去 Onboarding 页或自行启动 uvicorn。
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">一键写入应用配置</h1>
        <p className="text-xs text-gray-500 mt-1">
          板块① Path B：把本地网关地址 + Gateway Key 写入到下列工具的配置文件。
          原配置会自动备份到 <code>~/.local-llm-proxy/backups/</code>，可随时回滚。
        </p>
      </header>

      {/* Gateway key 顶部条 */}
      <div className="mb-6 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-xs text-gray-500">Gateway URL</p>
            <p className="text-sm font-mono">{health?.gateway_url}/v1</p>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-gray-500">Gateway API Key</p>
            <p className="text-sm font-mono break-all">
              {showKey && gatewayKey ? gatewayKey : (health?.gateway_key_masked || '—')}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={revealKey}
              className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {showKey ? '已显示' : '显示完整 key'}
            </button>
            <button
              onClick={() => navigator.clipboard?.writeText(gatewayKey || '')}
              disabled={!gatewayKey}
              className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              复制
            </button>
            <button
              onClick={rotateKey}
              className="text-xs px-2 py-1 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
            >
              轮换
            </button>
          </div>
        </div>
      </div>

      {providerModels.length === 0 && (
        <div className="mb-6 text-sm bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-900 text-yellow-800 dark:text-yellow-300 rounded p-3">
          还没接入任何 Provider，「默认模型」下拉是空的。先去 🔌 接入 页添加至少一个，再回来写入。
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {apps.map((schema) => (
          <AppCard
            key={schema.app_name}
            schema={schema}
            models={providerModels}
            policies={policies}
            gatewayUrl={health?.gateway_url}
            gatewayKeyMasked={health?.gateway_key_masked}
            onChanged={() => setRefreshKey((k) => k + 1)}
          />
        ))}
      </div>
    </div>
  );
}
