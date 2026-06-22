import React, { useEffect, useState } from 'react';

// State machine: idle → downloading → ready → dismissed
export default function UpdateNotification() {
  const [phase, setPhase] = useState('idle');   // idle | downloading | ready | dismissed
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    if (!window.electronAPI?.updater) return;

    const offAvailable = window.electronAPI.updater.onAvailable(({ version: v }) => {
      setVersion(v);
      setPhase('downloading');
    });

    const offProgress = window.electronAPI.updater.onProgress(({ percent: p }) => {
      setPercent(p);
    });

    const offDownloaded = window.electronAPI.updater.onDownloaded(({ version: v }) => {
      setVersion(v);
      setPhase('ready');
    });

    const offError = window.electronAPI.updater.onError(() => {
      setPhase('idle');
    });

    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
    };
  }, []);

  if (phase === 'idle' || phase === 'dismissed') return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm">
      <div className="mx-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg px-5 py-4">
        {phase === 'downloading' && (
          <>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
              正在下载更新 {version && <span className="text-gray-500">v{version}</span>}
            </p>
            <div className="mt-2 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
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
                onClick={() => window.electronAPI.updater.install()}
                className="flex-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white text-sm font-medium py-1.5 transition-colors"
              >
                立即重启
              </button>
              <button
                onClick={() => setPhase('dismissed')}
                className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 text-sm font-medium py-1.5 transition-colors"
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
