/**
 * 网关 Tab 4 · 📐 智能路由（PROMPT-3）
 *
 * 列出 routing_rules（含 6 条 builtin），可启停 / 编辑 / 新建 / 删除自定义。
 * 命中规则的请求会覆盖 model（和可选 target_provider）。
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
  try { return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null }; }
  catch { return { ok: res.ok, status: res.status, body: text }; }
}

const KIND_LABEL = {
  token_count_gt: 'tokens > N',
  has_tools:      '含 tools',
  system_regex:   'system 正则',
  message_regex:  '全部消息正则',
  header_hint:    'X-LLP-Hint 头',
};

const KIND_COLOR = {
  token_count_gt: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
  has_tools:      'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300',
  system_regex:   'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
  message_regex:  'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  header_hint:    'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
};


function RuleForm({ initial, onSubmit, onClose }) {
  const isEdit = !!initial?.id;
  const [form, setForm] = useState({
    name:            initial?.name || '',
    match_kind:      initial?.match_kind || 'system_regex',
    match_value:     initial?.match_value || '',
    target_model:    initial?.target_model || '',
    target_provider: initial?.target_provider || '',
    priority:        initial?.priority || 100,
    enabled:         initial?.enabled !== 0 && initial?.enabled !== false,
    description:     initial?.description || '',
  });
  const updateField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-lg max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-lg font-semibold">{isEdit ? '编辑规则' : '新建规则'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-gray-500">规则名</label>
            <input value={form.name} onChange={(e) => updateField('name', e.target.value)} disabled={isEdit}
                   placeholder="my-rule" className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm font-mono disabled:opacity-60" />
          </div>
          <div>
            <label className="text-xs text-gray-500">匹配类型</label>
            <select value={form.match_kind} onChange={(e) => updateField('match_kind', e.target.value)}
                    className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm">
              {Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">匹配值</label>
            <input value={form.match_value} onChange={(e) => updateField('match_value', e.target.value)}
                   placeholder={
                     form.match_kind === 'token_count_gt' ? '8000'
                     : form.match_kind === 'has_tools' ? 'true'
                     : form.match_kind === 'header_hint' ? '* (任意值都触发) 或具体值'
                     : '(?i)\\b(review|refactor)\\b'
                   }
                   className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500">目标 model（覆盖请求的）</label>
              <input value={form.target_model} onChange={(e) => updateField('target_model', e.target.value)}
                     placeholder="claude-opus-4-7" className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-500">偏好 provider（可选）</label>
              <input value={form.target_provider} onChange={(e) => updateField('target_provider', e.target.value)}
                     placeholder="groq" className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm font-mono" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500">优先级（数字小者优先）</label>
            <input type="number" value={form.priority} onChange={(e) => updateField('priority', parseInt(e.target.value, 10) || 100)}
                   className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">说明</label>
            <input value={form.description} onChange={(e) => updateField('description', e.target.value)}
                   className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={(e) => updateField('enabled', e.target.checked)} />
            启用
          </label>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-gray-100 dark:border-gray-800">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700">取消</button>
          <button onClick={() => onSubmit(form)} disabled={!form.name || !form.match_value}
                  className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white disabled:opacity-40">保存</button>
        </div>
      </div>
    </div>
  );
}


export default function Rules() {
  const [rules, setRules] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    (async () => {
      const r = await api('/__local__/rules');
      if (r.ok) setRules(r.body.rules || []);
    })();
  }, [refresh]);

  const toggleRule = async (rid, enabled) => {
    await api(`/__local__/rules/${rid}/toggle?enabled=${enabled}`, { method: 'POST' });
    setRefresh((k) => k + 1);
  };

  const submit = async (payload) => {
    await api('/__local__/rules', { method: 'POST', body: JSON.stringify(payload) });
    setShowForm(false);
    setEditing(null);
    setRefresh((k) => k + 1);
  };

  const remove = async (rule) => {
    if (rule.is_builtin) return alert('内置规则不可删除（可禁用）');
    if (!confirm(`删除规则「${rule.name}」？`)) return;
    await api(`/__local__/rules/${rule.id}`, { method: 'DELETE' });
    setRefresh((k) => k + 1);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs text-gray-500">
            根据请求特征（token 数 / 工具调用 / system prompt / 显式 header）自动覆盖 model 和 provider。
            <br />优先级数字小者先匹配，第一条命中后停止。
          </p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }}
                className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white">+ 新建规则</button>
      </div>

      {rules.length === 0 ? (
        <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded p-8 text-center text-sm text-gray-400">
          还没有规则。
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id}
                 className={`border rounded-lg p-3 ${r.enabled ? 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900' : 'border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 opacity-60'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-semibold">{r.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${KIND_COLOR[r.match_kind] || ''}`}>
                  {KIND_LABEL[r.match_kind] || r.match_kind}
                </span>
                {r.is_builtin === 1 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-800 text-gray-600">内置</span>}
                <span className="text-[10px] text-gray-500">priority={r.priority}</span>
                <div className="flex-1" />
                <label className="flex items-center gap-1 text-xs cursor-pointer">
                  <input type="checkbox" checked={!!r.enabled} onChange={(e) => toggleRule(r.id, e.target.checked)} />
                  <span>启用</span>
                </label>
                {!r.is_builtin && (
                  <button onClick={() => remove(r)} className="text-[11px] text-red-600 hover:underline">删除</button>
                )}
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">{r.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-gray-500">条件：</span>
                <code className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono">{r.match_value || '(空)'}</code>
                <span className="text-gray-400">→</span>
                <span className="text-gray-500">改写 model：</span>
                <code className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-mono">{r.target_model || '(用 header 值)'}</code>
                {r.target_provider && (
                  <>
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-500">偏好 provider：</span>
                    <code className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-mono">{r.target_provider}</code>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && <RuleForm initial={editing} onSubmit={submit} onClose={() => { setShowForm(false); setEditing(null); }} />}
    </div>
  );
}
