import type { CloudConnectivitySnapshot } from '../providers/cloud/cloudConnectivity';

export type GlobalSyncStatus = 'fresh' | 'syncing' | 'cached' | 'failed';

export interface GlobalRefreshSnapshot {
  mode: string;
  busy: boolean;
  errorAt: number | null;
  lastCompletedAt: number | null;
  message: string;
}

export const GLOBAL_SYNC_LABELS: Record<GlobalSyncStatus, string> = {
  fresh: '已同步',
  syncing: '同步中…',
  cached: '顯示快取資料',
  failed: '同步失敗',
};

export function resolveGlobalSyncStatus(
  mode: string,
  connectivity: CloudConnectivitySnapshot,
  refresh: GlobalRefreshSnapshot,
): GlobalSyncStatus {
  if (refresh.busy) return 'syncing';
  const cloudMode = mode === 'cloud' || mode === 'fallback';
  if (refresh.errorAt !== null && (!cloudMode || (connectivity.lastFreshReadAt ?? 0) <= refresh.errorAt)) return 'failed';
  if (!cloudMode) return 'fresh';
  if (connectivity.readStatus === 'fresh-online' || connectivity.readStatus === 'fresh-empty') return 'fresh';
  // The four-second bootstrap boundary is soft: the authoritative pull remains
  // in flight. Cached rows are visible, but the existing write guard stays closed.
  if (connectivity.reason?.includes('Cloud sync timed out after 4000ms')) {
    return connectivity.readStatus === 'stale-cache' ? 'cached' : 'syncing';
  }
  if (connectivity.readStatus === 'offline') return 'cached';
  if (connectivity.readStatus === 'stale-cache') return connectivity.reason ? 'failed' : 'cached';
  if (connectivity.readStatus === 'loading' || connectivity.status === 'checking') return 'syncing';
  return 'failed';
}
