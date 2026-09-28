import type { CloudConnectivitySnapshot } from '../providers/cloud/cloudConnectivity';

export type GlobalSyncStatus = 'local' | 'fresh' | 'syncing' | 'syncing-cached' | 'cached' | 'failed';

export interface GlobalRefreshSnapshot {
  mode: string;
  busy: boolean;
  errorAt: number | null;
  lastCompletedAt: number | null;
  message: string;
}

export interface GlobalSyncPresentation {
  status: GlobalSyncStatus;
  label: string;
  banner: string | null;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  writeAllowed: boolean;
}

export const GLOBAL_SYNC_LABELS: Record<GlobalSyncStatus, string> = {
  local: '本機資料',
  fresh: '已同步',
  syncing: '同步中…',
  'syncing-cached': '背景同步中・顯示快取',
  cached: '離線・顯示快取',
  failed: '同步失敗',
};

export function resolveGlobalSyncPresentation(
  mode: string,
  connectivity: CloudConnectivitySnapshot,
  refresh: GlobalRefreshSnapshot,
): GlobalSyncPresentation {
  const cloudMode = mode === 'cloud' || mode === 'fallback';
  if (!cloudMode) return { status: 'local', label: GLOBAL_SYNC_LABELS.local, banner: null, tone: 'neutral', writeAllowed: true };

  const fresh = connectivity.readStatus === 'fresh-online' || connectivity.readStatus === 'fresh-empty';
  const cached = connectivity.readStatus === 'stale-cache' || connectivity.readStatus === 'offline';
  const refreshFailed = refresh.errorAt !== null && (connectivity.lastFreshReadAt ?? 0) <= refresh.errorAt;

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
