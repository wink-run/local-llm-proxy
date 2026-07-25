import React, { useEffect, useMemo, useState } from 'react';
import { matchPath, Navigate, useLocation } from 'react-router-dom';

/** 按路由配置校验登录/游客权限 */
function PageGate({ config, user, guest, children }) {
  const location = useLocation();
  if (config.requireUser && !user) {
    return <Navigate to="/login" replace />;
  }
  if (config.requireLogin && !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (config.requireAuthed && !(user || guest)) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function findRouteConfig(configs, pathname) {
  for (const cfg of configs) {
    const end = cfg.end ?? !String(cfg.path).includes(':');
    if (matchPath({ path: cfg.path, end }, pathname)) return cfg;
  }
  return null;
}

function matchRouteParams(cfg, pathname) {
  if (!cfg) return {};
  const end = cfg.end ?? !String(cfg.path).includes(':');
  return matchPath({ path: cfg.path, end }, pathname)?.params || {};
}

/**
 * 已访问过的页面保持挂载，切换菜单时用 hidden 隐藏而非 unmount，保留组件 state。
 * 组件始终保留在树中（含跳转登录页时），避免缓存被卸载。
 *
 * 注意：缓存页的 useParams() 会跟着「当前 URL」变，动态段会漂移。
 * 因此把「该缓存 key 对应的 params」经 routeParams 传入，供详情页使用稳定 id。
 */
export default function KeepAliveRoutes({ configs, user, guest }) {
  const location = useLocation();
  const [visitedKeys, setVisitedKeys] = useState([]);

  const activeConfig = useMemo(
    () => findRouteConfig(configs, location.pathname),
    [configs, location.pathname],
  );
  const activeKey = location.pathname;

  useEffect(() => {
    if (!activeConfig) return;
    setVisitedKeys(prev => (prev.includes(activeKey) ? prev : [...prev, activeKey]));
  }, [activeConfig, activeKey]);

  // 首次进入时 useEffect 尚未跑完，也要立刻挂载当前页
  const keysToRender = useMemo(() => {
    if (!activeConfig) return visitedKeys;
    return visitedKeys.includes(activeKey) ? visitedKeys : [...visitedKeys, activeKey];
  }, [visitedKeys, activeConfig, activeKey]);

  if (!keysToRender.length) return null;

  return (
    <>
      {keysToRender.map(key => {
        const cfg = findRouteConfig(configs, key);
        if (!cfg) return null;

        const { Component } = cfg;
        const isActive = key === activeKey && !!activeConfig;
        const routeParams = matchRouteParams(cfg, key);

        return (
          <div
            key={key}
            className={isActive ? 'h-full min-h-0' : 'hidden'}
            aria-hidden={!isActive}
          >
            <PageGate config={cfg} user={user} guest={guest}>
              <Component routePath={key} routeParams={routeParams} />
            </PageGate>
          </div>
        );
      })}
    </>
  );
}

export { findRouteConfig };
