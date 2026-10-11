import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useRole } from '../auth/useRole';
import { useGlobalSyncControl } from '../contexts/CloudRealtimeSyncContext';
import { getProviderMode } from '../providers/providerMode';
import { getBuyAnimeFlowPresentation } from '../providers/cloud/buyAnimeImportCoordinator';
import { supabase } from '../providers/cloud/supabaseClient';
import {
  createRestoreOpsScheduler, OPS_SCHEDULER, type OpsGates, type OpsLocks, type RestoreOpsScheduler,
} from '../providers/cloud/cloudRestoreOpsScheduler';

// Read-only observation of the Restore panel's existing per-tab key
// (cloudRestoreSubmit.ts CLOUD_RESTORE_UNRESOLVED_STORAGE_KEY). Never written here.
const UNRESOLVED_RESTORE_KEY = 'erp_cloud_restore_unresolved_attempt';

const gates: { current: OpsGates } = {
  current: { cloud: false, owner: false, syncReady: false, buyAnimeActive: false, onSettingsRoute: false, unresolvedRestore: false },
};
let singleton: RestoreOpsScheduler | null = null;

function browserStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}
function unresolvedRestore(): boolean {
  try { return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(UNRESOLVED_RESTORE_KEY) !== null; }
  catch { return true; } // unknown => treat as Restore activity (stay away)
}

export function getRestoreOpsScheduler(): RestoreOpsScheduler {
  if (singleton) return singleton;
  const locks = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function'
    ? navigator.locks as unknown as OpsLocks : null;
  singleton = createRestoreOpsScheduler({
    now: () => Date.now(),
    clock: () => performance.now(),
    storage: browserStorage(),
    locks,
    rpc: (name, args, signal) => {
      const query = supabase.rpc(name, args);
      return signal ? query.abortSignal(signal) : query;
    },
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    wait: (ms, signal) => new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return; }
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    }),
    onStop: listener => {
      const onVisibility = () => { if (document.visibilityState !== 'visible') listener(); };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', listener);
      window.addEventListener('offline', listener);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', listener);
        window.removeEventListener('offline', listener);
      };
    },
  }, () => ({ ...gates.current, buyAnimeActive: getBuyAnimeFlowPresentation().active, unresolvedRestore: unresolvedRestore() }));
  return singleton;
}

/** Mounted once in AppLayout. Owner + cloud only; fire-and-forget; never blocks rendering or flows. */
export function useRestoreOpsMaintenance(): void {
  const { role } = useRole();
  const { connectivity, refresh } = useGlobalSyncControl();
  const location = useLocation();
  const cloud = getProviderMode() === 'cloud';
  const owner = role === 'owner';
  const onSettingsRoute = location.pathname.startsWith('/settings');
  const syncReady = connectivity.status === 'online' && !connectivity.authoritativeReadPending
    && (connectivity.readStatus === 'fresh-online' || connectivity.readStatus === 'fresh-empty') && !refresh.busy;
  useEffect(() => {
    gates.current = { cloud, owner, onSettingsRoute, syncReady, buyAnimeActive: false, unresolvedRestore: false };
  }, [cloud, owner, onSettingsRoute, syncReady]);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!cloud || !owner) return undefined;
    const scheduler = getRestoreOpsScheduler();
    scheduler.setMounted(true);
    startedAt.current = Date.now();
    const fire = (reason: string) => {
      if (startedAt.current === null || Date.now() - startedAt.current < OPS_SCHEDULER.startupDelayMs) return;
      void scheduler.trigger(reason);
    };
    const startup = setTimeout(() => {
      const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (idle) idle(() => fire('startup'), { timeout: 30_000 }); else fire('startup');
    }, OPS_SCHEDULER.startupDelayMs);
    const tick = setInterval(() => fire('tick'), OPS_SCHEDULER.tickMs);
    const onVisible = () => { if (document.visibilityState === 'visible') fire('visible'); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(startup); clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      scheduler.setMounted(false);
    };
  }, [cloud, owner]);

  useEffect(() => {
    if (!cloud || !owner || !onSettingsRoute) return undefined;
    const scheduler = getRestoreOpsScheduler();
    scheduler.noteSettingsActivity();
    const heartbeat = setInterval(() => scheduler.noteSettingsActivity(), OPS_SCHEDULER.settingsHeartbeatMs);
    return () => { clearInterval(heartbeat); scheduler.noteSettingsActivity(); };
  }, [cloud, owner, onSettingsRoute]);
}
