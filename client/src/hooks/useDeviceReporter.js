// client/src/hooks/useDeviceReporter.js
// Registers the current device with the backend and sends periodic heartbeats.
// Runs in the renderer where the JWT (localStorage 'token') is available.
import { useEffect, useRef } from 'react';
import { isElectron, getGateway, getConfig } from '../api/adapter';
import { registerDevice, heartbeatDevice } from '../api/client';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function useDeviceReporter(user) {
  const deviceIdRef = useRef(null);
  const timerRef   = useRef(null);

  useEffect(() => {
    // Only run when logged in
    if (!user) return;

    let cancelled = false;

    async function register() {
      try {
        // Read existing device_id from agent config (main process or HTTP)
        const cfg = await getConfig().read().catch(() => ({}));
        const existingId = cfg?.device_id || null;

        // Detect environment
        const type     = isElectron() ? 'desktop' : 'cli';
        const platform = navigator.userAgent || navigator.platform || '';
        const version  = cfg?.version || '1.0.0';
        const name     = cfg?.name    || (isElectron() ? 'Desktop' : 'CLI');

        const res = await registerDevice({
          device_id    : existingId || '',
          type,
          name,
          platform,
          version,
          gateway_port : 11430,
        });

        if (cancelled) return;
        const newId = res.data?.device_id;
        if (!newId) return;
        deviceIdRef.current = newId;

        // Persist device_id back if it changed
        if (newId !== existingId) {
          getConfig().write({ ...(cfg || {}), device_id: newId }).catch(() => {});
        }
      } catch {
        // Not logged in, backend down, etc — silent
      }
    }

    async function sendHeartbeat() {
      const id = deviceIdRef.current;
      if (!id) return;
      try {
        const s = await getGateway().getDailyStats().catch(() => ({}));
        await heartbeatDevice(id, {
          calls            : s?.calls  || 0,
          errors           : s?.errors || 0,
          providers_active : Object.keys(s?.by_provider || {}).length,
        });
      } catch {
        // Heartbeat is best-effort
      }
    }

    register().then(() => {
      if (cancelled) return;
      // Start periodic heartbeat
      timerRef.current = setInterval(() => {
        sendHeartbeat();
      }, HEARTBEAT_INTERVAL_MS);
    });

    return () => {
      cancelled = true;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [user?.id]); // re-run only when user identity changes
}
