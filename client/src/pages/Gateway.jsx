/**
 * Gateway —— v2.1 redesign 默认首屏（替代 Dashboard）。
 *
 * 设计：
 *   ┌── ● 网关 [运行中 :11435]                              [调试请求] ──┐
 *   │  [今日请求 N] [免费命中率 N%] [错误率 N%] [平均延迟 Nms]            │
 *   │  接入端点: http://127.0.0.1:11435/v1  [复制] [配置到 Claude Code]    │
 *   ├── 场景路由 ───────────────────────────────────────── [+ 新建场景] ─┤
 *   │ Claude Code (24/今日)         ┌── Claude Code  ┌─tb-cc-…  [复制][重置][删除]
 *   │ 写文章 (8/今日)               │  降级链 - 失败自动切下一步
 *   │ 数据分析 (3/今日)             │  ① 优先  [llama3.2|Ollama] [llama-3.1-8b|Groq] [+ 模型]
 *   │                              │  ② 改选  [gpt-4o-mini|GitHub Models] ...
 *   └──────────────────────────────────────────────────────────────────┘
 */
import React, { useEffect, useState } from 'react';
import Overview from './gateway/Overview';
import Subscriptions from './gateway/Subscriptions';
import Rules from './gateway/Rules';

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

function copy(s) { try { navigator.clipboard?.writeText(s || ''); } catch {} }

// ── TemplateModal ──────────────────────────────────────────────────────

function TemplateModal({ onClose, onCreated }) {
  const [templates, setTemplates] = useState([]);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await api('/__local__/scenarios/templates');
      if (r.ok) setTemplates(r.body.templates || []);
    })();
  }, []);

  const useTemplate = async (tpl) => {
    setBusyId(tpl.id);
    const { ok, body } = await api('/__local__/scenarios/from-template', {
      method: 'POST',
      body: JSON.stringify({ template_id: tpl.id }),
    });
    setBusyId(null);
    if (ok) onCreated?.(body);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-lg max-w-3xl w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900">
          <h2 className="text-lg font-semibold">从模板新建场景</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">✕</button>
        </div>
        <div className="p-4 space-y-2.5">
          {templates.map((t) => {
            const missing = t.missing_providers || [];
            return (
              <div key={t.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <div className="text-3xl">{t.icon}</div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm">{t.name}</h3>
                    <p className="text-xs text-gray-500 mt-1">{t.description}</p>
                    {/* chain preview */}
                    <div className="mt-2 space-y-1">
                      {t.chain.map((step, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className="text-gray-400 font-mono w-4">{i + 1}</span>
                          <span className="text-gray-500 w-10">{step.label}</span>
                          <div className="flex flex-wrap gap-1">
                            {step.candidates.map((c, j) => (
                              <span key={j} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-700">
                                <span className="font-mono">{c.model}</span>
                                <span className={`text-[9px] px-1 rounded ${missing.includes(c.provider_id) ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>{c.provider_id}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    {missing.length > 0 && (
                      <p className="mt-2 text-[11px] text-orange-600 dark:text-orange-400">
                        ⚠ 缺 provider：{missing.join(', ')} —— 创建后去 🎁 供给源 添加，否则该候选会被跳过
                      </p>
                    )}
                  </div>
                  <button onClick={() => useTemplate(t)} disabled={busyId === t.id}
                          className="shrink-0 text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
                    {busyId === t.id ? '创建中…' : '使用此模板'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── DebugModal ─────────────────────────────────────────────────────────

function DebugModal({ scenarios, defaultScenarioId, onClose, gatewayUrl }) {
  const [scenarioId, setScenarioId] = useState(defaultScenarioId || (scenarios[0]?.id));
  const [prompt, setPrompt] = useState('用一句话介绍你自己');
  const [model, setModel] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [rawError, setRawError] = useState(null);

  const send = async () => {
    const s = scenarios.find((x) => x.id === scenarioId);
    if (!s) return;
    setSending(true); setResult(null); setRawError(null);
    try {
      const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${s.api_key}`,
          'X-LLP-Debug': '1',
        },
        body: JSON.stringify({
          model: model || 'auto',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const text = await res.text();
      try { setResult(JSON.parse(text)); }
      catch { setRawError(`HTTP ${res.status}: ${text.slice(0, 500)}`); }
    } catch (e) {
      setRawError(e.message);
    }
    setSending(false);
  };

  const dbg = result?._llp_debug;
  const choice = result?.choices?.[0]?.message?.content;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-lg max-w-3xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900 z-10">
          <h2 className="text-lg font-semibold">🔍 调试请求</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">✕</button>
        </div>
        <div className="p-4 space-y-3">
          {scenarios.length === 0 ? (
            <p className="text-sm text-gray-500">还没有场景。先在右侧「+ 新建场景」或「+ 从模板新建」。</p>
          ) : (
            <>
              <div>
                <label className="text-xs text-gray-500">场景</label>
                <select value={scenarioId} onChange={(e) => setScenarioId(parseInt(e.target.value))}
                        className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm">
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500">模型（可选，留空让降级链决定）</label>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 llama3.2 / gpt-4o"
                       className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-500">Prompt</label>
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
                          className="w-full mt-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm resize-y" />
              </div>
              <button onClick={send} disabled={sending || !prompt}
                      className="w-full text-sm py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
                {sending ? '发送中…' : '发送'}
              </button>

              {/* 调试元数据 */}
              {dbg && (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 rounded p-3">
                  <p className="text-xs font-semibold text-blue-800 dark:text-blue-200 mb-1.5">路由结果</p>
                  <div className="grid grid-cols-2 gap-y-0.5 gap-x-3 text-xs font-mono">
                    <div className="text-gray-500">场景</div><div>{dbg.scenario_name}</div>
                    <div className="text-gray-500">命中步骤</div><div>{dbg.step_label || '—'}</div>
                    <div className="text-gray-500">实际 provider</div><div>{dbg.routed_to}</div>
                    <div className="text-gray-500">实际 model</div><div>{dbg.actual_model}</div>
                    <div className="text-gray-500">tier</div><div>{dbg.tier}</div>
                    <div className="text-gray-500">协议</div><div>{dbg.protocol || 'openai'}{dbg.protocol && dbg.protocol !== 'openai' ? ' (自动转换)' : ''}</div>
                    <div className="text-gray-500">延迟</div><div>{dbg.latency_ms}ms</div>
                    {dbg.rule_match && (
                      <>
                        <div className="text-gray-500">命中规则</div>
                        <div className="text-purple-700 dark:text-purple-300">
                          {dbg.rule_match.rule_name} · {dbg.rule_match.matched_value}
                        </div>
                      </>
                    )}
                  </div>
                  {dbg.attempts && dbg.attempts.length > 1 && (
                    <div className="mt-2 pt-2 border-t border-blue-200 dark:border-blue-900">
                      <p className="text-[11px] text-blue-700 dark:text-blue-300 mb-1">尝试链路（{dbg.attempts.length} 步）：</p>
                      <ol className="text-[11px] space-y-0.5 font-mono">
                        {dbg.attempts.map((a, i) => (
                          <li key={i} className={a.outcome === 'success' ? 'text-green-700 dark:text-green-300' : 'text-orange-700 dark:text-orange-300'}>
                            {i + 1}. {a.step} · {a.provider_id} / {a.model} → {a.outcome}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}

              {/* 响应内容 */}
              {choice && (
                <div className="bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded p-3">
                  <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">模型回复</p>
                  <pre className="text-xs whitespace-pre-wrap font-sans text-gray-800 dark:text-gray-200 max-h-64 overflow-y-auto">{choice}</pre>
                  {result.usage && (
                    <p className="mt-2 text-[10px] text-gray-500">tokens · in {result.usage.prompt_tokens || 0} / out {result.usage.completion_tokens || 0}</p>
                  )}
                </div>
              )}

              {/* 错误 */}
              {result && !choice && !dbg && (
                <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-900 rounded p-3 text-xs">
                  <p className="font-semibold text-red-700 dark:text-red-300 mb-1">无可读响应</p>
                  <pre className="whitespace-pre-wrap text-red-700 dark:text-red-300 max-h-48 overflow-y-auto">{JSON.stringify(result, null, 2)}</pre>
                </div>
              )}
              {rawError && (
                <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 rounded p-3 text-xs">{rawError}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── KPI 卡 ─────────────────────────────────────────────────────────────

function Kpi({ label, value, color = 'text-gray-900 dark:text-gray-100' }) {
  return (
    <div className="flex-1 min-w-0 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${color}`}>{value}</p>
    </div>
  );
}

// ── 降级链候选 chip ────────────────────────────────────────────────────

function CandidateChip({ provider, model, providerMeta, onRemove }) {
  const tier = providerMeta?.tier || 'free';
  const tierColor = tier === 'free' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                  : tier === 'paid' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                  : 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300';
  const protocol = providerMeta?.protocol || 'openai';
  const protoTip = protocol === 'anthropic'     ? 'anthropic ⇆ openai'
                 : protocol === 'gemini_native' ? 'gemini ⇆ openai'
                 : null;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 text-xs">
      <span className="font-mono">{model || '?'}</span>
      <span className={`text-[10px] px-1 py-0.5 rounded ${tierColor}`}>{providerMeta?.display_name || provider}</span>
      {protoTip && (
        <span className="text-[9px] text-gray-500 italic" title="网关会做协议互转">{protoTip}</span>
      )}
      {onRemove && (
        <button onClick={onRemove} className="text-gray-400 hover:text-red-500 ml-0.5">×</button>
      )}
    </span>
  );
}

// ── 场景编辑器 ─────────────────────────────────────────────────────────

function ScenarioEditor({ scenario, providers, onChanged, onDeleted }) {
  const [chain, setChain] = useState(scenario.degradation_chain || []);
  const [showAddIdx, setShowAddIdx] = useState(-1);
  const [newPid, setNewPid] = useState('');
  const [newModel, setNewModel] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setChain(scenario.degradation_chain || []); }, [scenario.id, scenario.degradation_chain]);

  const providersById = Object.fromEntries((providers || []).map((p) => [p.provider_id, p]));

  const persist = async (newChain) => {
    setSaving(true);
    await api(`/__local__/scenarios/${scenario.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ degradation_chain: newChain }),
    });
    setSaving(false);
    onChanged?.();
  };

  const addStep = () => {
    const labels = ['优先', '改选', '兜底', '最后'];
    const label = labels[chain.length] || `步骤 ${chain.length + 1}`;
    const newChain = [...chain, { label, candidates: [] }];
    setChain(newChain);
    persist(newChain);
  };

  const removeStep = (i) => {
    const newChain = chain.filter((_, idx) => idx !== i);
    setChain(newChain);
    persist(newChain);
  };

  const addCandidate = (stepIdx) => {
    if (!newPid || !newModel) return;
    const newChain = chain.map((step, i) => {
      if (i !== stepIdx) return step;
      return { ...step, candidates: [...(step.candidates || []), { provider_id: newPid, model: newModel }] };
    });
    setChain(newChain);
    setNewPid(''); setNewModel(''); setShowAddIdx(-1);
    persist(newChain);
  };

  const removeCandidate = (stepIdx, cIdx) => {
    const newChain = chain.map((step, i) => {
      if (i !== stepIdx) return step;
      return { ...step, candidates: step.candidates.filter((_, j) => j !== cIdx) };
    });
    setChain(newChain);
    persist(newChain);
  };

  const rotateKey = async () => {
    if (!confirm('轮换 API Key 后旧 key 立即失效，已部署的工具需要重新写配置。继续？')) return;
    await api(`/__local__/scenarios/${scenario.id}/rotate-key`, { method: 'POST' });
    onChanged?.();
  };

  const remove = async () => {
    if (!confirm(`删除场景「${scenario.name}」？相关 API Key 立即失效。`)) return;
    await api(`/__local__/scenarios/${scenario.id}`, { method: 'DELETE' });
    onDeleted?.();
  };

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-5">
      {/* 头部：名字 + key */}
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="font-semibold text-base">{scenario.name}</h3>
        <code className="font-mono text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 truncate max-w-md">{scenario.api_key}</code>
        <button onClick={() => copy(scenario.api_key)} className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">复制</button>
        <button onClick={rotateKey} className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">重置</button>
        <div className="flex-1" />
        <button onClick={remove} className="text-xs px-2 py-1 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">删除</button>
      </div>

      {/* 降级链 */}
      <div className="mt-4">
        <p className="text-xs text-gray-500 mb-2">降级链 · 出现步骤失败后自动切换下一步{saving && <span className="ml-2 text-blue-500">保存中…</span>}</p>
        {chain.length === 0 ? (
          <p className="text-sm text-gray-400 italic py-3">还没有降级步骤，点下面「+ 添加步骤」开始</p>
        ) : (
          <div className="space-y-2">
            {chain.map((step, stepIdx) => (
              <div key={stepIdx} className="flex items-start gap-3 border border-gray-100 dark:border-gray-800 rounded p-3">
                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs font-semibold shrink-0 mt-0.5">
                  {stepIdx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium mb-2">{step.label || `步骤 ${stepIdx + 1}`}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(step.candidates || []).map((c, cIdx) => (
                      <CandidateChip key={cIdx} provider={c.provider_id} model={c.model}
                                       providerMeta={providersById[c.provider_id]}
                                       onRemove={() => removeCandidate(stepIdx, cIdx)} />
                    ))}
                    {showAddIdx === stepIdx ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30">
                        <select value={newPid} onChange={(e) => setNewPid(e.target.value)} className="text-xs bg-transparent">
                          <option value="">Provider...</option>
                          {(providers || []).map((p) => <option key={p.provider_id} value={p.provider_id}>{p.display_name}</option>)}
                        </select>
                        <select value={newModel} onChange={(e) => setNewModel(e.target.value)} className="text-xs bg-transparent">
                          <option value="">Model...</option>
                          {(providersById[newPid]?.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <button onClick={() => addCandidate(stepIdx)} disabled={!newPid || !newModel} className="text-xs text-blue-600 disabled:opacity-40">✓</button>
                        <button onClick={() => { setShowAddIdx(-1); setNewPid(''); setNewModel(''); }} className="text-xs text-gray-400">×</button>
                      </span>
                    ) : (
                      <button onClick={() => setShowAddIdx(stepIdx)} className="text-xs px-2 py-1 rounded border border-dashed border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800">
                        + 模型
                      </button>
                    )}
                  </div>
                </div>
                <button onClick={() => removeStep(stepIdx)} className="text-xs text-gray-400 hover:text-red-500 shrink-0">×</button>
              </div>
            ))}
          </div>
        )}
        <button onClick={addStep} className="mt-3 text-xs px-3 py-1.5 rounded border border-dashed border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800">
          + 添加步骤
        </button>
      </div>
    </div>
  );
}

// ── 主页 ───────────────────────────────────────────────────────────────

export default function Gateway() {
  const [health, setHealth] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [scenarios, setScenarios] = useState([]);
  const [providers, setProviders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [appsBindable, setAppsBindable] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [tab, setTab] = useState('overview');  // overview / routing / subscriptions

  useEffect(() => {
    let alive = true;
    (async () => {
      const h = await api('/__local__/health');
      if (!alive) return;
      if (!h.ok) { setHealth(false); return; }
      setHealth(h.body);
      const [k, s, p, a] = await Promise.all([
        api('/__local__/gateway/kpis?window=today'),
        api('/__local__/scenarios'),
        api('/__local__/providers'),
        api('/__local__/apps'),
      ]);
      if (k.ok) setKpis(k.body);
      if (s.ok) {
        setScenarios(s.body.scenarios || []);
        if ((s.body.scenarios || [])[0] && !selectedId) setSelectedId(s.body.scenarios[0].id);
      }
      if (p.ok) setProviders(p.body.providers || []);
      if (a.ok) setAppsBindable(a.body.apps || []);
    })();
    return () => { alive = false; };
  }, [refreshKey]);

  const createScenario = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const { ok, body } = await api('/__local__/scenarios', {
      method: 'POST',
      body: JSON.stringify({ name: newName.trim(), degradation_chain: [] }),
    });
    setCreating(false);
    if (ok) {
      setNewName('');
      setSelectedId(body.id);
      setRefreshKey((k) => k + 1);
    }
  };

  const writeToApp = async (scenario, appName) => {
    if (!confirm(`把这个场景的 API Key 写入到 ${appName}？\n原配置会自动备份。`)) return;
    await api(`/__local__/apps/${appName}/write`, {
      method: 'POST',
      body: JSON.stringify({ preferred_model: null }),  // 客户端用 model 时由 scenario 改写
    });
    // 然后手动 patch 写 token 为 scenario.api_key —— 但 app_writers.write 用的是 gateway_key
    // 这里简化：弹一个提示让用户知道还需在 settings 里改成 scenario key
    alert(`已写入到 ${appName}。提示：当前 app_writers 写的是全局 gateway key；待 v2.2 加 scenario_key 支持后会自动改写。临时方案：把 ${appName} 配置文件里的 AUTH_TOKEN 改成 ${scenario.api_key}`);
  };

  if (health === false) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold mb-3">本地网关未启动</h1>
      </div>
    );
  }
  if (health === null) return <div className="p-8 text-sm text-gray-500">加载中…</div>;

  const selected = scenarios.find((s) => s.id === selectedId);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">网关</h1>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
            运行中 :{(health.gateway_url || '').split(':').pop() || '11435'}
          </span>
        </div>
        <button onClick={() => setShowDebug(true)}
                className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">
          🔍 调试请求
        </button>
      </header>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {[
          { id: 'overview',      icon: '📊', label: '总览' },
          { id: 'routing',       icon: '🛣', label: '场景路由' },
          { id: 'rules',         icon: '📐', label: '智能路由' },
          { id: 'subscriptions', icon: '💳', label: '订阅与余额' },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab 1: 总览 */}
      {tab === 'overview' && (
        <Overview health={health} onConfigureClaude={() => selected && writeToApp(selected, 'claude_code')} />
      )}

      {/* Tab 3: 智能路由（规则引擎） */}
      {tab === 'rules' && <Rules />}

      {/* Tab 4: 订阅与余额 */}
      {tab === 'subscriptions' && <Subscriptions />}

      {/* Tab 2: 场景路由 */}
      {tab === 'routing' && (
      <div className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm">场景路由</h3>
            <p className="text-xs text-gray-500 mt-0.5">每个场景拥有独立的 API Key 和降级链，按需配置</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowTemplates(true)}
                    className="text-xs px-3 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">
              📋 从模板新建
            </button>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新场景名称" className="text-xs bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1" onKeyDown={(e) => e.key === 'Enter' && createScenario()} />
            <button onClick={createScenario} disabled={creating || !newName.trim()} className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">+ 新建场景</button>
          </div>
        </div>
        <div className="flex">
          {/* 左：场景列表 */}
          <div className="w-56 border-r border-gray-100 dark:border-gray-800 p-2 space-y-1 shrink-0 max-h-[600px] overflow-y-auto">
            {scenarios.length === 0 ? (
              <p className="text-xs text-gray-400 italic p-3">还没有场景。新建第一个吧。</p>
            ) : scenarios.map((s) => (
              <button key={s.id} onClick={() => setSelectedId(s.id)}
                      className={`w-full text-left p-2.5 rounded ${selectedId === s.id ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800' : 'hover:bg-gray-50 dark:hover:bg-gray-800 border border-transparent'}`}>
                <p className="font-medium text-sm truncate">{s.name}</p>
                <p className="text-[10px] text-gray-400 font-mono truncate">{(s.api_key || '').slice(0, 16)}…</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{s.stats_today?.calls || 0} 次今日</p>
              </button>
            ))}
          </div>
          {/* 右：详情 */}
          <div className="flex-1 min-w-0 p-4">
            {selected ? (
              <ScenarioEditor scenario={selected} providers={providers} onChanged={() => setRefreshKey((k) => k + 1)} onDeleted={() => { setSelectedId(scenarios[0]?.id ?? null); setRefreshKey((k) => k + 1); }} />
            ) : (
              <div className="flex items-center justify-center h-48 text-sm text-gray-400">
                {scenarios.length === 0 ? '左侧新建一个场景开始' : '选择左侧的场景'}
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {showTemplates && (
        <TemplateModal
          onClose={() => setShowTemplates(false)}
          onCreated={(newScenario) => {
            setShowTemplates(false);
            setSelectedId(newScenario.id);
            setRefreshKey((k) => k + 1);
            if (newScenario.missing_providers?.length) {
              setTimeout(() => alert(
                `场景已创建，但以下 provider 还没在「供给源」启用：\n  · ${newScenario.missing_providers.join('\n  · ')}\n\n这些候选会被自动跳过，去 🎁 供给源 启用后会自动恢复。`
              ), 200);
            }
          }}
        />
      )}
      {showDebug && (
        <DebugModal
          scenarios={scenarios}
          defaultScenarioId={selectedId}
          gatewayUrl={LOCAL_GATEWAY_URL}
          onClose={() => setShowDebug(false)}
        />
      )}
    </div>
  );
}
