import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

const UpdaterContext = createContext(null);

/** 桌面端自动更新状态（底部弹窗 + 侧栏待重启标识共用） */
export function UpdaterProvider({ children }) {
  const [phase, setPhase] = useState('idle'); // idle | downloading | ready | dismissed | installing
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);

  const install = useCallback(() => {
    setPhase('installing');
    try {
      window.electronAPI?.updater?.install?.();
    } catch {
      // 主进程会退出；若仍停留在此页，允许再次点击
      setPhase('ready');
    }
  }, []);

  const dismissToast = useCallback(() => {
    setPhase('dismissed');
  }, []);

  const reopenToast = useCallback(() => {
    if (version) setPhase('ready');
  }, [version]);

  // 已下载、用户点「稍后」后仍保留，供侧栏展示
  const pendingVersion =
    version && (phase === 'ready' || phase === 'dismissed' || phase === 'installing')
      ? version
      : null;

  useEffect(() => {
    if (!window.electronAPI?.updater) return;

    // 启动时恢复「已下载待重启」状态（renderer 刷新后仍可见）
    window.electronAPI.updater.getStatus?.().then((s) => {
      if (s?.ready && s.version) {
        setVersion(s.version);
        setPhase('dismissed');
      }
    });

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
      setVersion('');
    });

    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
    };
  }, []);

  return (
    <UpdaterContext.Provider
      value={{
        phase,
        version,
        percent,
        pendingVersion,
        install,
        dismissToast,
        reopenToast,
      }}
    >
      {children}
    </UpdaterContext.Provider>
  );
}

export function useUpdater() {
  return useContext(UpdaterContext);
}
