// client/src/hooks/useDeviceReporter.js
// Registers the current device with the backend and sends periodic heartbeats.
// Runs in the renderer where the JWT (localStorage 'token') is available.
import { useEffect, useRef } from 'react';
import { isElectron, getGateway, getConfig } from '../api/adapter';
import { registerDevice, heartbeatDevice } from '../api/client';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
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

async function _doRegister() {
  try {
    const cfg        = await getConfig().read().catch(() => ({}));
    const existingId = cfg?.device_id || null;
    const type       = isElectron() ? 'desktop' : 'cli';
    const platform   = navigator.platform || navigator.userAgent || '';
    const version    = cfg?.version || '1.0.0';
    const name       = cfg?.name    || (isElectron() ? 'Desktop' : 'CLI');

    const res   = await registerDevice({ device_id: existingId || '', type, name, platform, version, gateway_port: 11430 });
    const newId = res.data?.device_id;
    if (!newId) return;
    _deviceId = newId;
    if (newId !== existingId) {
      getConfig().write({ ...(cfg || {}), device_id: newId }).catch(() => {});
    }
  } catch {
    // Not logged in, backend down — silent
  }
}

async function _sendHeartbeat() {
  if (!_deviceId) return;
  try {
    const s = await getGateway().getDailyStats().catch(() => ({}));
    await heartbeatDevice(_deviceId, {
      calls            : s?.calls  || 0,
      errors           : s?.errors || 0,
      providers_active : Object.keys(s?.by_provider || {}).length,
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
