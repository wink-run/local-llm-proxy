import React from 'react';
import { useUpdater } from '../store/updater';

/** 底部弹窗：下载进度 + 立即重启；点「稍后」后由侧栏标识承接 */
export default function UpdateNotification() {
  const updater = useUpdater();
  if (!updater) return null;

  const { phase, version, percent, install, dismissToast } = updater;
  if (phase === 'idle' || phase === 'dismissed') return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm pointer-events-none">
      <div className="tb-sheet tb-enter pointer-events-auto mx-4 rounded-xl px-5 py-4">
        {phase === 'downloading' && (
          <>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
              正在下载更新 {version && <span className="text-gray-500">v{version}</span>}
            </p>
            <div className="mt-2 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-400">{percent}%</p>
          </>
        )}

        {phase === 'ready' && (
          <>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
              Token Bank <span className="text-blue-500">v{version}</span> 已准备好安装
            </p>
            <p className="mt-0.5 text-xs text-gray-500">重启后即可完成更新</p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={install}
                className="tb-press flex-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white text-sm font-medium py-1.5"
              >
                立即重启
              </button>
              <button
                onClick={dismissToast}
                className="tb-press flex-1 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 text-sm font-medium py-1.5"
              >
                稍后
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
