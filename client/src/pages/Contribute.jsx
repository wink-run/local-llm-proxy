/**
 * Contribute —— 板块③ 贡献面板（Phase C）
 *
 * 设计文档：DESIGN_v2.md §3
 *
 * 三类 source_kind：
 *   1. 本地算力（local）—— 主 UI 默认开放，Ollama / vLLM 等
 *   2. 私有网关（gateway）—— 主 UI 默认开放，公司内 OneAPI / 自建 Azure 等
 *   3. 富余订阅 key（subscription）—— 高级模式开关后才可见，三重 ack
 */
import React, { useEffect, useState } from 'react';

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

// ── AddSourceModal ─────────────────────────────────────────────────────

function AddSourceModal({ defaultKind, advancedMode, onAdded, onClose }) {
  const [kind, setKind] = useState(defaultKind);
  const [display, setDisplay] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const [quotaUnit, setQuotaUnit] = useState('');
  const [quotaTotal, setQuotaTotal] = useState(0);
  const [schedule, setSchedule] = useState('24/7');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setSaving(true); setError(null);
    const { ok, body } = await api('/__local__/contribute/sources', {
      method: 'POST',
      body: JSON.stringify({
        source_kind: kind, display_name: display, base_url: baseUrl,
        models: models.split(',').map((s) => s.trim()).filter(Boolean),
        quota_unit: quotaUnit, quota_total: parseFloat(quotaTotal) || 0,
        schedule, notes,
      }),
    });
    setSaving(false);
    if (!ok) {
      setError(body?.detail || JSON.stringify(body));
      return;
    }
    onAdded?.();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-lg p-6 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">新增贡献源</h2>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">类型</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm">
              <option value="local">本地算力（local）</option>
              <option value="gateway">私有网关（gateway）</option>
              {advancedMode && <option value="subscription">⚠ 富余订阅 key（subscription）</option>}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">显示名</label>
            <input value={display} onChange={(e) => setDisplay(e.target.value)} placeholder={kind === 'local' ? 'Ollama qwen3-32b' : kind === 'gateway' ? '公司 OneAPI' : 'My Claude Pro'} className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
          </div>
          {kind !== 'local' && (
            <div>
              <label className="text-xs text-gray-500">Base URL</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://intranet:8080/v1" className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
            </div>
          )}
          <div>
            <label className="text-xs text-gray-500">模型（逗号分隔）</label>
            <input value={models} onChange={(e) => setModels(e.target.value)} placeholder="qwen3-32b, llama3-70b" className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500">额度单位</label>
              <select value={quotaUnit} onChange={(e) => setQuotaUnit(e.target.value)} className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm">
                <option value="">— 无</option>
                <option value="usd">USD</option>
                <option value="tokens">Tokens</option>
                <option value="rpm">RPM</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500">额度总量</label>
              <input type="number" value={quotaTotal} onChange={(e) => setQuotaTotal(e.target.value)} className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500">时间表 / 备注</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="24/7  或  仅工作时间 09-18" className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
          </div>
        </div>
        {error && <div className="mt-3 text-xs bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded px-3 py-2">✗ {error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700">取消</button>
          <button onClick={submit} disabled={saving || !display} className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white disabled:opacity-50">{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}

// ── AckModal ───────────────────────────────────────────────────────────

function AckModal({ onConfirm, onClose }) {
  const [ackText, setAckText] = useState('');
  const [acked, setAcked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const { body } = await api('/__local__/contribute/advanced-mode/text');
      setAckText(body?.text || '');
    })();
  }, []);

  const submit = async () => {
    if (!acked) return;
    setSubmitting(true);
    await api('/__local__/contribute/advanced-mode/enable', {
      method: 'POST',
      body: JSON.stringify({ ack: true, user_hint: navigator.userAgent.slice(0, 80) }),
    });
    setSubmitting(false);
    onConfirm?.();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-lg p-6 max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-3 text-red-600 dark:text-red-400">⚠ 启用高级模式 / 高风险贡献源</h2>
        <pre className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-900 text-yellow-900 dark:text-yellow-200 rounded p-4 text-xs whitespace-pre-wrap font-sans max-h-96 overflow-y-auto">{ackText}</pre>
        <label className="mt-4 flex items-start gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} className="mt-0.5" />
          <span>我已阅读并理解以上 <strong>4 条具体风险</strong>，并自愿承担相应后果。</span>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700">取消</button>
          <button onClick={submit} disabled={!acked || submitting} className="text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
            {submitting ? '处理中…' : '确认启用'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 主页面 ─────────────────────────────────────────────────────────────

export default function Contribute() {
  const [advancedMode, setAdvancedMode] = useState(false);
  const [sources, setSources] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addKind, setAddKind] = useState('local');
  const [showAckModal, setShowAckModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const { ok, body } = await api('/__local__/contribute/sources');
      if (ok) {
        setSources(body.sources || []);
        setAdvancedMode(body.advanced_mode);
      }
    })();
  }, [refreshKey]);

  const handleToggle = async (id, enabled) => {
    await api(`/__local__/contribute/sources/${id}/toggle?enabled=${enabled}`, { method: 'POST' });
    setRefreshKey((k) => k + 1);
  };

  const handleDelete = async (id) => {
    if (!confirm('删除这个贡献源？')) return;
    await api(`/__local__/contribute/sources/${id}`, { method: 'DELETE' });
    setRefreshKey((k) => k + 1);
  };

  const handleDisableAdvanced = async () => {
    if (!confirm('关闭高级模式后，已添加的 subscription 类来源会保留但隐藏在主 UI。继续？')) return;
    await api('/__local__/contribute/advanced-mode/disable', { method: 'POST' });
    setRefreshKey((k) => k + 1);
  };

  const groupedSources = {
    local: sources.filter((s) => s.source_kind === 'local'),
    gateway: sources.filter((s) => s.source_kind === 'gateway'),
    subscription: sources.filter((s) => s.source_kind === 'subscription'),
  };

  const SECTIONS = [
    { kind: 'local',    icon: '🖥️', label: '本地算力',      desc: 'Ollama / vLLM 等本机模型。最安全。' },
    { kind: 'gateway',  icon: '🏢', label: '私有网关',      desc: '公司内 OneAPI / NewAPI / 自建 Azure。自行评估合规。' },
    { kind: 'subscription', icon: '⚠', label: '富余订阅 key', desc: '订阅账号转 API。违反上游 ToS，可能封号 + 联合风控。', advanced: true },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">贡献体系</h1>
        <p className="text-xs text-gray-500 mt-1">
          板块③：把本机富余的算力 / API 额度共享到 Token Bank 网络，换取积分。
          高风险来源（订阅 key）藏在「高级模式」开关后。
        </p>
      </header>

      {/* 高级模式开关 */}
      <div className="mb-6 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">高级模式</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {advancedMode ? '已启用：可添加订阅类来源，启用记录已落库。' : '关闭：仅可添加本地 / 网关类来源。'}
          </p>
        </div>
        {advancedMode ? (
          <button onClick={handleDisableAdvanced} className="text-xs px-3 py-1.5 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">
            关闭高级模式
          </button>
        ) : (
          <button onClick={() => setShowAckModal(true)} className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700">
            启用高级模式
          </button>
        )}
      </div>

      {/* 三类 source 分组 */}
      {SECTIONS.filter((s) => !s.advanced || advancedMode).map((section) => (
        <div key={section.kind} className="mb-6 border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-sm">{section.icon} {section.label}</h3>
              <p className="text-xs text-gray-500 mt-0.5">{section.desc}</p>
            </div>
            <button onClick={() => { setAddKind(section.kind); setShowAddModal(true); }} className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">
              + 添加
            </button>
          </div>
          {groupedSources[section.kind].length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500 italic">暂未配置</p>
          ) : (
            <div className="space-y-2">
              {groupedSources[section.kind].map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-gray-50 dark:bg-gray-950 border border-gray-100 dark:border-gray-800">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{s.display_name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {s.base_url || '— 本机模型'} · {s.models.join(', ') || '无模型列表'}
                      {s.quota_unit && <span> · {s.quota_used}/{s.quota_total} {s.quota_unit}</span>}
                      {s.schedule && <span> · {s.schedule}</span>}
                    </p>
                  </div>
                  <div className="shrink-0 flex gap-1.5 items-center">
                    <label className="flex items-center gap-1 text-xs cursor-pointer">
                      <input type="checkbox" checked={s.enabled === 1} onChange={(e) => handleToggle(s.id, e.target.checked)} />
                      启用
                    </label>
                    <button onClick={() => handleDelete(s.id)} className="text-xs px-2 py-1 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">删除</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="text-xs text-gray-400 dark:text-gray-500 mt-4">
        说明：本页配置的来源由「Agent」（板块③ WebSocket Worker）实际使用。
        启动 Agent 后，已启用的来源会被发布到 VPS 分享池，按 5 分钟周期结算积分。
      </div>

      {showAddModal && (
        <AddSourceModal
          defaultKind={addKind}
          advancedMode={advancedMode}
          onAdded={() => { setShowAddModal(false); setRefreshKey((k) => k + 1); }}
          onClose={() => setShowAddModal(false)}
        />
      )}
      {showAckModal && (
        <AckModal
          onConfirm={() => { setShowAckModal(false); setRefreshKey((k) => k + 1); }}
          onClose={() => setShowAckModal(false)}
        />
      )}
    </div>
  );
}
