// Agent 左侧竖排列表：聚合入口 + 各 Agent；可指定主 Agent（编排层）
import React from 'react';

const AGENT_ICONS = {
  'claude-code': '🤖',
  codex: '💻',
  assistant: '🎭',
};

export default function AgentTabBar({
  agents,
  selectedAgent,
  mainAgentId,
  onSelect,
  onSetMainAgent,
  loading,
}) {
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
            w-full text-left px-2.5 py-1.5 text-[13px] font-medium rounded-md transition-colors
            ${!selectedAgent
              ? 'bg-white dark:bg-zinc-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-blue-200/80 dark:ring-blue-800/60'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-white/80 dark:hover:bg-zinc-800/80 hover:text-zinc-900 dark:hover:text-zinc-200'
            }
          `}
        >
          ✨ 聚合入口
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
          return (
            <div key={agent.id} className="relative group">
              <button
                type="button"
                onClick={() => onSelect(agent)}
                title={isCustom && agent.runtimeName ? `运行时：${agent.runtimeName}` : agent.description}
                className={`
                  w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] font-medium rounded-md transition-colors
                  ${active
                    ? 'bg-white dark:bg-zinc-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-blue-200/80 dark:ring-blue-800/60'
                    : 'text-zinc-600 dark:text-zinc-400 hover:bg-white/80 dark:hover:bg-zinc-800/80 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }
                `}
              >
                <span className="shrink-0 text-sm leading-none">
                  {isCustom ? AGENT_ICONS.assistant : (AGENT_ICONS[agent.id] || '🤖')}
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate leading-tight">
                    {agent.name}
                    {isMain && (
                      <span className="ml-0.5 text-[10px] text-amber-500" title="主 Agent">★</span>
                    )}
                  </span>
                  {(isCustom && agent.runtimeName) || (!isCustom && agent.version) ? (
                    <span className="block text-[10px] text-zinc-400 dark:text-zinc-500 font-normal truncate mt-0.5 leading-tight">
                      {isCustom && agent.runtimeName ? `→ ${agent.runtimeName}` : `v${agent.version}`}
                    </span>
                  ) : null}
                </span>
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
