/**
 * P0-2 Phase 1a: unified Cloud cache write fence.
 *
 * Every Cloud cache writer (core bootstrap snapshot, authoritative resource
 * refresh, targeted Realtime refresh, verified mutation rows) takes a read token
 * when its server read STARTS and commits through this fence. Rule: per row the
 * newest-started read wins; row versions break ties for rows that both reads saw.
 *
 * - Commits are serialized (runExclusive), so no two cache read-modify-writes interleave.
 * - A snapshot never overwrites a collection that a newer-started snapshot already committed.
 * - Targeted results started after a snapshot started are re-applied on top of that
 *   snapshot when it commits (touched-row ledger), so an old snapshot cannot erase a
 *   newer Realtime re-read.
 * - A Restore epoch change raises a barrier: any read started before it is rejected,
 *   unless it explicitly targets an epoch at or after the barrier epoch.
 *
 * This is not a global consistency proof: convergence still relies on Realtime
 * delivering every change after the read started (see cloudRealtimeReadiness) or on
 * the authoritative catch-up when that cannot be shown. Pure in-memory state.
 */
type CacheRow = { id: string; version?: unknown; deleted_at?: unknown };

interface LedgerEntry {
  token: number;
  row: CacheRow | null;
}

export class CloudCacheFenceRejectedError extends Error {
  readonly reason: 'restore-epoch-barrier';
  constructor(reason: 'restore-epoch-barrier') {
    super(`CLOUD_CACHE_FENCE_REJECTED:${reason}`);
    this.name = 'CloudCacheFenceRejectedError';
    this.reason = reason;
  }
}

let tokenCounter = 0;
let commitQueue: Promise<unknown> = Promise.resolve();
const lastSnapshotCommit = new Map<string, number>();
const inFlightSnapshots = new Set<number>();
const ledger = new Map<string, Map<string, LedgerEntry>>();
let barrier: { token: number; epoch: number } | null = null;
const counters = { snapshotCommits: 0, supersededCollections: 0, overlayRows: 0, barrierRejections: 0, staleDeletesSkipped: 0 };

const versionOf = (row: CacheRow | null | undefined): number | null =>
  row && typeof row.version === 'number' && Number.isFinite(row.version) ? row.version : null;

/** Token for a read that starts now. Strictly increasing. */
export const takeCloudReadToken = (): number => ++tokenCounter;

/** Register a full snapshot read; its token must be taken before the first page request. */
export const beginCloudSnapshot = (): number => {
  const token = takeCloudReadToken();
  inFlightSnapshots.add(token);
  return token;
};

const pruneLedger = () => {
  if (inFlightSnapshots.size === 0) {
    ledger.clear();
    return;
  }
  const oldest = Math.min(...inFlightSnapshots);
  for (const [key, entries] of ledger) {
    for (const [id, entry] of entries) if (entry.token <= oldest) entries.delete(id);
    if (entries.size === 0) ledger.delete(key);
  }
};

export const endCloudSnapshot = (token: number): void => {
  inFlightSnapshots.delete(token);
  pruneLedger();
};

/**
 * @param epoch the server Restore epoch now in force, when the event carries it.
 * Unknown epoch rejects every read started before this point.
 */
export const raiseCloudCacheEpochBarrier = (epoch?: number | null): void => {
  const value = typeof epoch === 'number' && Number.isSafeInteger(epoch) ? epoch : Number.POSITIVE_INFINITY;
  barrier = { token: takeCloudReadToken(), epoch: value };
};

/** True when a read with this start token may still commit. */
export const cloudReadPassesEpochBarrier = (token: number, targetEpoch?: number): boolean => {
  if (!barrier || token > barrier.token) return true;
  return typeof targetEpoch === 'number' && Number.isSafeInteger(targetEpoch) && targetEpoch >= barrier.epoch;
};

const assertBarrier = (token: number, targetEpoch?: number) => {
  if (cloudReadPassesEpochBarrier(token, targetEpoch)) return;
  counters.barrierRejections += 1;
  throw new CloudCacheFenceRejectedError('restore-epoch-barrier');
};

/** Serialize every Cloud cache read-modify-write. */
export const runCloudCacheExclusive = <T>(task: () => Promise<T>): Promise<T> => {
  const run = commitQueue.then(task);
  commitQueue = run.catch(() => undefined);
  return run;
};

export interface SnapshotCollectionPlan {
  storageKey: string;
  /** True when a newer-started snapshot already committed this collection. */
  superseded: boolean;
  /** Apply rows touched by reads newer than this snapshot. */
  overlay: <T extends CacheRow>(rows: T[]) => T[];
}

/**
 * Commit a full snapshot read. `apply` runs inside the exclusive section and must
 * perform the single atomic cache write. `onCommitted` runs synchronously right
 * after, with the barrier re-checked, so Fresh is published atomically with the commit.
 */
export const commitCloudSnapshot = async <T>(options: {
  token: number;
  storageKeys: string[];
  targetEpoch?: number;
  apply: (plan: (storageKey: string) => SnapshotCollectionPlan) => Promise<T>;
  onCommitted?: (result: T) => void;
}): Promise<T> => runCloudCacheExclusive(async () => {
  const { token, storageKeys, targetEpoch } = options;
  try {
    assertBarrier(token, targetEpoch);
    const plan = (storageKey: string): SnapshotCollectionPlan => {
      const superseded = (lastSnapshotCommit.get(storageKey) ?? 0) > token;
      if (superseded) counters.supersededCollections += 1;
      return {
        storageKey,
        superseded,
        overlay: <R extends CacheRow>(rows: R[]): R[] => {
          const entries = ledger.get(storageKey);
          if (!entries || entries.size === 0) return rows;
          const byId = new Map(rows.map(row => [row.id, row]));
          for (const [id, entry] of entries) {
            if (entry.token <= token) continue;
            counters.overlayRows += 1;
            const snapshotRow = byId.get(id);
            if (!entry.row) {
              byId.delete(id);
              continue;
            }
            const snapshotVersion = versionOf(snapshotRow);
            const entryVersion = versionOf(entry.row);
            if (snapshotRow && snapshotVersion !== null && entryVersion !== null && snapshotVersion > entryVersion) continue;
            byId.set(id, entry.row as unknown as R);
          }
          return [...byId.values()];
        },
      };
    };
    const result = await options.apply(plan);
    // The barrier is re-checked after the asynchronous write. If a Restore epoch
    // arrived during the write, the commit stays (a newer authoritative read will
    // replace it) but it must not be published as Fresh.
    assertBarrier(token, targetEpoch);
    for (const storageKey of storageKeys) {
      if ((lastSnapshotCommit.get(storageKey) ?? 0) < token) lastSnapshotCommit.set(storageKey, token);
    }
    counters.snapshotCommits += 1;
    options.onCommitted?.(result);
    return result;
  } finally {
    endCloudSnapshot(token);
  }
});

export interface TargetedCommitContext {
  /** A row missing from this read must not delete the cached row (a newer snapshot owns it). */
  skipAbsentDeletes: boolean;
  /** Record the final server state this read saw for a row (null = absent/deleted). */
  record: (id: string, row: CacheRow | null) => void;
}

/**
 * Commit a targeted / incremental read that started at `token` into `storageKey`.
 */
export const commitCloudTargeted = <T>(options: {
  token: number;
  storageKey: string;
  targetEpoch?: number;
  apply: (context: TargetedCommitContext) => Promise<T>;
}): Promise<T> => runCloudCacheExclusive(async () => {
  const { token, storageKey, targetEpoch } = options;
  assertBarrier(token, targetEpoch);
  const skipAbsentDeletes = (lastSnapshotCommit.get(storageKey) ?? 0) > token;
  const recorded: Array<[string, CacheRow | null]> = [];
  const result = await options.apply({
    skipAbsentDeletes,
    record: (id, row) => { recorded.push([id, row]); },
  });
  if (inFlightSnapshots.size > 0) {
    const entries = ledger.get(storageKey) ?? new Map<string, LedgerEntry>();
    for (const [id, row] of recorded) {
      const existing = entries.get(id);
      if (!existing || existing.token < token) entries.set(id, { token, row });
    }
    ledger.set(storageKey, entries);
    pruneLedger();
  }
  return result;
});

export const noteSkippedStaleDelete = (count = 1): void => { counters.staleDeletesSkipped += count; };

export const getCloudCacheFenceDiagnostics = () => ({
  ...counters,
  inFlightSnapshots: inFlightSnapshots.size,
  ledgerRows: [...ledger.values()].reduce((sum, entries) => sum + entries.size, 0),
  barrierActive: barrier !== null,
});

/** Test-only reset of module state (never called by application code). */
export const __resetCloudCacheFenceForTests = (): void => {
  tokenCounter = 0;
  commitQueue = Promise.resolve();
  lastSnapshotCommit.clear();
  inFlightSnapshots.clear();
  ledger.clear();
  barrier = null;
  Object.keys(counters).forEach(key => { counters[key as keyof typeof counters] = 0; });
};
