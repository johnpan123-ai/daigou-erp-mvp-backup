export type CloudConnectivityStatus = 'checking' | 'online' | 'offline';
export type CloudReadFreshnessStatus =
  | 'loading'
  | 'fresh-online'
  | 'fresh-empty'
  | 'stale-cache'
  | 'read-error'
  | 'offline';

export interface CloudConnectivitySnapshot {
  status: CloudConnectivityStatus;
  readStatus: CloudReadFreshnessStatus;
  lastReachableAt: number | null;
  lastFreshReadAt: number | null;
  reason: string | null;
}

export class CloudOfflineWriteError extends Error {
  readonly code = 'CLOUD_OFFLINE_WRITE_BLOCKED';

  constructor() {
    super('雲端資料目前不是可確認的最新狀態。新增、修改、刪除與匯入已停用；重新連線後會讀取雲端最新資料。');
    this.name = 'CloudOfflineWriteError';
  }
}

const listeners = new Set<() => void>();

let snapshot: CloudConnectivitySnapshot = {
  status: typeof navigator === 'undefined' ? 'online' : navigator.onLine === false ? 'offline' : 'checking',
  readStatus: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'loading',
  lastReachableAt: null,
  lastFreshReadAt: null,
  reason: typeof navigator !== 'undefined' && navigator.onLine === false ? 'browser-offline' : null,
};

const publish = (next: CloudConnectivitySnapshot): void => {
  if (
    snapshot.status === next.status
    && snapshot.readStatus === next.readStatus
    && snapshot.lastReachableAt === next.lastReachableAt
    && snapshot.lastFreshReadAt === next.lastFreshReadAt
    && snapshot.reason === next.reason
  ) return;
  snapshot = next;
  listeners.forEach(listener => listener());
};

export const getCloudConnectivitySnapshot = (): CloudConnectivitySnapshot => snapshot;

export const subscribeCloudConnectivity = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const markCloudReachable = (): void => publish({
  ...snapshot,
  status: 'online',
  lastReachableAt: Date.now(),
  reason: snapshot.readStatus === 'stale-cache' || snapshot.readStatus === 'read-error' || snapshot.readStatus === 'offline'
    ? snapshot.reason
    : null,
});

export const markCloudReadLoading = (reason = 'cloud-read-loading'): void => publish({
  ...snapshot,
  readStatus: 'loading',
  reason,
});

export const markCloudReadFresh = (rowCount?: number): void => {
  const now = Date.now();
  publish({
    ...snapshot,
    status: 'online',
    readStatus: rowCount === 0 ? 'fresh-empty' : 'fresh-online',
    lastReachableAt: now,
    lastFreshReadAt: now,
    reason: null,
  });
};

export const markCloudReadFailed = (error: unknown, hasCachedData: boolean): void => {
  publish({
    ...snapshot,
    readStatus: hasCachedData ? 'stale-cache' : 'read-error',
    reason: String((error as { message?: unknown } | null)?.message ?? error ?? 'cloud-read-failed'),
  });
};

export const markCloudReconnectPending = (): void => publish({
  ...snapshot,
  status: 'checking',
  readStatus: 'loading',
  reason: 'reconnect-pending',
});

export const markCloudUnavailable = (reason = 'cloud-unavailable'): void => publish({
  ...snapshot,
  status: 'offline',
  readStatus: 'offline',
  reason,
});

export const isLikelyCloudConnectivityError = (error: unknown): boolean => {
  const record = error as { message?: unknown; name?: unknown; code?: unknown } | null;
  const message = String(record?.message ?? error ?? '').toLowerCase();
  const name = String(record?.name ?? '').toLowerCase();
  const code = String(record?.code ?? '').toLowerCase();
  return name === 'typeerror'
    || code === 'network_error'
    || code === 'etimedout'
    || code === 'econnreset'
    || message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network request failed')
    || message.includes('load failed')
    || message.includes('connection closed')
    || message.includes('timed out');
};

export const markCloudRequestFailed = (error: unknown): void => {
  if (!isLikelyCloudConnectivityError(error)) return;
  markCloudUnavailable('cloud-request-failed');
};

export const assertCloudWriteAllowed = (): void => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    markCloudUnavailable('browser-offline');
  }
  const hasFreshServerRead = snapshot.readStatus === 'fresh-online' || snapshot.readStatus === 'fresh-empty';
  if (snapshot.status !== 'online' || !hasFreshServerRead) throw new CloudOfflineWriteError();
};

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    markCloudUnavailable('browser-offline');
  });
  window.addEventListener('online', markCloudReconnectPending);
}
