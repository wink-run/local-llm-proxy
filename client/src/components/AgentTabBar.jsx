// Agent 左侧竖排列表：聚合入口 + 各 Agent；可指定主 Agent（编排层）
import React from 'react';
import { resolveBrandIcon } from '../lib/brandIcons';
import KimiAvatar from './KimiAvatar';

/** 未命中品牌时的 emoji 回退 */
const FALLBACK_ICON = {
  'claude-code': '🤖',
  codex: '💻',
  cursor: '🔮',
  'kimi-code': '🌙',
  assistant: '🎭',
};

/** 内置 Agent 用品牌 logo；自定义智能体保持 🎭 */
function AgentBrandIcon({ agent, isCustom }) {
  if (isCustom) {
    return <span className="text-sm leading-none">{FALLBACK_ICON.assistant}</span>;
  }
  // Kimi 用组件渲染（与 @lobehub/icons Kimi.Avatar 同构），避免 img 裂图
  if (/kimi|moonshot/i.test(`${agent.id || ''} ${agent.name || ''}`)) {
    return <KimiAvatar size={14} />;
  }
  const brand = resolveBrandIcon(`${agent.id || ''} ${agent.name || ''}`);
  if (brand) {
    return (
      <img
        src={brand}
        alt=""
        className="w-3.5 h-3.5 object-contain"
        draggable={false}
      />
    );
  }
  return <span className="text-sm leading-none">{FALLBACK_ICON[agent.id] || '🤖'}</span>;
}

/** 运行中提示：呼吸绿点 */
function RunningDot({ label = '运行中' }) {
  return (
    <span className="relative inline-flex w-2 h-2 shrink-0" title={label} aria-label={label}>
      <span className="absolute inset-0 rounded-full bg-emerald-400/80 animate-ping" />
      <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]" />
    </span>
  );
}

export default function AgentTabBar({
  agents,
  selectedAgent,
  mainAgentId,
  onSelect,
  onSetMainAgent,
  loading,
  /** Set / 数组：正在执行的 session key（含 __hub__） */
  runningKeys,
}) {
  const running = runningKeys instanceof Set
    ? runningKeys
    : new Set(Array.isArray(runningKeys) ? runningKeys : []);
  if (loading) {
    return (
      <aside className="w-44 shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-2 space-y-1.5 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-8 w-full bg-zinc-200/80 dark:bg-zinc-800 rounded-md" />
        ))}
      </aside>
    );
  }

  if (!agents?.length) {
    return (
      <aside className="w-44 shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-3">
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          未检测到可用 Agent CLI，请先在 Gateway 纳管
        </p>
      </aside>
    );
  }

  const mainAgent = agents.find(a => a.id === mainAgentId && !a.custom && a.type !== 'assistant');

  return (
    <aside className="w-44 shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 flex flex-col min-h-0">
      <div className="shrink-0 px-3 pt-2.5 pb-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          智能体
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5">
        {/* 聚合入口 */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`
            w-full flex items-center gap-1.5 text-left px-2.5 py-1.5 text-[13px] font-medium rounded-md transition-colors
            ${!selectedAgent
              ? 'bg-white dark:bg-zinc-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-blue-200/80 dark:ring-blue-800/60'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-white/80 dark:hover:bg-zinc-800/80 hover:text-zinc-900 dark:hover:text-zinc-200'
            }
          `}
        >
          <span className="min-w-0 flex-1 truncate">✨ 聚合入口</span>
          {running.has('__hub__') && <RunningDot label="编排运行中" />}
        </button>
        {mainAgent && !selectedAgent && (
          <p className="px-2.5 pb-1 text-[10px] text-zinc-400 dark:text-zinc-500 leading-snug">
            主：{mainAgent.name} · 编排派发
          </p>
        )}

        <div className="mx-2 my-1.5 border-t border-zinc-200/80 dark:border-zinc-700/80" />

        {agents.map(agent => {
          const active = selectedAgent?.id === agent.id;
          const isMain = agent.id === mainAgentId && !agent.custom;
          const isCustom = agent.custom || agent.type === 'assistant';
          const isRunning = running.has(agent.id);
          return (
            <div key={agent.id} className="relative group">
              <button
                type="button"
                onClick={() => onSelect(agent)}
                title={
                  isCustom && agent.runtimeName
                    ? (agent.execRuntimeName && agent.execRuntimeName !== agent.runtimeName
                      ? `投射：${agent.runtimeName}（执行：${agent.execRuntimeName}）`
                      : `投射：${agent.runtimeName}`)
                    : agent.description
                }
                className={`
                  w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] font-medium rounded-md transition-colors
                  ${active
                    ? 'bg-white dark:bg-zinc-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-blue-200/80 dark:ring-blue-800/60'
                    : 'text-zinc-600 dark:text-zinc-400 hover:bg-white/80 dark:hover:bg-zinc-800/80 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }
                `}
              >
                <span className="relative shrink-0 flex items-center justify-center w-3.5 h-3.5">
                  <AgentBrandIcon agent={agent} isCustom={isCustom} />
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-1 min-w-0 leading-tight">
                    <span className="truncate">{agent.name}</span>
                    {isMain && (
                      <span className="shrink-0 text-[10px] text-amber-500" title="主 Agent">★</span>
                    )}
                  </span>
                  {(isCustom && agent.runtimeName) || (!isCustom && agent.version) ? (
                    <span className="block text-[10px] text-zinc-400 dark:text-zinc-500 font-normal truncate mt-0.5 leading-tight">
                      {isCustom && agent.runtimeName ? `→ ${agent.runtimeName}` : `v${agent.version}`}
                    </span>
                  ) : null}
                </span>
                {isRunning && <RunningDot label={`${agent.name} 运行中`} />}
              </button>
              {!isMain && !isCustom && onSetMainAgent && (
                <button
                  type="button"
                  title={`设 ${agent.name} 为主 Agent`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetMainAgent(agent);
                  }}
                  className="absolute top-1 right-1 w-4 h-4 text-[10px] leading-none rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 text-zinc-400 hover:text-amber-500 hover:border-amber-400 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ☆
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 紧凑底栏：仅在直调其他 Agent 时提示主 Agent */}
      {mainAgent && selectedAgent && (
        <div className="shrink-0 px-2.5 py-2 border-t border-zinc-200/80 dark:border-zinc-800 text-[10px] text-zinc-400 dark:text-zinc-500">
          主 Agent · {mainAgent.name}
        </div>
      )}
    </aside>
  );
}
