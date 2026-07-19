// 历史会话面板：浏览并恢复本地/DB 中的 Agent 对话记录
import React, { useCallback, useEffect, useState } from 'react';
import {
  deleteAgentSessionSnapshot,
  formatSessionTime,
  listAgentSessionSnapshots,
} from '../lib/debug-session-history';
import { stepsFromTaskStatus } from '../lib/debug-agent-store';
import { useLang } from '../store/lang';

function taskMatchesSessionKey(task, sessionKey) {
  const ctx = task?.context || {};
  const sk = ctx.sessionKey || task?.agent_id;
  if (sessionKey === '__hub__') {
    return sk === '__hub__' || ctx.mode === 'orchestrator';
  }
  return sk === sessionKey;
}

export default function AgentSessionHistoryPanel({
  open,
  onClose,
  agentKey,
  agentLabel,
  listAgentId,
  onRestore,
}) {
  const { t } = useLang();
  const [localItems, setLocalItems] = useState([]);
  const [dbItems, setDbItems] = useState([]);
  const [loadingDb, setLoadingDb] = useState(false);

  const refreshLocal = useCallback(() => {
    setLocalItems(listAgentSessionSnapshots(agentKey));
  }, [agentKey]);

  const loadDbTasks = useCallback(async () => {
    if (!open || !window.electronAPI?.agent?.listRecentTasks || !listAgentId) {
      setDbItems([]);
      return;
    }
    setLoadingDb(true);
    try {
      const res = await window.electronAPI.agent.listRecentTasks({ agentId: listAgentId, limit: 25 });
      if (!res.success || !res.tasks?.length) {
        setDbItems([]);
        return;
      }
      const untitled = t('debug.history.untitled');
      const localTaskIds = new Set(
        listAgentSessionSnapshots(agentKey).flatMap(
          it => (it.conversationTurns || []).map(tr => tr.taskId).filter(Boolean),
        ),
      );
      const rows = res.tasks
        .filter(task => taskMatchesSessionKey(task, agentKey))
        .filter(task => !localTaskIds.has(task.id))
        .map(task => ({
          id: `db_${task.id}`,
          source: 'db',
          taskId: task.id,
          title: String(task.prompt || untitled).trim().slice(0, 52) || untitled,
          savedAt: task.completed_at || task.created_at || Date.now(),
          turnCount: 1,
          status: task.status,
        }));
      setDbItems(rows);
    } catch {
      setDbItems([]);
    } finally {
      setLoadingDb(false);
    }
  }, [open, agentKey, listAgentId, t]);

  useEffect(() => {
    if (!open) return;
    refreshLocal();
    loadDbTasks();
  }, [open, refreshLocal, loadDbTasks]);

  async function handleRestore(item) {
    if (item.source === 'local') {
      onRestore?.({
        conversationTurns: item.conversationTurns || [],
        sessionWorkingDir: item.sessionWorkingDir || '',
        cliSessionId: item.cliSessionId || null,
      });
      onClose?.();
      return;
    }

    // DB 任务：拉取完整步骤后恢复为单轮对话
    if (!item.taskId || !window.electronAPI?.agent?.getTaskStatus) return;
    try {
      const res = await window.electronAPI.agent.getTaskStatus(item.taskId);
      if (!res.success || !res.status) return;
      const status = res.status;
      onRestore?.({
        conversationTurns: [{
          user: status.prompt || item.title,
          steps: stepsFromTaskStatus(status),
          delegations: {},
          result: status.result || null,
          status: status.status === 'cancelled' ? 'failed' : (status.status || 'completed'),
          taskId: status.id,
          timestamp: status.completed_at || status.created_at || Date.now(),
        }],
        sessionWorkingDir: status.context?.workingDir || '',
        cliSessionId: status.result?.cliSessionId || null,
      });
      onClose?.();
    } catch {
      // ignore
    }
  }

  function handleDelete(e, id) {
    e.stopPropagation();
    deleteAgentSessionSnapshot(id);
    refreshLocal();
  }

  if (!open) return null;

  const empty = !localItems.length && !dbItems.length && !loadingDb;

  return (
    <div
      className="electron-no-drag fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md max-h-[75vh] bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl border border-zinc-200 dark:border-zinc-700 shadow-xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('debug.history.title')}</h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">{agentLabel || agentKey}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {empty && (
            <p className="text-center text-sm text-zinc-400 py-10">{t('debug.history.empty')}</p>
          )}

          {localItems.length > 0 && (
            <section className="mb-3">
              <p className="px-2 py-1 text-[10px] font-medium text-zinc-400 uppercase tracking-wide">{t('debug.history.saved')}</p>
              <ul className="space-y-1">
                {localItems.map(item => (
                  <li key={item.id}>
                    {/* 外层用 div，避免嵌套 button 触发 validateDOMNesting */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => handleRestore(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleRestore(item);
                        }
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors group cursor-pointer"
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-zinc-800 dark:text-zinc-200 truncate">{item.title}</p>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            {formatSessionTime(item.savedAt)}
                            {item.turnCount > 1 ? t('debug.history.turns', { n: item.turnCount }) : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          title={t('debug.history.delete')}
                          onClick={e => handleDelete(e, item.id)}
                          className="opacity-0 group-hover:opacity-100 shrink-0 text-zinc-400 hover:text-red-500 text-xs px-1"
                        >
                          {t('debug.history.delete')}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(loadingDb || dbItems.length > 0) && (
            <section>
              <p className="px-2 py-1 text-[10px] font-medium text-zinc-400 uppercase tracking-wide">
                {t('debug.history.recent')}{loadingDb ? t('debug.history.loading') : ''}
              </p>
              <ul className="space-y-1">
                {dbItems.map(item => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => handleRestore(item)}
                      className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                      <p className="text-sm text-zinc-800 dark:text-zinc-200 truncate">{item.title}</p>
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        {formatSessionTime(item.savedAt)}
                        {item.status ? ` · ${item.status}` : ''}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
