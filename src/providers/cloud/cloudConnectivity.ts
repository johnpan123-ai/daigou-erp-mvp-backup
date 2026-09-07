export type CloudConnectivityStatus = 'checking' | 'online' | 'offline';

export interface CloudConnectivitySnapshot {
  status: CloudConnectivityStatus;
  lastReachableAt: number | null;
  reason: string | null;
}

export class CloudOfflineWriteError extends Error {
  readonly code = 'CLOUD_OFFLINE_WRITE_BLOCKED';

  constructor() {
    super('目前為離線狀態。雲端新增、修改、刪除與匯入已停用；重新連線後會讀取雲端最新資料。');
    this.name = 'CloudOfflineWriteError';
  }
}

const listeners = new Set<() => void>();

let snapshot: CloudConnectivitySnapshot = {
  status: typeof navigator === 'undefined' ? 'online' : navigator.onLine === false ? 'offline' : 'checking',
  lastReachableAt: null,
  reason: typeof navigator !== 'undefined' && navigator.onLine === false ? 'browser-offline' : null,
};

const publish = (next: CloudConnectivitySnapshot): void => {
  if (
    snapshot.status === next.status
    && snapshot.lastReachableAt === next.lastReachableAt
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
  status: 'online',
  lastReachableAt: Date.now(),
  reason: null,
});

export const markCloudReconnectPending = (): void => publish({
  ...snapshot,
  status: 'checking',
  reason: 'reconnect-pending',
});

export const markCloudUnavailable = (reason = 'cloud-unavailable'): void => publish({
  ...snapshot,
  status: 'offline',
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
    publish({ ...snapshot, status: 'offline', reason: 'browser-offline' });
  }
  if (snapshot.status !== 'online') throw new CloudOfflineWriteError();
};

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    publish({ ...snapshot, status: 'offline', reason: 'browser-offline' });
  });
  window.addEventListener('online', markCloudReconnectPending);
}
