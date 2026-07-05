// client/src/components/ExecutionResult.jsx
// Agent 执行结果组件
import React from 'react';

export default function ExecutionResult({ result, task }) {
  if (!result) return null;

  const success = result.success !== false;
  const duration = task?.completed_at && task?.started_at
    ? ((task.completed_at - task.started_at) / 1000).toFixed(1)
    : null;

  return (
    <div className="space-y-4">
      {/* 状态标题 */}
      <div className={`
        flex items-center gap-2 p-4 rounded-lg
        ${success 
          ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
          : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
        }
      `}>
        <span className="text-2xl">{success ? '✅' : '❌'}</span>
        <span className="font-medium">{success ? '任务完成' : '任务失败'}</span>
      </div>

      {/* 错误信息 */}
      {!success && task?.error && (
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <div className="text-sm font-medium text-red-700 dark:text-red-400 mb-2">
            错误信息:
          </div>
          <div className="text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">
            {task.error}
          </div>
        </div>
      )}

      {/* 修改的文件 */}
      {result.files && result.files.length > 0 && (
        <div className="p-4 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
          <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
            修改的文件 ({result.files.length}):
          </div>
          <div className="space-y-2">
            {result.files.map((file, index) => (
              <div key={index} className="flex items-center gap-2 text-sm">
                <span className="text-zinc-500 dark:text-zinc-400">
                  {file.operation === 'created' ? '📝' : file.operation === 'modified' ? '✏️' : '📄'}
                </span>
                <span className="text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {file.path || file.file_path}
                </span>
                {file.operation && (
                  <span className={`
                    px-1.5 py-0.5 rounded text-xs
                    ${file.operation === 'created' 
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    }
                  `}>
                    {file.operation === 'created' ? '新建' : '修改'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 执行统计 */}
      <div className="p-4 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
          执行统计:
        </div>
        <div className="grid grid-cols-2 gap-3">
          {duration && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 dark:text-zinc-400">⏱️</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">耗时:</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {duration}s
              </span>
            </div>
          )}
          
          {result.tokens && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 dark:text-zinc-400">🔤</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Tokens:</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {result.tokens.input || 0} + {result.tokens.output || 0}
              </span>
            </div>
          )}
          
          {result.cost && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 dark:text-zinc-400">💰</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">成本:</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                ${result.cost.toFixed(4)}
              </span>
            </div>
          )}
          
          {result.stepCount && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 dark:text-zinc-400">📊</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">步骤:</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {result.stepCount} 个
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
