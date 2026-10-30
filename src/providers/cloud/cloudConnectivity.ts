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
  authoritativeReadPending: boolean;
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

/**
 * P0-2 Phase 1a C1c: Fresh holds. While a hold is active, a successful read is NOT
 * published as Fresh (no false "已同步"): 'pending' shows a resync in progress,
 * 'unproven' shows truthful stale data. The suppressed Fresh is published when the
 * last hold is released, unless a later loading / failure / offline state replaced it.
 */
export type CloudFreshHoldMode = 'pending' | 'unproven';
const freshHolds = new Map<string, { mode: CloudFreshHoldMode; reason: string }>();
let suppressedFresh: { rowCount?: number } | null = null;

let snapshot: CloudConnectivitySnapshot = {
  status: typeof navigator === 'undefined' ? 'online' : navigator.onLine === false ? 'offline' : 'checking',
  readStatus: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'loading',
  authoritativeReadPending: typeof navigator === 'undefined' ? false : navigator.onLine !== false,
  lastReachableAt: null,
  lastFreshReadAt: null,
  reason: typeof navigator !== 'undefined' && navigator.onLine === false ? 'browser-offline' : null,
};

const publish = (next: CloudConnectivitySnapshot): void => {
  if (
    snapshot.status === next.status
    && snapshot.readStatus === next.readStatus
    && snapshot.authoritativeReadPending === next.authoritativeReadPending
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

const heldState = (): { readStatus: CloudReadFreshnessStatus; authoritativeReadPending: boolean; reason: string } | null => {
  if (freshHolds.size === 0) return null;
  const holds = [...freshHolds.values()];
  const unproven = holds.find(hold => hold.mode === 'unproven');
  return unproven
    ? { readStatus: 'stale-cache', authoritativeReadPending: false, reason: unproven.reason }
    : { readStatus: 'loading', authoritativeReadPending: true, reason: holds[0].reason };
};

export const markCloudReadLoading = (reason = 'cloud-read-loading'): void => {
  suppressedFresh = null;
  publish({
    ...snapshot,
    readStatus: 'loading',
    authoritativeReadPending: true,
    reason,
  });
};

export const markCloudReadFresh = (rowCount?: number): void => {
  const now = Date.now();
  const held = heldState();
  if (held) {
    suppressedFresh = { rowCount };
    publish({ ...snapshot, status: 'online', lastReachableAt: now, ...held });
    return;
  }
  publish({
    ...snapshot,
    status: 'online',
    readStatus: rowCount === 0 ? 'fresh-empty' : 'fresh-online',
    authoritativeReadPending: false,
    lastReachableAt: now,
    lastFreshReadAt: now,
    reason: null,
  });
};

export const markCloudReadFailed = (error: unknown, hasCachedData: boolean): void => {
  suppressedFresh = null;
  publish({
    ...snapshot,
    readStatus: hasCachedData ? 'stale-cache' : 'read-error',
    authoritativeReadPending: false,
    reason: String((error as { message?: unknown } | null)?.message ?? error ?? 'cloud-read-failed'),
  });
};

/** The UI boundary elapsed, but the same authoritative request is still running. */
export const markCloudReadDeferred = (hasCachedData: boolean): void => {
  suppressedFresh = null;
  publish({
    ...snapshot,
    readStatus: hasCachedData ? 'stale-cache' : 'loading',
    authoritativeReadPending: true,
    reason: 'cloud-read-soft-timeout',
  });
};

export const markCloudReconnectPending = (): void => {
  suppressedFresh = null;
  publish({
    ...snapshot,
    status: 'checking',
    readStatus: 'loading',
    authoritativeReadPending: true,
    reason: 'reconnect-pending',
  });
};

export const markCloudUnavailable = (reason = 'cloud-unavailable'): void => {
  suppressedFresh = null;
  publish({
    ...snapshot,
    status: 'offline',
    readStatus: 'offline',
    authoritativeReadPending: false,
    reason,
  });
};

/** Withhold Fresh under `key` (e.g. Realtime completeness not yet proven). */
export const holdCloudFresh = (key: string, mode: CloudFreshHoldMode, reason: string): void => {
  freshHolds.set(key, { mode, reason });
  const fresh = snapshot.readStatus === 'fresh-online' || snapshot.readStatus === 'fresh-empty';
  if (fresh) suppressedFresh = { rowCount: snapshot.readStatus === 'fresh-empty' ? 0 : undefined };
  const held = heldState()!;
  if (fresh || (snapshot.readStatus === 'loading' && held.readStatus === 'stale-cache' && suppressedFresh)) {
    publish({ ...snapshot, ...held });
  }
};

/** Release `key`; when no hold remains, a suppressed successful read is published as Fresh. */
export const releaseCloudFresh = (key: string): void => {
  if (!freshHolds.delete(key)) return;
  if (freshHolds.size > 0) {
    if (suppressedFresh) publish({ ...snapshot, ...heldState()! });
    return;
  }
  const pending = suppressedFresh;
  suppressedFresh = null;
  if (pending) markCloudReadFresh(pending.rowCount);
};

export const getCloudFreshHolds = (): string[] => [...freshHolds.keys()].sort();

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

/**
 * Resolves true once the shared Global Sync state is online + fresh (the same
 * condition assertCloudWriteAllowed enforces), false on timeout or offline.
 * Waiting never relaxes the guard: callers still assert before any write.
 */
export const waitForCloudFreshRead = (timeoutMs: number): Promise<boolean> => new Promise(resolve => {
  const ready = () => snapshot.status === 'online' && (snapshot.readStatus === 'fresh-online' || snapshot.readStatus === 'fresh-empty');
  if (ready()) { resolve(true); return; }
  if (snapshot.status === 'offline') { resolve(false); return; }
  let settled = false;
  const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); listeners.delete(check); resolve(value); };
  const check = () => { if (ready()) finish(true); else if (snapshot.status === 'offline') finish(false); };
  const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
  listeners.add(check);
});

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
