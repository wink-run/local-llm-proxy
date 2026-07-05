// Agent 顶部标签栏：聚合入口 + 各 Agent 分 tab；可指定主 Agent（编排层）
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
      <div className="flex gap-2 animate-pulse">
        {[1, 2].map(i => (
          <div key={i} className="h-9 w-28 bg-zinc-100 dark:bg-zinc-800 rounded-lg" />
        ))}
      </div>
    );
  }

  if (!agents?.length) {
    return (
      <div className="text-xs text-zinc-500 dark:text-zinc-400 py-1">
        未检测到可用 Agent CLI，请先在 Gateway 纳管
      </div>
    );
  }

  const mainAgent = agents.find(a => a.id === mainAgentId && !a.custom && a.type !== 'assistant');

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
        {/* 聚合入口：由主 Agent 负责编排（后续通过 MCP 派发子任务） */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`
            shrink-0 px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
            ${!selectedAgent
              ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50/60 dark:bg-blue-900/20'
              : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
            }
          `}
        >
          ✨ 聚合入口
        </button>

        <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 shrink-0 mx-1" />

        {agents.map(agent => {
          const active = selectedAgent?.id === agent.id;
          const isMain = agent.id === mainAgentId && !agent.custom;
          const isCustom = agent.custom || agent.type === 'assistant';
          return (
            <div key={agent.id} className="relative shrink-0 flex items-center group">
              <button
                type="button"
                onClick={() => onSelect(agent)}
                title={isCustom && agent.runtimeName ? `运行时：${agent.runtimeName}` : agent.description}
                className={`
                  flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
                  ${active
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50/60 dark:bg-blue-900/20'
                    : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
                  }
                `}
              >
                <span>{isCustom ? AGENT_ICONS.assistant : (AGENT_ICONS[agent.id] || '🤖')}</span>
                <span>{agent.name}</span>
                {isMain && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400" title="主 Agent">★</span>
                )}
                {isCustom && agent.runtimeName && (
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-normal">
                    →{agent.runtimeName}
                  </span>
                )}
                {!isCustom && agent.version && (
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-normal">
                    v{agent.version}
                  </span>
                )}
              </button>
              {!isMain && !isCustom && onSetMainAgent && (
                <button
                  type="button"
                  title={`设 ${agent.name} 为主 Agent`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetMainAgent(agent);
                  }}
                  className="absolute -top-1 -right-1 w-4 h-4 text-[10px] leading-none rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 text-zinc-400 hover:text-amber-500 hover:border-amber-400 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ☆
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 主 Agent 说明 */}
      {mainAgent && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          主 Agent（编排层）：<span className="font-medium text-zinc-700 dark:text-zinc-300">{mainAgent.name}</span>
          <span className="mx-1">·</span>
          聚合入口将由此 Agent 接收任务并协调其他 Agent
        </p>
      )}
    </div>
  );
}
