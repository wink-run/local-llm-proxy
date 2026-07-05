// client/src/components/ExecutionLog.jsx
// Agent 执行日志组件
import React, { useEffect, useRef } from 'react';

const STEP_ICONS = {
  thinking: '🤔',
  tool_call: '🔧',
  code_edit: '✏️',
  terminal: '🏃',
  output: '📄',
};

export default function ExecutionLog({ steps, status }) {
  const endRef = useRef(null);

  useEffect(() => {
    // 自动滚动到最新步骤
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps]);

  if (!steps || steps.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-400 dark:text-zinc-500">
        等待执行...
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {steps.map((step, index) => (
        <div
          key={index}
          className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50"
        >
          <span className="text-lg shrink-0">
            {STEP_ICONS[step.stepType] || '📄'}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                [{formatTime(step.timestamp)}]
              </span>
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase">
                {step.stepType}
              </span>
            </div>
            <div className="text-sm text-zinc-700 dark:text-zinc-300 mt-1 whitespace-pre-wrap break-words">
              {step.content}
            </div>
            {step.tool_name && (
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Tool: {step.tool_name}
              </div>
            )}
          </div>
        </div>
      ))}
      
      {status === 'running' && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent"></div>
          <span className="text-sm text-blue-600 dark:text-blue-400">执行中...</span>
        </div>
      )}
      
      <div ref={endRef} />
    </div>
  );
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
}
