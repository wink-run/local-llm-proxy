// Agent 对话流：典型 Agent 交互风格（用户消息 + 思考/工具/终端/回复 + 编排派发）
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownContent } from './RichMediaContent';

const STEP_META = {
  thinking: { icon: '🤔', label: '思考', accent: 'border-violet-200 bg-violet-50/60 dark:border-violet-800/40 dark:bg-violet-900/15' },
  tool_call: { icon: '🔧', label: '工具调用', accent: 'border-amber-200 bg-amber-50/60 dark:border-amber-800/40 dark:bg-amber-900/15' },
  code_edit: { icon: '✏️', label: '代码编辑', accent: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-800/40 dark:bg-emerald-900/15' },
  terminal: { icon: '🏃', label: '终端', accent: 'border-zinc-300 bg-zinc-900/90 dark:border-zinc-600 text-zinc-100' },
  system_event: { icon: '🔄', label: '系统', accent: 'border-sky-200 bg-sky-50/50 dark:border-sky-800/40 dark:bg-sky-900/15' },
  output: { icon: '💬', label: '回复', accent: '' },
};

/** 合并连续 output / thinking 步骤，减少碎片化 */
function buildTimeline(userPrompt, steps = [], delegations = {}, agentNames = {}) {
  const items = [];
  if (userPrompt) {
    items.push({ kind: 'user', content: userPrompt });
  }

  let outputBuf = [];
  let thinkingBuf = [];
  let systemBuf = [];

  const flushOutput = () => {
    if (!outputBuf.length) return;
    items.push({
      kind: 'assistant',
      content: outputBuf.map(s => s.content).join('\n'),
      timestamp: outputBuf[outputBuf.length - 1]?.timestamp,
    });
    outputBuf = [];
  };

  const flushThinking = () => {
    if (!thinkingBuf.length) return;
    items.push({
      kind: 'thinking_group',
      content: thinkingBuf.map(s => s.content).join('\n'),
      count: thinkingBuf.length,
      timestamp: thinkingBuf[thinkingBuf.length - 1]?.timestamp,
    });
    thinkingBuf = [];
  };

  const flushSystem = () => {
    if (!systemBuf.length) return;
    if (systemBuf.length === 1) {
      items.push({ kind: 'system_event', ...systemBuf[0] });
    } else {
      items.push({
        kind: 'system_event_group',
        events: [...systemBuf],
        timestamp: systemBuf[systemBuf.length - 1]?.timestamp,
      });
    }
    systemBuf = [];
  };

  for (const step of steps) {
    const type = step.stepType || 'output';

    if (type === 'delegation') {
      flushOutput();
      flushThinking();
      flushSystem();
      const del = step.childTaskId ? delegations[step.childTaskId] : null;
      items.push({
        kind: 'delegation',
        ...step,
        agentName: agentNames[step.agentId] || step.agentId,
        nestedSteps: del?.steps || [],
        delStatus: del?.status,
      });
      continue;
    }

    if (type === 'thinking') {
      flushOutput();
      flushSystem();
      thinkingBuf.push(step);
      continue;
    }

    if (type === 'system_event') {
      flushOutput();
      flushThinking();
      const prev = systemBuf[systemBuf.length - 1];
      // 相同系统事件不重复堆叠（如 thinking_tokens 流式上报）
      if (prev
        && prev.system_subtype === step.system_subtype
        && prev.content === step.content) {
        continue;
      }
      systemBuf.push(step);
      continue;
    }

    if (type === 'output') {
      flushThinking();
      flushSystem();
      const last = outputBuf[outputBuf.length - 1];
      if (last && last.content === step.content) continue;
      outputBuf.push(step);
      continue;
    }
    flushThinking();
    flushSystem();
    flushOutput();
    items.push({ kind: type, ...step });
  }
  flushThinking();
  flushSystem();
  flushOutput();
  return items;
}

/** 嵌套步骤分组（派发卡片内复用） */
function groupNestedSteps(steps = []) {
  const groups = [];
  let thinkingBuf = [];
  let systemBuf = [];

  const flushThinking = () => {
    if (!thinkingBuf.length) return;
    groups.push({
      kind: 'thinking_group',
      content: thinkingBuf.map(s => s.content).join('\n'),
      count: thinkingBuf.length,
    });
    thinkingBuf = [];
  };

  const flushSystem = () => {
    if (!systemBuf.length) return;
    if (systemBuf.length === 1) {
      groups.push({ kind: 'system_event', ...systemBuf[0] });
    } else {
      groups.push({ kind: 'system_event_group', events: [...systemBuf] });
    }
    systemBuf = [];
  };

  for (const step of steps) {
    const type = step.stepType || 'output';
    if (type === 'thinking') {
      thinkingBuf.push(step);
      continue;
    }
    if (type === 'system_event') {
      flushThinking();
      systemBuf.push(step);
      continue;
    }
    flushThinking();
    flushSystem();
    groups.push({ kind: type, ...step });
  }
  flushThinking();
  flushSystem();
  return groups;
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 展示前还原字面量 \\n / \\t，避免单行截断 */
function normalizeDisplayText(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .trim();
}

/** 判断是否为有效文件路径（过滤误写入的正文摘要） */
function isLikelyFilePath(raw) {
  const p = String(raw || '').trim();
  if (!p || p.length > 512) return false;
  if (/\\n|\\r|[\n\r]/.test(p)) return false;
  if (/^#+\s|^---|\*\*/.test(p)) return false;
  if (/^(true|false|null)$/i.test(p)) return false;
  return /[/\\]/.test(p) || /\.[a-z0-9]{1,8}$/i.test(p) || /^[\w.-]+$/.test(p);
}

/** 任务完成卡片：展示摘要与修改文件，支持长内容滚动 */
function TaskCompletionCard({ result, task }) {
  const [summaryOpen, setSummaryOpen] = useState(true);
  const summary = normalizeDisplayText(result?.summary || result?.output || '');

  const rawFiles = result?.files || [];
  const files = rawFiles.filter(f => isLikelyFilePath(f.path || f.file_path));

  // 曾被误识别为「文件」的正文，回退到摘要区展示
  const misfiledText = rawFiles
    .map(f => f.path || f.file_path)
    .filter(p => p && !isLikelyFilePath(p))
    .map(normalizeDisplayText)
    .join('\n\n');

  const displaySummary = summary || misfiledText;
  const duration = task?.completed_at && task?.started_at
    ? ((task.completed_at - task.started_at) / 1000).toFixed(1)
    : null;

  return (
    <div className="rounded-xl border border-green-200 dark:border-green-800/50 bg-green-50/60 dark:bg-green-900/15 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400 mb-2">
        <span>✅</span> 任务完成
        {duration && (
          <span className="text-xs font-normal text-green-600/80 dark:text-green-500/80">
            · {duration}s
          </span>
        )}
      </div>

      {displaySummary && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setSummaryOpen(v => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-green-800/90 dark:text-green-300/90 mb-1"
          >
            <span>📋</span> 执行摘要
            <span className="text-zinc-400">{summaryOpen ? '▾' : '▸'}</span>
          </button>
          {summaryOpen && (
            <div className="text-xs leading-relaxed max-h-96 overflow-y-auto rounded-lg bg-white/60 dark:bg-zinc-900/40 border border-green-100 dark:border-green-900/40 px-3 py-2 text-zinc-700 dark:text-zinc-300">
              <MarkdownContent content={displaySummary} />
            </div>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="space-y-1 mt-2">
          <div className="text-xs font-medium text-green-800/80 dark:text-green-400/80 mb-1">修改的文件</div>
          {files.map((f, idx) => (
            <div key={idx} className="flex items-start gap-2 text-xs font-mono text-zinc-600 dark:text-zinc-400">
              <span className="shrink-0">{f.operation === 'created' ? '📝' : '✏️'}</span>
              <span className="break-all whitespace-pre-wrap">{f.path || f.file_path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 格式化重试等待时间 */
function formatRetryDelay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

/** 系统事件文案（api_retry 等） */
function describeSystemEvent(ev) {
  if (!ev) return { title: '系统事件', detail: '' };
  if (ev.system_subtype === 'api_retry') {
    const attempt = ev.attempt ?? '?';
    const max = ev.max_retries ?? '?';
    const status = ev.error_status != null ? String(ev.error_status) : '—';
    return {
      title: `API 重试 ${attempt}/${max}`,
      detail: `HTTP ${status} · ${formatRetryDelay(ev.retry_delay_ms)} 后重试`,
      badge: status,
    };
  }
  const label = ev.system_subtype || 'system';
  const msg = ev.message || ev.content || '';
  return { title: label, detail: msg, badge: null };
}

/** 单条系统事件 */
function SystemEventRow({ ev, index }) {
  const info = describeSystemEvent(ev);
  return (
    <div className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg bg-white/70 dark:bg-zinc-900/50 border border-sky-100/80 dark:border-sky-800/30">
      <span className="w-5 h-5 shrink-0 rounded-full bg-sky-100 dark:bg-sky-900/50 text-[10px] font-semibold text-sky-700 dark:text-sky-300 flex items-center justify-center">
        {index ?? ev.attempt ?? '·'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-sky-900 dark:text-sky-100">{info.title}</p>
        {info.detail && (
          <p className="text-[10px] text-sky-700/70 dark:text-sky-300/70 truncate">{info.detail}</p>
        )}
      </div>
      {info.badge && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 font-mono shrink-0">
          {info.badge}
        </span>
      )}
    </div>
  );
}

/** 系统事件卡片（单条） */
function SystemEventCard({ step }) {
  const info = describeSystemEvent(step);
  const meta = STEP_META.system_event;

  return (
    <div className="flex justify-start w-full">
      <div className={`max-w-[88%] w-full rounded-xl border ${meta.accent} overflow-hidden`}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-sky-100/60 dark:border-sky-800/30">
          <span>{meta.icon}</span>
          <span className="text-xs font-medium text-sky-800 dark:text-sky-200">{info.title}</span>
          <span className="ml-auto text-[10px] text-zinc-400">{formatTime(step.timestamp)}</span>
        </div>
        <div className="px-3 py-2">
          <SystemEventRow ev={step} />
        </div>
      </div>
    </div>
  );
}

/** 合并连续系统事件（如多次 API 重试） */
function SystemEventGroupCard({ item }) {
  const events = item.events || [];
  const retries = events.filter(e => e.system_subtype === 'api_retry');
  const title = retries.length
    ? `API 重试 · ${retries.length} 次`
    : `系统事件 · ${events.length} 条`;
  const [open, setOpen] = useState(true);
  const meta = STEP_META.system_event;

  return (
    <div className="flex justify-start w-full">
      <div className={`max-w-[88%] w-full rounded-xl border ${meta.accent} overflow-hidden`}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-sky-100/30 dark:hover:bg-sky-900/20 transition-colors"
        >
          <span>{meta.icon}</span>
          <span className="text-xs font-medium text-sky-800 dark:text-sky-200">{title}</span>
          <span className="text-[10px] text-sky-600/70 dark:text-sky-400/70">
            网关暂时不可用，正在自动重试
          </span>
          <span className="ml-auto text-[10px] text-zinc-400 shrink-0">{formatTime(item.timestamp)}</span>
          <span className="text-xs text-zinc-400 shrink-0">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="px-3 pb-3 space-y-1.5">
            {events.map((ev, idx) => (
              <SystemEventRow key={idx} ev={ev} index={ev.attempt ?? idx + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 解析 MCP / 派发工具名，便于展示 */
function parseToolName(raw) {
  if (!raw) return { display: '未知工具', server: null };
  if (raw.startsWith('dispatch:')) {
    return { display: raw.slice('dispatch:'.length), server: 'Agent 派发' };
  }
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__').filter(Boolean);
    if (parts.length >= 3) {
      return {
        display: parts[parts.length - 1],
        server: parts.slice(1, -1).join(' · '),
      };
    }
  }
  return { display: raw, server: null };
}

/** 格式化工具参数（JSON 美化） */
function formatToolPayload(content) {
  const text = String(content || '').trim();
  if (!text) return { formatted: '{}', empty: true, isJson: true };
  try {
    const obj = JSON.parse(text);
    const empty = obj != null && typeof obj === 'object' && !Array.isArray(obj)
      && Object.keys(obj).length === 0;
    return {
      formatted: JSON.stringify(obj, null, 2),
      empty,
      isJson: true,
    };
  } catch {
    return { formatted: text, empty: !text, isJson: false };
  }
}

/** 工具调用卡片（MCP / 派发） */
function ToolCallCard({ step }) {
  const { display, server } = parseToolName(step.tool_name);
  const payload = formatToolPayload(step.content);
  // 空参数默认折叠，减少 `{}` 刷屏
  const [open, setOpen] = useState(!payload.empty);

  return (
    <div className="flex justify-start w-full">
      <div className="max-w-[92%] w-full rounded-xl border border-amber-200/70 dark:border-amber-700/35 bg-gradient-to-br from-amber-50/95 via-white to-orange-50/50 dark:from-amber-950/25 dark:via-zinc-900/60 dark:to-zinc-900/40 shadow-sm overflow-hidden">
        <div className="flex min-w-0">
          <div className="w-1 shrink-0 bg-gradient-to-b from-amber-400 to-orange-500 dark:from-amber-500 dark:to-orange-600" />
          <div className="flex-1 min-w-0">
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-amber-100/40 dark:hover:bg-amber-900/20 transition-colors"
            >
              <div className="w-8 h-8 shrink-0 rounded-lg bg-amber-100 dark:bg-amber-900/45 border border-amber-200/60 dark:border-amber-700/40 flex items-center justify-center text-sm shadow-sm">
                ⚡
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <code className="text-xs font-semibold text-amber-950 dark:text-amber-100 tracking-tight">
                    {display}
                  </code>
                  {server && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/80 dark:bg-zinc-800/80 border border-amber-200/60 dark:border-amber-800/50 text-amber-800/80 dark:text-amber-300/90 truncate max-w-[200px]">
                      {server}
                    </span>
                  )}
                  {payload.empty && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                      无参数
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-1">
                  工具调用 · {formatTime(step.timestamp)}
                </p>
              </div>
              <span className="text-zinc-400 dark:text-zinc-500 text-xs shrink-0 mt-1">{open ? '▾' : '▸'}</span>
            </button>

            {open && (
              <div className="px-3 pb-3 pt-0">
                <div className="rounded-lg overflow-hidden border border-zinc-800/10 dark:border-zinc-700/60 bg-zinc-900 dark:bg-zinc-950 shadow-inner">
                  <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-700/40 bg-zinc-800/80">
                    <span className="flex gap-1">
                      <span className="w-2 h-2 rounded-full bg-red-400/90" />
                      <span className="w-2 h-2 rounded-full bg-amber-400/90" />
                      <span className="w-2 h-2 rounded-full bg-emerald-400/90" />
                    </span>
                    <span className="text-[10px] font-medium text-zinc-400">
                      {payload.isJson ? 'JSON 参数' : '输入内容'}
                    </span>
                  </div>
                  <pre className="px-3 py-2.5 text-[11px] leading-relaxed font-mono text-emerald-300/95 whitespace-pre-wrap break-all max-h-52 overflow-y-auto">
                    {payload.formatted}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolCard({ step }) {
  if (step.kind === 'tool_call') {
    return <ToolCallCard step={step} />;
  }
  if (step.kind === 'system_event') {
    return <SystemEventCard step={step} />;
  }

  const meta = STEP_META[step.kind] || STEP_META.output;
  // 思考过程默认折叠，避免刷屏
  const collapsible = step.kind === 'thinking' || (step.content || '').length > 280;
  const [open, setOpen] = useState(step.kind !== 'thinking');

  return (
    <div className="flex justify-start">
      <div className={`max-w-[88%] w-full rounded-xl border ${meta.accent}`}>
        <button
          type="button"
          onClick={() => collapsible && setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
        >
          <span>{meta.icon}</span>
          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{meta.label}</span>
          {step.tool_name && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 font-mono">
              {step.tool_name}
            </span>
          )}
          {!open && step.kind === 'thinking' && step.content && (
            <span className="flex-1 min-w-0 text-[10px] text-zinc-400 truncate">
              {String(step.content).replace(/\s+/g, ' ').slice(0, 60)}…
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-400 shrink-0">{formatTime(step.timestamp)}</span>
          {collapsible && <span className="text-xs text-zinc-400 shrink-0">{open ? '▾' : '▸'}</span>}
        </button>
        {open && (
          step.kind === 'terminal' || step.kind === 'code_edit' ? (
            <pre className={`px-3 pb-3 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed max-h-72 overflow-y-auto ${
              step.kind === 'terminal' ? 'text-zinc-100' : 'text-zinc-700 dark:text-zinc-300'
            }`}>
              {step.content}
            </pre>
          ) : (
            <div className="px-3 pb-3 text-xs max-h-72 overflow-y-auto text-zinc-700 dark:text-zinc-300">
              <MarkdownContent content={normalizeDisplayText(step.content)} />
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** 合并后的思考过程：默认折叠 */
function ThinkingGroupCard({ item }) {
  const [open, setOpen] = useState(false);
  const preview = String(item.content || '').replace(/\s+/g, ' ').trim();
  const meta = STEP_META.thinking;

  return (
    <div className="flex justify-start">
      <div className={`max-w-[88%] w-full rounded-xl border ${meta.accent}`}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
        >
          <span>{meta.icon}</span>
          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            思考过程{item.count > 1 ? ` · ${item.count} 条` : ''}
          </span>
          {!open && preview && (
            <span className="flex-1 min-w-0 text-[10px] text-zinc-400 truncate">{preview.slice(0, 72)}…</span>
          )}
          <span className="ml-auto text-[10px] text-zinc-400 shrink-0">{formatTime(item.timestamp)}</span>
          <span className="text-xs text-zinc-400 shrink-0">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="px-3 pb-3 text-xs max-h-80 overflow-y-auto text-zinc-700 dark:text-zinc-300">
            <MarkdownContent content={normalizeDisplayText(item.content)} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 编排派发卡片：主 Agent 视角展示子 Agent 工作形态 */
function DelegationCard({ item }) {
  const [open, setOpen] = useState(true);
  const isStart = item.phase === 'start';
  const isComplete = item.phase === 'complete';
  const running = isStart && item.delStatus === 'running';
  const failed = isComplete && (item.status === 'failed' || item.delStatus === 'failed');

  const statusLabel = running
    ? '执行中…'
    : failed
      ? '失败'
      : isComplete
        ? '已完成'
        : '';

  return (
    <div className="flex justify-start">
      <div className={`max-w-[92%] w-full rounded-xl border ${
        failed
          ? 'border-red-200 bg-red-50/50 dark:border-red-800/40 dark:bg-red-900/10'
          : 'border-indigo-200 bg-indigo-50/50 dark:border-indigo-800/40 dark:bg-indigo-900/10'
      }`}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        >
          <span>{isComplete ? (failed ? '❌' : '✅') : '📤'}</span>
          <span className="text-xs font-semibold text-indigo-800 dark:text-indigo-300">
            {isStart ? '派发' : '派发结果'} → {item.agentName || item.agentId}
          </span>
          {statusLabel && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              running
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                : failed
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                  : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
            }`}>
              {statusLabel}
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-400">{formatTime(item.timestamp)}</span>
          <span className="text-xs text-zinc-400">{open ? '▾' : '▸'}</span>
        </button>

        {open && (
          <div className="px-3 pb-3 space-y-2">
            {isStart && item.content && (
              <div className="text-xs border-l-2 border-indigo-300 dark:border-indigo-700 pl-2 text-zinc-600 dark:text-zinc-400">
                <span className="text-zinc-400">任务：</span>
                <MarkdownContent content={normalizeDisplayText(item.content)} />
              </div>
            )}

            {/* 子 Agent 实时输出（主 Agent 视角嵌套展示） */}
            {item.nestedSteps?.length > 0 && (
              <div className="rounded-lg border border-zinc-200/80 dark:border-zinc-700/80 bg-white/60 dark:bg-zinc-900/40 p-2 space-y-2">
                <p className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                  {item.agentName} 工作输出
                </p>
                {groupNestedSteps(item.nestedSteps).map((ns, idx) => {
                  if (ns.kind === 'thinking_group') {
                    return <ThinkingGroupCard key={idx} item={ns} />;
                  }
                  if (ns.kind === 'system_event_group') {
                    return <SystemEventGroupCard key={idx} item={ns} />;
                  }
                  if (ns.kind === 'system_event') {
                    return <SystemEventCard key={idx} step={ns} />;
                  }
                  if (ns.kind === 'output' || ns.stepType === 'output') {
                    return (
                      <div key={idx} className="text-xs text-zinc-700 dark:text-zinc-300">
                        <MarkdownContent content={normalizeDisplayText(ns.content)} />
                      </div>
                    );
                  }
                  return <ToolCard key={idx} step={{ kind: ns.kind || ns.stepType, ...ns }} />;
                })}
              </div>
            )}

            {isComplete && item.content && (
              <div className="text-xs max-h-48 overflow-y-auto text-zinc-700 dark:text-zinc-300">
                <MarkdownContent content={normalizeDisplayText(item.content)} />
              </div>
            )}

            {isStart && !item.nestedSteps?.length && running && (
              <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
                <span className="w-3 h-3 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
                等待 {item.agentName} 输出…（可切换到对应 Agent 标签查看详情）
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ExecutionLog({
  conversationTurns = [],
  userPrompt,
  steps,
  status,
  result,
  task,
  agentName,
  delegations = {},
  agentNames = {},
}) {
  const endRef = useRef(null);

  /** 合并历史轮次 + 当前轮次为完整时间线 */
  const timeline = useMemo(() => {
    const items = [];
    for (const turn of conversationTurns) {
      items.push(...buildTimeline(turn.user, turn.steps || [], {}, agentNames));
    }
    items.push(...buildTimeline(userPrompt, steps, delegations, agentNames));
    return items;
  }, [conversationTurns, userPrompt, steps, delegations, agentNames]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [timeline, status, result, conversationTurns]);

  const empty = !conversationTurns.length && !userPrompt && timeline.length === 0;

  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center text-zinc-400 dark:text-zinc-500 select-none">
        <p className="text-3xl mb-2">{agentName ? '✨' : '🤖'}</p>
        <p className="text-sm">
          {agentName
            ? `向 ${agentName} 描述任务，在底部选择工作目录后发送`
            : '选择 Agent 标签，在底部输入任务开始协作'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      {timeline.map((item, i) => {
        if (item.kind === 'user') {
          return (
            <div key={`u-${i}`} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm bg-blue-600">
                <MarkdownContent
                  content={normalizeDisplayText(item.content)}
                  theme="inverted"
                />
              </div>
            </div>
          );
        }

        if (item.kind === 'assistant') {
          return (
            <div key={`a-${i}`} className="flex justify-start gap-2">
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] shrink-0 mt-0.5">
                AI
              </div>
              <div className="max-w-[80%] rounded-2xl rounded-bl-md px-4 py-2.5 text-sm bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100">
                <MarkdownContent content={normalizeDisplayText(item.content)} />
              </div>
            </div>
          );
        }

        if (item.kind === 'delegation') {
          return <DelegationCard key={`d-${i}`} item={item} />;
        }

        if (item.kind === 'thinking_group') {
          return <ThinkingGroupCard key={`tg-${i}`} item={item} />;
        }

        if (item.kind === 'system_event_group') {
          return <SystemEventGroupCard key={`sg-${i}`} item={item} />;
        }

        if (item.kind === 'system_event') {
          return <SystemEventCard key={`se-${i}`} step={item} />;
        }

        return <ToolCard key={`t-${i}`} step={item} />;
      })}

      {status === 'running' && (
        <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 pl-1">
          <span className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
          {agentName || 'Agent'} 正在执行…
        </div>
      )}

      {status === 'failed' && task?.error && (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">
          {task.error}
        </div>
      )}

      {result && status === 'completed' && (
        <TaskCompletionCard result={result} task={task} />
      )}

      <div ref={endRef} />
    </div>
  );
}
