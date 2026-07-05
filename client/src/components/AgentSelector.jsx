// client/src/components/AgentSelector.jsx
// Agent 选择器组件
import React from 'react';

export default function AgentSelector({ agents, selectedAgent, onSelect, loading }) {
  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-20 bg-zinc-100 dark:bg-zinc-800 rounded-lg"></div>
        ))}
      </div>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-500 dark:text-zinc-400">
        <p>未检测到可用的 Agent</p>
        <p className="text-sm mt-2">请先在 Gateway 页面纳管 Agent</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
        选择 Agent:
      </h3>
      {agents.map(agent => (
        <button
          key={agent.id}
          onClick={() => onSelect(agent)}
          className={`
            w-full text-left p-4 rounded-lg border-2 transition-all
            ${selectedAgent?.id === agent.id
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
            }
          `}
        >
          <div className="flex items-start gap-3">
            <div className="text-2xl">🤖</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {agent.name}
                </span>
                {agent.status === 'active' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                    已纳管
                  </span>
                )}
              </div>
              <div className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                {agent.capabilities?.join(', ') || 'code, chat, edit'}
              </div>
              {agent.version && (
                <div className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                  v{agent.version}
                </div>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
