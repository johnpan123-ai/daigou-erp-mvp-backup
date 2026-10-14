import type { CloudConnectivitySnapshot } from '../providers/cloud/cloudConnectivity';

export type GlobalSyncStatus = 'local' | 'fresh' | 'syncing' | 'syncing-cached' | 'cached' | 'failed';

export interface GlobalRefreshSnapshot {
  mode: string;
  busy: boolean;
  errorAt: number | null;
  lastCompletedAt: number | null;
  message: string;
  restorePending?: boolean;
}

export interface GlobalSyncPresentation {
  status: GlobalSyncStatus;
  label: string;
  banner: string | null;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  writeAllowed: boolean;
  /** C1f: the banner offers an immediate Realtime reconnect (which must still prove completeness). */
  action?: 'realtime-reconnect';
}

export const GLOBAL_SYNC_LABELS: Record<GlobalSyncStatus, string> = {
  local: '本機資料',
  fresh: '已同步',
  syncing: '同步中…',
  'syncing-cached': '背景同步中・顯示快取',
  cached: '離線・顯示快取',
  failed: '同步失敗',
};

/**
 * C1d: Realtime could not prove postgres_changes listening (or its catch-up / channel was
 * interrupted). This is not a read failure: rows shown are the last cache and may be out of
 * date. Presentation only — Fresh, the write gate (assertCloudWriteAllowed) and the
 * Realtime contract are unchanged; writes stay paused until completeness is proven again.
 */
export const REALTIME_UNPROVEN_LABEL = '即時同步未確認・唯讀';
/** C1f (A4): unproven, read-only, possibly stale, recovery in progress, manual reconnect available. */
export const REALTIME_UNPROVEN_BANNER = '即時同步目前未確認｜目前為唯讀模式：畫面上的資料可能不是最新；新增、修改、刪除與匯入已暫停，尚未送出的變更不會被視為已儲存。系統正在自動嘗試恢復連線，也可以按「立即重新連線」。';

const isRealtimeUnproven = (connectivity: CloudConnectivitySnapshot): boolean =>
  typeof connectivity.reason === 'string'
  && connectivity.reason.startsWith('realtime-')
  && (connectivity.readStatus === 'stale-cache' || connectivity.readStatus === 'offline');

/** C1f: Realtime completeness evidence from the sync boundary (presentation input only). */
export interface RealtimeCompletenessView {
  /** The completeness hold is in its unproven phase (pending limit passed, channel error, recovery). */
  unproven: boolean;
}

const realtimeUnprovenView = (): GlobalSyncPresentation => ({
  status: 'cached', label: REALTIME_UNPROVEN_LABEL, tone: 'warning', writeAllowed: false,
  banner: REALTIME_UNPROVEN_BANNER, action: 'realtime-reconnect',
});

export function resolveGlobalSyncPresentation(
  mode: string,
  connectivity: CloudConnectivitySnapshot,
  refresh: GlobalRefreshSnapshot,
  realtime?: RealtimeCompletenessView,
): GlobalSyncPresentation {
  const cloudMode = mode === 'cloud' || mode === 'fallback';
  if (!cloudMode) return { status: 'local', label: GLOBAL_SYNC_LABELS.local, banner: null, tone: 'neutral', writeAllowed: true };

  const fresh = connectivity.readStatus === 'fresh-online' || connectivity.readStatus === 'fresh-empty';
  const cached = connectivity.readStatus === 'stale-cache' || connectivity.readStatus === 'offline';
  const refreshFailed = refresh.errorAt !== null && (connectivity.lastFreshReadAt ?? 0) <= refresh.errorAt;

  if (refresh.restorePending) {
    return {
      status: cached ? 'syncing-cached' : 'syncing',
      label: cached ? GLOBAL_SYNC_LABELS['syncing-cached'] : GLOBAL_SYNC_LABELS.syncing,
      tone: 'warning', writeAllowed: false,
      banner: '雲端還原進行中｜等待完整性與最新畫面驗證；寫入已暫停',
    };
  }

  // C1f (A3/A4): an unproven Realtime generation stays visibly read-only while its recovery
  // reads run; it can never be shown as synced (Fresh is withheld by the same hold).
  if (realtime?.unproven && !fresh) return realtimeUnprovenView();

  if (refresh.busy || connectivity.authoritativeReadPending) {
    if (cached) {
      return {
        status: 'syncing-cached', label: GLOBAL_SYNC_LABELS['syncing-cached'], tone: 'warning', writeAllowed: false,
        banner: '雲端背景同步中｜目前顯示上次快取；寫入已暫停',
      };
    }
    return {
      status: 'syncing', label: GLOBAL_SYNC_LABELS.syncing, tone: 'warning', writeAllowed: fresh,
      banner: fresh ? null : '雲端資料同步中｜等待最新資料；寫入已暫停',
    };
  }

  if (fresh && !refreshFailed) {
    return {
      status: 'fresh', label: GLOBAL_SYNC_LABELS.fresh, tone: 'success', writeAllowed: true,
      banner: connectivity.readStatus === 'fresh-empty' ? '雲端已確認｜目前沒有資料' : null,
    };
  }
  if (isRealtimeUnproven(connectivity)) return realtimeUnprovenView();
  if (connectivity.status === 'offline' || connectivity.readStatus === 'offline') {
    return {
      status: 'cached', label: GLOBAL_SYNC_LABELS.cached, tone: 'warning', writeAllowed: false,
      banner: 'Offline｜顯示最後雲端快取，所有新增、修改、刪除與匯入已停用',
    };
  }
  if (connectivity.readStatus === 'stale-cache') {
    return {
      status: 'failed', label: '同步失敗・顯示快取', tone: 'danger', writeAllowed: false,
      banner: '雲端讀取失敗｜目前顯示舊快取，資料不是最新；寫入已暫停',
    };
  }
  return {
    status: 'failed', label: GLOBAL_SYNC_LABELS.failed, tone: 'danger', writeAllowed: false,
    banner: '雲端讀取失敗｜目前沒有可確認的最新資料；寫入已暫停',
  };
}

export function resolveGlobalSyncStatus(
  mode: string,
  connectivity: CloudConnectivitySnapshot,
  refresh: GlobalRefreshSnapshot,
): GlobalSyncStatus {
  return resolveGlobalSyncPresentation(mode, connectivity, refresh).status;
}
