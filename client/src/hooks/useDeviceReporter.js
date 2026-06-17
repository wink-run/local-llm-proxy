// client/src/hooks/useDeviceReporter.js
// Registers the current device with the backend and sends periodic heartbeats.
// Runs in the renderer where the JWT (localStorage 'token') is available.
import { useEffect, useRef } from 'react';
import { isElectron, getGateway, getConfig } from '../api/adapter';
import { registerDevice, heartbeatDevice } from '../api/client';

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60s（服务端 2 分钟无心跳会标离线，须小于该阈值）
const RECONNECT_INTERVAL_MS = 30 * 1000;      // retry interval while offline
const MAX_FAILURES_BEFORE_RECONNECT = 2;       // failures before trying re-register

// Module-level singleton — prevents concurrent registrations.
// Keyed by user id so a real user-switch still re-registers.
let _registeredForUserId = null;
let _registrationPromise = null;
let _deviceId            = null;
let _heartbeatTimer      = null;
let _consecutiveFailures = 0;
let _reregistering       = false; // guard against concurrent re-register attempts

/** 生成稳定的本地设备 ID（仅首次无记录时调用一次） */
function _generateDeviceId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'dev-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 解析并持久化设备 ID：localStorage → config.json → 新生成。
 * 避免每次启动因 localStorage 为空而向服务端注册新设备。
 */
async function _resolveDeviceId(port, cfg) {
  const storageKey = `llm_gateway_device_id_${port}`;
  let id = (localStorage.getItem(storageKey) || cfg?.device_id || '').trim();
  if (!id) {
    id = _generateDeviceId();
    localStorage.setItem(storageKey, id);
    await getConfig().write({ ...(cfg || {}), device_id: id }).catch(() => {});
  } else if (!localStorage.getItem(storageKey)) {
    // config 有 ID 但 localStorage 缺失时同步回写
    localStorage.setItem(storageKey, id);
  }
  return { id, storageKey };
}

async function _doRegister() {
  try {
    // Fetch actual gateway port — each CLI instance runs on a different port,
    // so use port-scoped localStorage key and name to distinguish them.
    const gwStatus = await getGateway().status().catch(() => null);
    const port     = gwStatus?.port || 11430;

    const cfg = await getConfig().read().catch(() => ({}));
    const { id: storedId, storageKey } = await _resolveDeviceId(port, cfg);

    const type     = isElectron() ? 'desktop' : 'cli';
    const platform = navigator.platform || navigator.userAgent || '';
    const version  = cfg?.version || '1.0.0';
    // CLI instances always append port so multiple instances on the same machine are distinguishable.
    // Electron is a single instance so just use the configured name (or fallback "Desktop").
    const baseName = cfg?.name || (isElectron() ? 'Desktop' : 'CLI');
    const name     = isElectron() ? baseName : `${baseName}:${port}`;

    const res   = await registerDevice({ device_id: storedId, type, name, platform, version, gateway_port: port });
    // Backend returns the devices table row: primary key column is "id", not "device_id"
    const newId = res.data?.id || res.data?.device_id;
    if (!newId) return;
    _deviceId = newId;
    // Persist immediately to localStorage so next refresh reuses the same row
    localStorage.setItem(storageKey, newId);
    // Also write to config file as best-effort backup
    if (newId !== cfg?.device_id) {
      getConfig().write({ ...(cfg || {}), device_id: newId }).catch(() => {});
    }
  } catch {
    // Not logged in, backend down — silent
  }
}

/** 采集本机 1/7/30 天盘点快照，随心跳上报云端 */
async function _collectInventory() {
  const query = window.electronAPI?.localStats?.query;
  if (query) {
    const [d1, d7, d30] = await Promise.all([
      query(1).catch(() => null),
      query(7).catch(() => null),
      query(30).catch(() => null),
    ]);
    const inv = {};
    if (d1) inv['1'] = d1;
    if (d7) inv['7'] = d7;
    if (d30) inv['30'] = d30;
    return inv;
  }
  const d1 = await getGateway().getDailyStats().catch(() => ({}));
  return d1?.total_calls != null ? { '1': d1 } : {};
}

async function _sendHeartbeat() {
  if (!_deviceId) return;
  try {
    const inv = await _collectInventory();
    const d1 = inv['1'] || {};
    await heartbeatDevice(_deviceId, {
      calls            : d1?.total_calls  || 0,
      errors           : 0,  // not tracked in local stats
      providers_active : (d1?.providers || []).length,
      inventory        : inv,
    });
    // Successful heartbeat — reset failure counter
    _consecutiveFailures = 0;
  } catch {
    // Heartbeat failed — count failures and attempt re-registration once threshold reached
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= MAX_FAILURES_BEFORE_RECONNECT && !_reregistering) {
      _reregistering = true;
      _doRegister().then(() => {
        _reregistering       = false;
        _consecutiveFailures = 0;
        // Immediately send a heartbeat so the device shows online again
        _sendHeartbeat();
      }).catch(() => { _reregistering = false; });
    }
  }
}

export function useDeviceReporter(user) {
  const timerRef = useRef(null);

  useEffect(() => {
    if (!user) return;

    const uid = user.id;

    // Only one registration per user per module lifetime; concurrent callers
    // wait on the same promise and share the resulting _deviceId.
    if (_registeredForUserId !== uid) {
      _registeredForUserId = uid;
      _deviceId            = null;
      _consecutiveFailures = 0;
      _registrationPromise = _doRegister();
    }

    let active = true;

    _registrationPromise.then(() => {
      if (!active) return;
      // Immediate heartbeat → device shows online right away
      _sendHeartbeat();
      // Periodic heartbeat — one global timer
      if (!_heartbeatTimer) {
        _heartbeatTimer = setInterval(_sendHeartbeat, HEARTBEAT_INTERVAL_MS);
      }
      timerRef.current = _heartbeatTimer;
    });

    return () => { active = false; };
  }, [user?.id]);
}
