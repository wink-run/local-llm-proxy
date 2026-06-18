// client/src/api/agentControl.js
// 贡献页 Agent 启停：Electron IPC 或 Docker admin-api
import { isElectron } from './adapter';

const ADMIN_BASE = import.meta.env?.VITE_ADMIN_BASE ?? '';

async function adminFetch(path, options = {}) {
  const method = options.method || 'GET';
  const hasBody = options.body !== undefined;
  const res = await fetch(ADMIN_BASE + path, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body: hasBody ? options.body : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch {}
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getAgentStatus() {
  if (isElectron() && window.electronAPI?.agent) {
    return window.electronAPI.agent.getStatus();
  }
  return adminFetch('/api/agent/status');
}

export async function startAgent() {
  if (isElectron() && window.electronAPI?.agent) {
    return window.electronAPI.agent.start();
  }
  return adminFetch('/api/agent/start', { method: 'POST', body: '{}' });
}

export async function stopAgent() {
  if (isElectron() && window.electronAPI?.agent) {
    return window.electronAPI.agent.stop();
  }
  return adminFetch('/api/agent/stop', { method: 'POST', body: '{}' });
}

export async function getAgentLogs() {
  if (isElectron() && window.electronAPI?.agent?.getLogs) {
    return window.electronAPI.agent.getLogs();
  }
  const r = await adminFetch('/api/agent/logs');
  return r.logs || [];
}

/** Electron 订阅事件；HTTP 模式返回 null（由页面轮询） */
export function subscribeAgentEvents({ onStatus, onLog } = {}) {
  if (!isElectron() || !window.electronAPI?.agent) return null;
  const offStatus = window.electronAPI.agent.onStatus?.(onStatus);
  const offLog    = window.electronAPI.agent.onLog?.(onLog);
  return () => { offStatus?.(); offLog?.(); };
}

export function useAgentPolling() {
  return !isElectron() || !window.electronAPI?.agent;
}
