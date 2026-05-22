/**
 * Onboarding —— 板块② 三层 Provider 接入
 *
 * 设计文档：DESIGN_v2.md §2
 *
 * Layer 1 免费 (P0)：Groq / Cerebras / Gemini AI Studio / OpenRouter free / Ollama
 * Layer 2 订阅/付费 (Phase B)：OpenAI / Anthropic / DeepSeek / 智谱 / Moonshot ...
 *         + 「从 cc-switch 一次性导入」入口
 * Layer 3 用户分享池 (Phase B 占位 → P2 真正接入)
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

// ── 极简 markdown 渲染 ─────────────────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listBuf = [];
  let tableBuf = [];

  const flushList = () => {
    if (listBuf.length) {
      out.push(
        <ul key={`ul-${out.length}`} className="list-disc pl-6 my-2 space-y-1 text-sm">
          {listBuf.map((it, i) => <li key={i} dangerouslySetInnerHTML={{ __html: it }} />)}
        </ul>,
      );
      listBuf = [];
    }
  };

  const flushTable = () => {
    if (tableBuf.length >= 2) {
      const head = tableBuf[0].split('|').map((c) => c.trim()).filter(Boolean);
      const rows = tableBuf.slice(2).map((r) => r.split('|').map((c) => c.trim()).filter(Boolean));
      out.push(
        <table key={`tbl-${out.length}`} className="text-xs border border-gray-200 dark:border-gray-700 my-3 w-full">
          <thead className="bg-gray-100 dark:bg-gray-800">
            <tr>{head.map((h, i) => <th key={i} className="px-2 py-1 text-left">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                {row.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>,
      );
    }
    tableBuf = [];
  };

  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a class="text-blue-600 dark:text-blue-400 underline" target="_blank" rel="noreferrer" href="$2">$1</a>',
      );

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(
          <pre key={`code-${out.length}`} className="bg-gray-100 dark:bg-gray-800 rounded p-2 my-2 text-xs overflow-x-auto">
            <code>{codeBuf.join('\n')}</code>
          </pre>,
        );
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        flushTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (line.startsWith('|')) {
      flushList();
      tableBuf.push(line);
      continue;
    } else if (tableBuf.length) {
      flushTable();
    }
    if (/^[-*] /.test(line)) { listBuf.push(inline(line.slice(2))); continue; }
    else { flushList(); }
    if (line.startsWith('### ')) out.push(<h4 key={out.length} className="font-semibold mt-3 mb-1 text-sm">{line.slice(4)}</h4>);
    else if (line.startsWith('## ')) out.push(<h3 key={out.length} className="font-semibold mt-4 mb-2 text-base">{line.slice(3)}</h3>);
    else if (line.startsWith('# ')) out.push(<h2 key={out.length} className="font-bold mt-4 mb-2 text-lg">{line.slice(2)}</h2>);
    else if (line) out.push(<p key={out.length} className="my-1.5 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: inline(line) }} />);
  }
  flushList();
  flushTable();
  return out;
}

// ── ProviderCard 通用 ──────────────────────────────────────────────────

function ProviderCard({ entry, installed, onRefresh, layer }) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [installing, setInstalling] = useState(false);

  const isPublic = (entry.auth?.type || 'bearer') === 'none';
  const requiresP1 = entry.requires_p1;
  const installed1 = installed.find((p) => p.provider_id === entry.id);

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    const { body } = await gatewayFetch('/__local__/test-connection', {
      method: 'POST',
      body: JSON.stringify({ provider_id: entry.id, api_key: apiKey }),
    });
    setTestResult(body);
    setTesting(false);
  };

  const handleAdd = async () => {
    setInstalling(true);
    const { ok, body } = await gatewayFetch('/__local__/providers/from-catalog', {
      method: 'POST',
      body: JSON.stringify({ provider_id: entry.id, api_key: apiKey }),
    });
    setInstalling(false);
    if (ok) {
      setApiKey('');
      setTestResult(null);
      setOpen(false);
      onRefresh?.();
    } else {
      setTestResult({ ok: false, error: body?.detail || JSON.stringify(body) });
    }
  };

  const handleRemove = async () => {
    if (!installed1) return;
    if (!confirm(`移除 ${entry.display}？已存储的 API key 将一并删除。`)) return;
    const { ok } = await gatewayFetch(`/__local__/providers/${installed1.id}`, { method: 'DELETE' });
    if (ok) onRefresh?.();
  };

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm truncate">{entry.display}</h3>
            {installed1 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">已接入</span>}
            {isPublic && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">免 key</span>}
            {entry.affiliate && <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300">优惠</span>}
            {entry.imported_from === 'cc-switch' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">来自 cc-switch</span>}
            {requiresP1 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300">需 P1 订阅层</span>}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{entry.quota_hint}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">{entry.base_url || '— (P1 转换后填充)'}</p>
        </div>
        <div className="shrink-0 flex gap-1.5">
          {installed1 && (
            <button onClick={handleRemove} className="text-xs px-2 py-1 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">移除</button>
          )}
          <button
            onClick={() => setOpen((o) => !o)}
            disabled={requiresP1}
            className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {open ? '收起' : installed1 ? '查看引导' : (requiresP1 ? '需 P1' : '接入')}
          </button>
        </div>
      </div>

      {open && !requiresP1 && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          {entry.guide_text && <div className="text-gray-700 dark:text-gray-300">{renderMarkdown(entry.guide_text)}</div>}
          {!entry.guide_text && entry.notes && <p className="text-sm text-gray-600">{entry.notes}</p>}

          <div className="mt-4 flex flex-col gap-2">
            {entry.signup_url && (
              <a href={entry.signup_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 dark:text-blue-400 underline self-start">
                ↗ 打开 {entry.signup_url}
              </a>
            )}
            {!isPublic && (
              <input
                type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder="粘贴 API Key..."
                className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            )}
            <div className="flex gap-2">
              <button onClick={handleTest} disabled={testing || (!isPublic && !apiKey)} className="text-sm px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button onClick={handleAdd} disabled={installing || (!isPublic && !apiKey) || installed1} className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                {installing ? '添加中…' : installed1 ? '已添加' : '添加到 Pool'}
              </button>
            </div>
            {testResult && (
              <div className={`text-xs rounded px-3 py-2 ${testResult.ok ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300' : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'}`}>
                {testResult.ok ? <>✓ 连接成功 · {testResult.via} · {testResult.latency_ms}ms</> : <>✗ {testResult.status ? `HTTP ${testResult.status} · ` : ''}{testResult.error}</>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 主页面 ─────────────────────────────────────────────────────────────

const TABS = [
  { id: 'free', label: 'Layer 1 · 免费', icon: '🎁' },
  { id: 'paid', label: 'Layer 2 · 订阅/付费', icon: '💳' },
  { id: 'shared', label: 'Layer 3 · 分享池', icon: '🤝' },
];

export default function Onboarding() {
  const [health, setHealth] = useState(null);
  const [tab, setTab] = useState('free');
  const [freeCatalog, setFreeCatalog] = useState([]);
  const [paidCatalog, setPaidCatalog] = useState([]);
  const [sharePool, setSharePool] = useState(null);
  const [installed, setInstalled] = useState([]);
  const [strategy, setStrategy] = useState('cost');
  const [ccsw, setCcsw] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const h = await gatewayFetch('/__local__/health');
      if (!h.ok) { setHealth(false); return; }
      setHealth(h.body);
      setStrategy(h.body.strategy);

      const [f, p, s, c, i] = await Promise.all([
        gatewayFetch('/__local__/free-catalog'),
        gatewayFetch('/__local__/paid-catalog'),
        gatewayFetch('/__local__/share-pool'),
        gatewayFetch('/__local__/ccswitch/available'),
        gatewayFetch('/__local__/providers'),
      ]);
      if (f.ok) setFreeCatalog(f.body.providers || []);
      if (p.ok) setPaidCatalog(p.body.providers || []);
      if (s.ok) setSharePool(s.body);
      if (c.ok) setCcsw(c.body);
      if (i.ok) setInstalled(i.body.providers || []);
    })();
  }, [refreshKey]);

  const setStrategyAndPersist = async (s) => {
    setStrategy(s);
    await gatewayFetch('/__local__/strategy', { method: 'POST', body: JSON.stringify({ strategy: s }) });
  };

  const doCcswitchImport = async () => {
    if (!confirm('一次性把 cc-switch 中的 provider 条目（不含 key）导入到本地。\n之后两边各自维护、不实时同步。')) return;
    const { ok, body } = await gatewayFetch('/__local__/ccswitch/import', { method: 'POST' });
    if (ok) alert(`已导入 ${body.imported} 个 provider 条目`);
    setRefreshKey((k) => k + 1);
  };

  if (health === false) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold mb-3">本地网关未启动</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Onboarding 需要本地网关运行在 <code>{LOCAL_GATEWAY_URL}</code>。Electron 现已自动托管 —— 若仍未启动，请检查 Python 是否在 PATH 上。
        </p>
        <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded p-4">
          <p className="text-xs text-gray-500 mb-2">或在 server/ 目录手动启动：</p>
          <pre className="bg-gray-900 text-gray-100 rounded p-3 text-xs overflow-x-auto">
            <code>{`cd server\npython -m uvicorn local_gateway:app --host 127.0.0.1 --port 11435`}</code>
          </pre>
        </div>
        <button onClick={() => setRefreshKey((k) => k + 1)} className="mt-4 text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700">
          重试连接
        </button>
      </div>
    );
  }

  const STRATEGIES = [
    { value: 'cost', icon: '⚡', label: '省钱优先' },
    { value: 'quality', icon: '⭐', label: '质量优先' },
    { value: 'custom', icon: '⚙️', label: '自定义' },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Provider 接入</h1>
        <p className="text-xs text-gray-500 mt-1">板块② 三层 Provider 接入。添加后可在 Claude Code / Cursor 等通过本地网关使用。</p>
      </header>

      {/* 顶部状态条 */}
      <div className="flex items-center justify-between gap-4 mb-4 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">路由策略：</span>
          <div className="flex rounded overflow-hidden border border-gray-200 dark:border-gray-700">
            {STRATEGIES.map((s) => (
              <button key={s.value} onClick={() => setStrategyAndPersist(s.value)} className={`px-3 py-1 text-xs font-medium ${strategy === s.value ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                {s.icon} {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="text-xs text-gray-500">
          已接入：<span className="text-gray-900 dark:text-gray-100 font-medium">{installed.length}</span> ·
          Keystore：<span className="text-gray-700 dark:text-gray-300">{health?.keystore_backend}</span>
        </div>
      </div>

      {/* 标签栏 */}
      <div className="mb-4 flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Layer 1 */}
      {tab === 'free' && (
        <>
          {installed.length === 0 && (
            <div className="mb-4 text-sm bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-900 text-yellow-800 dark:text-yellow-300 rounded p-3">
              还没接入任何 Provider。最快上手——本地 Ollama（无需 key）或 Groq（注册 1 分钟）。
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {freeCatalog.map((entry) => (
              <ProviderCard key={entry.id} entry={entry} installed={installed} onRefresh={() => setRefreshKey((k) => k + 1)} layer="free" />
            ))}
          </div>
        </>
      )}

      {/* Layer 2 */}
      {tab === 'paid' && (
        <>
          <div className="mb-4 flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 text-blue-800 dark:text-blue-300 rounded p-3">
            <div className="text-sm">
              <strong>从 cc-switch 一次性导入</strong>
              <span className="block text-xs mt-0.5 opacity-80">
                {ccsw?.available ? `检测到 cc-switch (${ccsw.db_path})。点击合并 provider 条目到本地（不导入 key）。` : 'cc-switch 未安装在本机；如需使用先安装它。'}
              </span>
            </div>
            <button onClick={doCcswitchImport} disabled={!ccsw?.available} className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
              导入
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {paidCatalog.map((entry) => (
              <ProviderCard key={entry.id} entry={entry} installed={installed} onRefresh={() => setRefreshKey((k) => k + 1)} layer="paid" />
            ))}
          </div>
        </>
      )}

      {/* Layer 3 */}
      {tab === 'shared' && (
        <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-6 bg-white dark:bg-gray-900">
          <h3 className="font-semibold mb-2">分享池</h3>
          {sharePool?.available ? (
            <div className="text-sm text-gray-600">{sharePool.providers.length} 个可用条目</div>
          ) : (
            <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
              <p>{sharePool?.notice || '当前不可用'}</p>
              <p className="mt-3 text-xs text-gray-500">
                分享池整合在板块③ 之后才会真正启用（P2 阶段）。届时这里会列出在线 worker 提供的「匿名 model × 健康度 × 5min 均价（积分）」，用户可订阅挂到本地 Pool。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
