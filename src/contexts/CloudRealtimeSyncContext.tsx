import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/authContext';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import { supabase, supabaseEnvironment } from '../providers/cloud/supabaseClient';
import {
  CLOUD_TABLE_RESOURCE,
  CloudReconnectCatchUp,
  CloudSyncCoordinator,
  resolveCloudRowIdentity,
  type CloudChange,
  type CloudReconnectDiagnostic,
  type CloudResource,
  type CloudRefreshResult,
} from '../providers/cloud/cloudSyncDomain';
import { CloudTargetedCache } from '../providers/cloud/cloudTargetedCache';
import { registerBuyAnimeTargetedRefresh, subscribeBuyAnimeFlow, getBuyAnimeFlowPresentation } from '../providers/cloud/buyAnimeImportCoordinator';
import { cloudDraftScopeForOwner, cloudRowAffectsDraft, readCloudDraftRelations, type CloudDraftScope } from '../providers/cloud/cloudDraftScope';
import { consumeLocalCloudEcho } from '../providers/cloud/cloudRealtimeEchoRegistry';
import {
  getCloudRealtimeTestBridge,
  type CloudRealtimeTestPayload,
} from './cloudRealtimeTestBridge';
import {
  getCloudConnectivitySnapshot,
  markCloudReconnectPending,
  markCloudReachable,
  markCloudUnavailable,
  subscribeCloudConnectivity,
  type CloudConnectivitySnapshot,
} from '../providers/cloud/cloudConnectivity';
import {
  resolveGlobalSyncPresentation,
  type GlobalRefreshSnapshot,
  type GlobalSyncPresentation,
} from './globalSyncPresentation';
import {
  StagingRealtimeFaultControl,
  type RealtimeChannelState,
  type StagingRealtimeFaultSnapshot,
} from '../lib/stagingRealtimeFaultControl';
import { assertP04HarnessBoundary } from '../lib/stagingP04AuthenticatedHarness';
import { markBuyAnimeTrace } from '../diagnostics/buyAnimeProductionTrace';
import { readCloudRestoreUnresolvedAttempt } from '../providers/cloud/cloudRestoreSubmit';
import {
  armRealtimeReadiness,
  awaitRealtimeReadiness,
  disarmRealtimeReadiness,
  getRealtimeReadiness,
  isRealtimeReadyGeneration,
  markRealtimeSubscribed,
  markRealtimeSystemMessage,
  markRealtimeUnavailable,
} from '../providers/cloud/cloudRealtimeReadiness';
import { holdCloudFresh, markCloudReconnectPending as markCloudResyncPending, releaseCloudFresh } from '../providers/cloud/cloudConnectivity';
import { markAllCloudTablesUnresolved } from '../providers/cloud/cloudTargetedCache';
import { raiseCloudCacheEpochBarrier } from '../providers/cloud/cloudCacheWriteFence';
import { noteCloudSyncEvent } from '../providers/cloud/cloudSyncObservability';
import {
  REALTIME_RECOVERY_POLICY,
  RealtimeRecoveryScheduler,
  type RealtimeRecoveryCause,
  type RealtimeRecoveryView,
} from './realtimeRecoveryPolicy';

interface CloudRealtimeContextValue {
  conflictedResources: ReadonlySet<CloudResource>;
  registerEditing: (owner: string, resources: CloudResource[], editing: boolean, draftScope?: CloudDraftScope) => void;
  unregister: (owner: string) => void;
  subscribe: (listener: (resources: CloudResource[]) => void | Promise<void>) => () => void;
  clearConflict: (resources: CloudResource[]) => void;
  manualRefresh: (resources: CloudResource[]) => Promise<CloudRefreshResult | false>;
  refreshAll: () => Promise<void>;
  globalRefresh: GlobalRefreshSnapshot;
  syncPresentation: GlobalSyncPresentation;
  connectivity: CloudConnectivitySnapshot;
  /** C1f: automatic Realtime channel recovery state (presentation only). */
  realtimeRecovery: RealtimeRecoveryView | null;
  /** C1f: ask for an immediate reconnect; the new channel must still prove completeness. */
  reconnectRealtime: () => void;
  stagingFaultControl: {
    available: boolean;
    snapshot: StagingRealtimeFaultSnapshot;
    disconnect: () => Promise<StagingRealtimeFaultSnapshot>;
    reconnect: () => Promise<StagingRealtimeFaultSnapshot>;
  };
}

const CloudRealtimeContext = createContext<CloudRealtimeContextValue | null>(null);

const REALTIME_TABLES = Object.keys(CLOUD_TABLE_RESOURCE);
const GLOBAL_REFRESH_RESOURCES = [...new Set(Object.values(CLOUD_TABLE_RESOURCE))];
const CLOUD_RESTORE_EPOCH_TABLE = 'erp_cloud_restore_epoch';
/** Bounded wait, after SUBSCRIBED, for the postgres_changes `system` confirmation. */
const REALTIME_READINESS_WAIT_MS = 3000;
/** C1c: longest wait for readiness before a catch-up runs anyway (unproven, Fresh stays withheld). */
const UNPROVEN_CATCH_UP_MS = 10_000;
/** C1c: a readiness confirmation arriving this late still triggers the proving catch-up. */
const LATE_READINESS_WATCH_MS = 6 * 60 * 60 * 1000;
/** C1e: bounded re-reads when a completed catch-up cannot prove the current generation. */
const MAX_PROOF_REREADS = 2;
/** C1c: Fresh is withheld under this key until Realtime completeness is proven. */
const COMPLETENESS_HOLD = 'realtime-completeness';
const EMPTY_SYNC_METRICS = {
  receivedEvents: 0,
  dedupedEvents: 0,
  deferredEvents: 0,
  editingCatchUps: 0,
  targetedRefreshes: 0,
  fallbackRefreshes: 0,
  conflicts: 0,
  fullPulls: 0,
};

const EMPTY_FAULT_SNAPSHOT: StagingRealtimeFaultSnapshot = {
  channelState: 'unavailable',
  activeResources: [],
  readStatus: 'loading',
  reconnectGeneration: 0,
  catchUpAttempt: 0,
  retryCount: 0,
  lastCatchUpResult: 'none',
  targetedRefreshCount: 0,
  fullPulls: 0,
  diagnostics: [],
  metrics: EMPTY_SYNC_METRICS,
};

export function CloudRealtimeSyncBoundary({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const testBridge = getCloudRealtimeTestBridge();
  const enabled = (getProviderMode() === 'cloud' || Boolean(testBridge)) && Boolean(user);
  const editingOwners = useRef(new Map<string, { resources: Set<CloudResource>; editing: boolean; draftScope?: CloudDraftScope }>());
  const listeners = useRef(new Set<(resources: CloudResource[]) => void | Promise<void>>());
  const coordinatorRef = useRef<CloudSyncCoordinator | null>(null);
  const reconnectRef = useRef<CloudReconnectCatchUp | null>(null);
  const faultControllerRef = useRef<StagingRealtimeFaultControl | null>(null);
  const reconnectDiagnostics = useRef<CloudReconnectDiagnostic[]>([]);
  const [faultSnapshot, setFaultSnapshot] = useState<StagingRealtimeFaultSnapshot>(EMPTY_FAULT_SNAPSHOT);
  const [conflictedResources, setConflictedResources] = useState<Set<CloudResource>>(new Set());
  const [mutationConflictMessage, setMutationConflictMessage] = useState('');
  const [globalRefresh, setGlobalRefresh] = useState<GlobalRefreshSnapshot>({
    mode: getProviderMode(), busy: false, errorAt: null, lastCompletedAt: null, message: '',
  });
  const globalRefreshInFlight = useRef<Promise<void> | null>(null);
  const [realtimeRecovery, setRealtimeRecovery] = useState<RealtimeRecoveryView | null>(null);
  const realtimeReconnectRef = useRef<(() => void) | null>(null);
  const [realtimeUnproven, setRealtimeUnproven] = useState(false);
  const [restorePendingAttempt, setRestorePendingAttempt] = useState<string | null>(() =>
    getProviderMode() === 'cloud' ? readCloudRestoreUnresolvedAttempt()?.attemptId ?? null : null);
  const connectivity = useSyncExternalStore(
    subscribeCloudConnectivity,
    getCloudConnectivitySnapshot,
    getCloudConnectivitySnapshot,
  );
  const cloudMode = ['cloud', 'fallback'].includes(getProviderMode()) || Boolean(testBridge);
  const faultControlAllowed = (() => {
    try {
      assertP04HarnessBoundary({
        projectRef: supabaseEnvironment.projectRef,
        runtimeRole: supabaseEnvironment.role,
        viteMode: import.meta.env.MODE,
        deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENV,
      });
      return true;
    } catch {
      return false;
    }
  })();
  const presentationMode = testBridge ? 'cloud' : getProviderMode();
  const buyAnimeFlow = useSyncExternalStore(subscribeBuyAnimeFlow, getBuyAnimeFlowPresentation, getBuyAnimeFlowPresentation);
  const presentationRefresh = restorePendingAttempt
    ? { ...globalRefresh, busy: true, restorePending: true }
    : buyAnimeFlow.active || buyAnimeFlow.error ? { ...globalRefresh, busy: true } : globalRefresh;
  const syncPresentation = resolveGlobalSyncPresentation(presentationMode, connectivity, presentationRefresh, { unproven: realtimeUnproven });

  useEffect(() => {
    if (!enabled) return;
    const started = (event: Event) => {
      const attemptId = (event as CustomEvent<{ attemptId?: string }>).detail?.attemptId;
      if (typeof attemptId === 'string') setRestorePendingAttempt(attemptId);
    };
    const finished = (event: Event) => {
      const attemptId = (event as CustomEvent<{ attemptId?: string }>).detail?.attemptId;
      setRestorePendingAttempt(previous => previous === attemptId ? null : previous);
    };
    window.addEventListener('cloud-restore-authoritative-pending', started);
    window.addEventListener('cloud-restore-completed', finished);
    window.addEventListener('cloud-restore-not-committed', finished);
    return () => {
      window.removeEventListener('cloud-restore-authoritative-pending', started);
      window.removeEventListener('cloud-restore-completed', finished);
      window.removeEventListener('cloud-restore-not-committed', finished);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || testBridge) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        await dataProvider.waitForCloudBootstrapConvergence();
        const canWrite = await dataProvider.canWriteCloud();
        if (active && canWrite) await dataProvider.recoverPendingBuyAnimeImport();
      })().catch(() => { /* Bounded retry failure is exposed by the import presentation/diagnostics, not an unhandled rejection. */ });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [enabled, testBridge, user]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const isCloudOffline = cloudMode && connectivity.status !== 'online';
    document.body.dataset.cloudConnectivity = isCloudOffline ? connectivity.status : 'inactive';
    return () => { delete document.body.dataset.cloudConnectivity; };
  }, [cloudMode, connectivity.status]);

  useEffect(() => {
    const handleMutationConflict = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setMutationConflictMessage(detail?.message || '資料已由其他裝置更新，請重新確認後再儲存。');
    };
    window.addEventListener('cloud-field-mutation-conflict', handleMutationConflict);
    return () => window.removeEventListener('cloud-field-mutation-conflict', handleMutationConflict);
  }, []);

  const isEditing = useCallback((resource: CloudResource) => (
    [...editingOwners.current.values()].some(scope => scope.editing && scope.resources.has(resource))
  ), []);

  const notifyRefreshed = useCallback((resources: CloudResource[]) => {
    dataProvider.clearCloudStale(resources);
    setConflictedResources(current => {
      if (!resources.some(resource => current.has(resource))) return current;
      const next = new Set(current);
      resources.forEach(resource => next.delete(resource));
      return next;
    });
  }, []);

  const notifyConflict = useCallback((resources: CloudResource[]) => {
    setConflictedResources(current => new Set([...current, ...resources]));
    dataProvider.markCloudStale(resources);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const cache = new CloudTargetedCache({
      ...(testBridge ? { query: testBridge.query } : {}),
      prepareDraftProtection: async () => {
        const needsRelations = () => [...editingOwners.current.entries()].some(([owner, scope]) =>
          scope.editing && (scope.draftScope ?? cloudDraftScopeForOwner(owner))?.kind === 'groups');
        const relations = needsRelations() ? await readCloudDraftRelations() : undefined;
        // Read active registrations at commit, not query start: a draft can start
        // while a request is in flight. Missing evidence remains conservative.
        return (table, before, after) => [...editingOwners.current.entries()].some(([owner, scope]) => {
          if (!scope.editing || !scope.resources.has(CLOUD_TABLE_RESOURCE[table])) return false;
          const draftScope = scope.draftScope ?? cloudDraftScopeForOwner(owner);
          return !draftScope || cloudRowAffectsDraft(draftScope, table, before, after, relations);
        });
      },
    });
    cache.initializeCursor();
    // C1e: ordering evidence for Realtime completeness proofs. A strictly increasing event
    // sequence (never wall-clock comparison) orders "generation confirmed listening" against
    // "authoritative catch-up read started".
    let proofSeq = 0;
    const readySeqByGeneration = new Map<number, { seq: number; at: number }>();
    interface CatchUpAttemptEvidence {
      id: number; requestedAt: number; readStartSeq: number | null; readStartedAt: number | null;
      readCompletedAt: number | null; resources: string[]; epochAtRead: number | null; completed: boolean;
    }
    let attemptIds = 0;
    let activeAttempt: CatchUpAttemptEvidence | null = null;
    let lastCompletedAttempt: CatchUpAttemptEvidence | null = null;
    let epochChanges = 0;
    const coordinator = new CloudSyncCoordinator({
      refresh: (request, signal) => {
        // C1e: the reconnect catch-up's authoritative read starts here (lower bound of its
        // first page request; reads are never joined to an earlier in-flight read).
        if (request.reason === 'reconnect' && activeAttempt && activeAttempt.readStartSeq === null) {
          activeAttempt.readStartSeq = ++proofSeq;
          activeAttempt.readStartedAt = Date.now();
          activeAttempt.epochAtRead = epochChanges;
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('cloud-realtime-proof-diagnostic', {
              detail: { kind: 'read-start', attemptId: activeAttempt.id, readStartSeq: activeAttempt.readStartSeq, epochAtRead: epochChanges },
            }));
          }
        }
        return cache.refreshWithResult(request, signal);
      },
      authoritativeDrafts: true,
      isEditing,
      onRefreshed: notifyRefreshed,
      onConflict: notifyConflict,
      onCommitted: async resources => { await Promise.all([...listeners.current].map(listener => listener(resources))); },
    });
    coordinatorRef.current = coordinator;
    const unregisterBuyAnimeRefresh = registerBuyAnimeTargetedRefresh(async evidence => {
      const { changes, rowsByTable } = evidence;
      const resources = [...new Set(changes.map(change => change.resource))];
      markBuyAnimeTrace('T23_TARGETED_REFRESH_START', { changedRows: changes.length, resources: resources.length });
      await cache.absorbVerifiedRows(changes, rowsByTable);
      notifyRefreshed(resources);
      await Promise.all([...listeners.current].map(listener => listener(resources)));
      markBuyAnimeTrace('T24_TARGETED_REFRESH_DONE', { changedRows: changes.length, resources: resources.length });
      // A concurrently requested global refresh is part of the visible sync
      // state. Success must not race ahead of its final presentation.
      markBuyAnimeTrace('T26_GLOBAL_SYNC_WAIT_START');
      markBuyAnimeTrace('T27_GLOBAL_SYNC_AUTHORITATIVE_READ_START', { inFlight: Boolean(globalRefreshInFlight.current) });
      if (globalRefreshInFlight.current) await globalRefreshInFlight.current;
      markBuyAnimeTrace('T28_GLOBAL_SYNC_AUTHORITATIVE_READ_DONE', { inFlight: Boolean(globalRefreshInFlight.current) });
      const status = getCloudConnectivitySnapshot();
      if (status.status !== 'online' || status.authoritativeReadPending
        || !['fresh-online', 'fresh-empty'].includes(status.readStatus)) {
        throw new Error('BUYANIME_GLOBAL_SYNC_NOT_CONVERGED');
      }
      markBuyAnimeTrace('T29_GLOBAL_SYNC_SYNCED', { readStatus: status.readStatus });
    });
    const activeResources = () => [...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))];
    let channelState: RealtimeChannelState = 'unavailable';
    const buildFaultSnapshot = (): StagingRealtimeFaultSnapshot => {
      const diagnostics = [...reconnectDiagnostics.current];
      const latest = diagnostics.at(-1);
      const metrics = coordinator.snapshotMetrics();
      const latestGeneration = latest?.generation ?? 0;
      const latestGenerationDiagnostics = diagnostics.filter(entry => entry.generation === latestGeneration);
      return {
        channelState,
        activeResources: activeResources().sort(),
        readStatus: getCloudConnectivitySnapshot().readStatus,
        reconnectGeneration: latestGeneration,
        catchUpAttempt: latest?.attempt ?? 0,
        retryCount: latestGenerationDiagnostics.filter(entry => entry.event === 'retry-scheduled').length,
        lastCatchUpResult: latestGenerationDiagnostics.some(entry => entry.event === 'complete')
          ? 'success'
          : latestGenerationDiagnostics.some(entry => entry.event === 'attempt-failed' || entry.event === 'exhausted')
            ? 'failure'
            : 'none',
        targetedRefreshCount: metrics.targetedRefreshes + metrics.fallbackRefreshes,
        fullPulls: metrics.fullPulls,
        diagnostics,
        metrics,
      };
    };
    const publishFaultSnapshot = () => setFaultSnapshot(buildFaultSnapshot());
    /**
     * Egress E1 (D1/D2): every authoritative catch-up re-reads all cached tables (about 12.6 MB for
     * ERP2). Automatic ones are bounded: while Fresh is withheld at most one read that cannot prove
     * completeness (listening unconfirmed) and three in total, and at most six per hour; a hidden tab
     * defers them until it is visible again. A withheld read only keeps the existing hold (read-only,
     * never shown as synced). The user (focus, visible again, manual reconnect) may grant one more
     * read at most every 30 s; a Restore epoch change always re-opens the budget. The proof itself,
     * the epoch barrier and the write fence are unchanged.
     */
    const FULL_READ_UNPROVEN_LIMIT = 1;
    const FULL_READ_HELD_LIMIT = 3;
    const FULL_READ_WINDOW_MS = 60 * 60 * 1000;
    const FULL_READ_WINDOW_LIMIT = 6;
    const FULL_READ_USER_GRANT_INTERVAL_MS = 30_000;
    let heldFullReads = 0;
    let automaticFullReadTimes: number[] = [];
    let userFullReadGranted = false;
    let lastUserFullReadGrantAt = Number.NEGATIVE_INFINITY;
    const isTabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const grantUserFullRead = (force = false) => {
      const now = Date.now();
      if (!force && now - lastUserFullReadGrantAt < FULL_READ_USER_GRANT_INTERVAL_MS) return;
      lastUserFullReadGrantAt = now;
      userFullReadGranted = true;
      wakeFullReadAdmission();
    };
    // A withheld read stays one pending, I/O-free attempt (never a retry loop): it waits until the
    // tab is visible, the user grants a read, the budget re-opens, listening is confirmed, or the
    // attempt is superseded (abort). The hourly window is re-checked once a minute.
    const FULL_READ_RECHECK_MS = 60_000;
    const fullReadAdmissionWaiters = new Set<() => void>();
    const wakeFullReadAdmission = () => { [...fullReadAdmissionWaiters].forEach(wake => wake()); };
    const resetFullReadBudget = () => { heldFullReads = 0; wakeFullReadAdmission(); };
    function admitFullRead(): 'allow' | 'hidden-tab' | 'held-budget' | 'hourly-budget' {
      if (isTabHidden()) return 'hidden-tab';
      if (userFullReadGranted) { userFullReadGranted = false; return 'allow'; }
      const now = Date.now();
      automaticFullReadTimes = automaticFullReadTimes.filter(at => now - at < FULL_READ_WINDOW_MS);
      if (automaticFullReadTimes.length >= FULL_READ_WINDOW_LIMIT) return 'hourly-budget';
      if (completenessHeld) {
        const listening = readinessGeneration !== null && isRealtimeReadyGeneration(readinessGeneration);
        if (heldFullReads >= (listening ? FULL_READ_HELD_LIMIT : FULL_READ_UNPROVEN_LIMIT)) return 'held-budget';
        heldFullReads += 1;
      }
      automaticFullReadTimes.push(now);
      return 'allow';
    }
    const waitForFullReadAdmission = async (signal: AbortSignal) => {
      let reported: string | null = null;
      for (;;) {
        signal.throwIfAborted();
        const admission = admitFullRead();
        if (admission === 'allow') return;
        if (reported !== admission) {
          reported = admission;
          emitRecovery({ kind: 'full-read-withheld', reason: admission, held: completenessHeld, heldFullReads });
        }
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { fullReadAdmissionWaiters.delete(wake); signal.removeEventListener('abort', onAbort); clearTimeout(timer); };
          const wake = () => { cleanup(); resolve(); };
          const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('FULL_READ_ADMISSION_ABORTED')); };
          const timer = setTimeout(wake, FULL_READ_RECHECK_MS);
          fullReadAdmissionWaiters.add(wake);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    };
    const reconnect = new CloudReconnectCatchUp({
      refresh: async (resources, signal) => {
        await waitForFullReadAdmission(signal);
        // C1e: one evidence record per actual attempt (attempts are strictly serialized).
        const attempt: CatchUpAttemptEvidence = {
          id: ++attemptIds, requestedAt: Date.now(), readStartSeq: null, readStartedAt: null,
          readCompletedAt: null, resources: [...resources], epochAtRead: null, completed: false,
        };
        activeAttempt = attempt;
        try {
          const completed = await coordinator.fallback('reconnect', resources, signal);
          attempt.readCompletedAt = Date.now();
          attempt.completed = completed === true && !signal.aborted;
          if (attempt.completed) lastCompletedAttempt = attempt;
          return completed;
        } finally {
          if (activeAttempt === attempt) activeAttempt = null;
        }
      },
      retryDelaysMs: testBridge ? [10, 25, 50, 100] : undefined,
      onDiagnostic: diagnostic => {
        reconnectDiagnostics.current = [...reconnectDiagnostics.current.slice(-49), diagnostic];
        publishFaultSnapshot();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('cloud-reconnect-diagnostic', { detail: diagnostic }));
        }
      },
    });
    reconnectRef.current = reconnect;
    reconnect.updateResources(activeResources());

    const handlePayload = (table: string, payload: CloudRealtimeTestPayload) => {
      const row = payload.new && Object.keys(payload.new).length > 0 ? payload.new : payload.old;
      const { canonicalId, databaseId, localId } = resolveCloudRowIdentity(table, row || {});
      if (!canonicalId) return;
      const isLocalEcho = consumeLocalCloudEcho(table, canonicalId);
      coordinator.receive({
        table,
        canonicalId,
        databaseId,
        localId,
        resource: CLOUD_TABLE_RESOURCE[table],
        kind: payload.eventType,
        committedAt: payload.commit_timestamp,
        origin: isLocalEcho ? 'local' : 'remote',
      } as CloudChange);
    };

    let channel: ReturnType<typeof supabase.channel> | null = null;
    let channelGeneration = 0;
    let readinessGeneration: number | null = null;
    let maxEpochSeen: number | null = null;
    let completenessHeld = false;
    let completenessMode: 'pending' | 'unproven' | null = null;
    let disposedForHolds = false;
    // C1f: automatic channel recovery (created below; never releases a hold itself).
    let recovery: RealtimeRecoveryScheduler | null = null;
    let readinessWatchdog: ReturnType<typeof setTimeout> | null = null;
    let readinessTimedOut = false;
    let subscribedGeneration: number | null = null;
    let lastChannelFailure: 'channel-error' | 'timed-out' | 'closed' | null = null;
    const realtimeTopic = `erp-live-${user!.id}`;
    // C1f: channels whose leave has not completed yet; removed before any new channel is built.
    const channelsPendingRemoval = new Set<NonNullable<ReturnType<typeof supabase.channel>>>();
    const emitRecovery = (detail: Record<string, unknown>) => {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cloud-realtime-recovery-diagnostic', { detail: { at: Date.now(), ...detail } }));
    };
    const clearReadinessWatchdog = () => {
      if (readinessWatchdog !== null) clearTimeout(readinessWatchdog);
      readinessWatchdog = null;
    };
    const holdCompleteness = (mode: 'pending' | 'unproven', reason: string) => {
      if (disposedForHolds) return;
      // C1f: once shown as unproven, a recovery attempt's new pending phase stays unproven
      // (no 同步中 / 未確認 flip-flop). Presentation only: both modes withhold Fresh.
      const effective = completenessHeld && completenessMode === 'unproven' ? 'unproven' : mode;
      completenessHeld = true;
      completenessMode = effective;
      holdCloudFresh(COMPLETENESS_HOLD, effective, reason);
      setRealtimeUnproven(effective === 'unproven');
    };
    const releaseCompleteness = () => {
      resetFullReadBudget();
      completenessHeld = false;
      completenessMode = null;
      clearReadinessWatchdog();
      releaseCloudFresh(COMPLETENESS_HOLD);
      setRealtimeUnproven(false);
      recovery?.noteProven();
    };
    /**
     * C1c: one complete authoritative catch-up (all cached resources). It proves Realtime
     * completeness only when it started after `gen` confirmed postgres_changes listening,
     * that confirmation is still valid when it finishes, and no Restore epoch changed.
     */
    const emitProof = (detail: Record<string, unknown>) => {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cloud-realtime-proof-diagnostic', { detail }));
    };
    /**
     * C1e: the attempt that completed a request proves `gen` only if its authoritative read
     * started after `gen` confirmed listening (event order, not request time - a request can
     * be merged into an older in-flight attempt), it covered every requested resource, and no
     * Restore epoch changed since the request or the read start.
     */
    const attemptProves = (gen: number | null, attempt: CatchUpAttemptEvidence | null, epochAtRequest: number) => {
      if (gen === null || !attempt || !attempt.completed || attempt.readStartSeq === null) return false;
      const ready = readySeqByGeneration.get(gen);
      return Boolean(ready) && attempt.readStartSeq > ready!.seq && isRealtimeReadyGeneration(gen)
        && attempt.epochAtRead === epochAtRequest && epochChanges === epochAtRequest
        && GLOBAL_REFRESH_RESOURCES.every(resource => attempt.resources.includes(resource));
    };
    const completeCatchUp = async (gen: number | null, trigger: 'subscribed' | 'focus' | 'visibility') => {
      const startedReady = isRealtimeReadyGeneration(gen);
      const epochAtStart = epochChanges;
      const requestSeq = ++proofSeq;
      const requestAt = Date.now();
      let completed: boolean;
      let proven: boolean;
      let attempt: CatchUpAttemptEvidence | null;
      let rereads = 0;
      for (;;) {
        completed = await reconnect.request(trigger, GLOBAL_REFRESH_RESOURCES);
        attempt = completed ? lastCompletedAttempt : null;
        proven = completed && attemptProves(gen, attempt, epochAtStart);
        // C1e: completed, but by a read that cannot prove this generation (started before it
        // listened, partial resources): re-read once listening is confirmed, bounded.
        if (proven || !completed || gen !== readinessGeneration || !isRealtimeReadyGeneration(gen)
          || epochChanges !== epochAtStart || rereads >= MAX_PROOF_REREADS) break;
        rereads += 1;
      }
      publishFaultSnapshot();
      const ready = gen === null ? undefined : readySeqByGeneration.get(gen);
      emitProof({
        kind: 'catch-up', trigger, generation: gen, readySeq: ready?.seq ?? null, readyAt: ready?.at ?? null,
        requestSeq, requestAt, attemptId: attempt?.id ?? null, readStartSeq: attempt?.readStartSeq ?? null,
        readStartedAt: attempt?.readStartedAt ?? null, readCompletedAt: attempt?.readCompletedAt ?? null,
        resources: attempt?.resources ?? [], epochAtRequest: epochAtStart, epochAtRead: attempt?.epochAtRead ?? null,
        epochNow: epochChanges, completed, proven, rereads, current: gen === readinessGeneration,
      });
      // C1e: a catch-up of a superseded generation never changes the newer generation's hold.
      if (gen !== readinessGeneration) return { completed, proven: false, startedReady };
      if (proven && !disposedForHolds) releaseCompleteness();
      else if (!disposedForHolds && completenessHeld) {
        holdCompleteness('unproven', completed ? 'realtime-readiness-unproven' : 'realtime-catch-up-incomplete');
        // C1f: listening is confirmed but the catch-up could not prove it: retry it with backoff
        // (an unconfirmed channel is handled by the readiness watchdog instead).
        if (isRealtimeReadyGeneration(gen)) recovery?.request('catch-up-incomplete');
      }
      return { completed, proven, startedReady };
    };
    let subscribedOnce = false;
    let faultDisconnected = false;
    let disposed = false;
    let stagingFaultController: StagingRealtimeFaultControl | null = null;

    const removeRealtimeChannel = async (currentChannel: NonNullable<typeof channel>) => {
      const result = await supabase.removeChannel(currentChannel);
      if (result !== 'ok') throw new Error(`P0_4_REALTIME_DISCONNECT_${String(result).toUpperCase().replaceAll(' ', '_')}`);
    };

    /**
     * C1f (A3): a channel that has not confirmed postgres_changes listening within the pending
     * limit is shown as unproven and replaced. Only the presentation and the retry flow change;
     * the hold stays until a later generation proves completeness.
     */
    const armReadinessWatchdog = (generation: number) => {
      clearReadinessWatchdog();
      readinessTimedOut = false;
      readinessWatchdog = setTimeout(() => {
        readinessWatchdog = null;
        if (disposed || faultDisconnected || generation !== channelGeneration) return;
        // Realtime is the problem only while listening is unconfirmed; a slow catch-up of a
        // confirmed channel is left to its own bounded retries.
        if (!completenessHeld || isRealtimeReadyGeneration(readinessGeneration)) return;
        readinessTimedOut = true;
        const subscribed = subscribedGeneration === generation;
        const reason = subscribed ? 'realtime-system-ok-missing' : 'realtime-subscribe-timeout';
        holdCompleteness('unproven', reason);
        reconnect.markNeeded('channel-interrupted');
        emitRecovery({ kind: 'readiness-timeout', generation, subscribed, reason, readiness: getRealtimeReadiness() });
        recovery?.request('pending-timeout');
      }, REALTIME_RECOVERY_POLICY.pendingLimitMs);
    };

    const subscribeRealtimeChannel = (forceAuthoritativeCatchUp: boolean): Promise<boolean> => {
      channelState = 'subscribing';
      publishFaultSnapshot();
      const generation = ++channelGeneration;
      lastChannelFailure = null;
      subscribedGeneration = null;
      armReadinessWatchdog(generation);
      if (readinessGeneration !== null) disarmRealtimeReadiness(readinessGeneration);
      let channelReadiness = armRealtimeReadiness();
      readinessGeneration = channelReadiness;
      // C1c: nothing read before this channel confirms listening may be published as Fresh.
      holdCompleteness('pending', 'realtime-readiness-pending');
      let nextChannel = supabase.channel(realtimeTopic);
      // P0-2 Phase 1a: SUBSCRIBED alone does not prove postgres_changes is listening.
      // The server's `system` confirmation is required before a snapshot may rely on
      // Realtime for every later change; any other shape keeps the catch-up.
      nextChannel = nextChannel.on('system' as never, {}, payload => {
        if (disposed || generation !== channelGeneration || channel !== nextChannel) return;
        markRealtimeSystemMessage(channelReadiness, payload);
        // C1e: order of this generation's listening confirmation (first time only).
        if (isRealtimeReadyGeneration(channelReadiness) && !readySeqByGeneration.has(channelReadiness)) {
          readySeqByGeneration.set(channelReadiness, { seq: ++proofSeq, at: Date.now() });
          wakeFullReadAdmission();
        }
      });
      for (const table of REALTIME_TABLES) {
        nextChannel = nextChannel.on('postgres_changes' as never, { event: '*', schema: 'public', table }, payload => {
          if (disposed || generation !== channelGeneration || channel !== nextChannel) return;
          handlePayload(table, payload as unknown as CloudRealtimeTestPayload);
        });
      }
      nextChannel = nextChannel.on('postgres_changes' as never, {
        event: 'UPDATE', schema: 'public', table: CLOUD_RESTORE_EPOCH_TABLE,
      }, payload => {
        if (disposed || generation !== channelGeneration || channel !== nextChannel) return;
        // Restore epoch changed: no cache read started before this point may commit.
        const epoch = Number((payload as { new?: { epoch?: unknown } } | null)?.new?.epoch);
        const knownEpoch = Number.isSafeInteger(epoch);
        // C1c: a duplicate or delayed older epoch event changes nothing.
        if (knownEpoch && maxEpochSeen !== null && epoch <= maxEpochSeen) return;
        if (knownEpoch) maxEpochSeen = epoch;
        epochChanges += 1;
        // Egress E1: a Restore epoch change is always re-verified (budget re-opened, one read granted).
        resetFullReadBudget();
        grantUserFullRead(true);
        raiseCloudCacheEpochBarrier(knownEpoch ? epoch : null);
        // C1c: the old Fresh state ends now ("重新同步中"), and every cached table must be
        // re-read by a refresh started after the barrier before Fresh can return.
        markAllCloudTablesUnresolved();
        markCloudResyncPending();
        reconnect.markNeeded('channel-interrupted');
        void completeCatchUp(channelReadiness, 'subscribed');
      });
      channel = nextChannel;

      return new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const settle = (result: boolean, error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(result);
        };
        nextChannel.subscribe(status => {
          if (disposed || generation !== channelGeneration || channel !== nextChannel) return;
          if (status === 'SUBSCRIBED') {
            channelState = 'subscribed';
            markCloudReachable();
            // C1c: a rejoin after CHANNEL_ERROR / TIMED_OUT / CLOSED gets a fresh readiness
            // window; evidence of the interrupted join is never reused.
            const current = getRealtimeReadiness();
            if (!current.armed || current.generation !== channelReadiness || current.failed) {
              if (readinessGeneration !== null) disarmRealtimeReadiness(readinessGeneration);
              channelReadiness = armRealtimeReadiness();
              readinessGeneration = channelReadiness;
            }
            const gen = channelReadiness;
            markRealtimeSubscribed(gen);
            // C1f: the SDK rejoined (or first joined) this channel: a replacement that only waited for
            // the SDK rejoin is no longer needed (pending-timeout / catch-up / user requests stay); an
            // unconfirmed join keeps the watchdog that is already running (15 s bound), or gets one
            // when none is running (rejoin after an error).
            subscribedGeneration = generation;
            lastChannelFailure = null;
            recovery?.noteSdkRejoined();
            if (!isRealtimeReadyGeneration(gen) && readinessWatchdog === null) armReadinessWatchdog(generation);
            const firstJoin = !forceAuthoritativeCatchUp && !subscribedOnce && !reconnect.isPending();
            subscribedOnce = true;
            publishFaultSnapshot();
            const isCurrent = () => !disposed && generation === channelGeneration && channel === nextChannel && readinessGeneration === gen;
            const epochAtJoin = epochChanges;
            if (!firstJoin) holdCompleteness('pending', 'realtime-rejoin-pending');
            void (async () => {
              // P0-2 Phase 1a (Wave A/B integration): skip the separate catch-up only when
              // the bootstrap snapshot is proven to have started after this channel confirmed
              // postgres_changes listening.
              if (firstJoin) {
                const readiness = await awaitRealtimeReadiness(REALTIME_READINESS_WAIT_MS);
                if (!isCurrent()) return;
                if (readiness.state === 'ready' && readiness.generation === gen && epochChanges === epochAtJoin
                  && await dataProvider.awaitCoreSnapshotAfterRealtimeReady(gen) && isCurrent()
                  && !reconnect.isPending() && isRealtimeReadyGeneration(gen) && epochChanges === epochAtJoin) {
                  noteCloudSyncEvent('catch-up-skipped-after-readiness');
                  emitProof({ kind: 'core-snapshot', generation: gen, readySeq: readySeqByGeneration.get(gen)?.seq ?? null, proven: true, epochNow: epochChanges, current: true });
                  releaseCompleteness();
                  settle(true);
                  return;
                }
              }
              // C1c: a catch-up that starts before postgres_changes listens cannot close the
              // gap, so wait (bounded) for readiness; past the bound it runs unproven and
              // Fresh stays withheld until a catch-up started after a later readiness succeeds.
              if (!isRealtimeReadyGeneration(gen)) {
                await awaitRealtimeReadiness(UNPROVEN_CATCH_UP_MS);
                if (!isCurrent()) return;
              }
              noteCloudSyncEvent('catch-up-retained');
              if (!isRealtimeReadyGeneration(gen)) holdCompleteness('unproven', 'realtime-readiness-unproven');
              const result = await completeCatchUp(gen, 'subscribed');
              settle(result.completed, result.completed ? undefined : new Error('P0_4_REALTIME_CATCH_UP_INCOMPLETE'));
              // C1e: a catch-up that could not prove this generation (even one requested after
              // readiness) is followed by one bounded proof catch-up once listening is confirmed.
              if (!isCurrent() || result.proven) return;
              const late = await awaitRealtimeReadiness(LATE_READINESS_WATCH_MS);
              if (!isCurrent() || late.state !== 'ready' || late.generation !== gen) return;
              const proof = await completeCatchUp(gen, 'subscribed');
              if (proof.proven) noteCloudSyncEvent('catch-up-after-late-readiness');
            })().catch(error => {
              if (!isCurrent()) return;
              holdCompleteness('unproven', 'realtime-catch-up-incomplete');
              settle(false, error instanceof Error ? error : new Error(String(error)));
            });
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            markRealtimeUnavailable(channelReadiness);
            // C1c: events may have been missed; completeness must be proven again.
            holdCompleteness('unproven', `realtime-${status.toLowerCase()}`);
            channelState = 'error';
            markCloudUnavailable(`realtime-${status.toLowerCase()}`);
            reconnect.markNeeded('channel-interrupted');
            publishFaultSnapshot();
            // C1f: CHANNEL_ERROR / TIMED_OUT are rejoined by the SDK first (grace window); a
            // CLOSED channel is never rejoined by the SDK and is replaced after the backoff.
            lastChannelFailure = status === 'CLOSED' ? 'closed' : status === 'TIMED_OUT' ? 'timed-out' : 'channel-error';
            emitRecovery({ kind: 'channel-failure', generation, status, readiness: getRealtimeReadiness() });
            recovery?.request(lastChannelFailure);
            settle(false, new Error(`P0_4_REALTIME_${status}`));
          }
        });
      });
    };

    /**
     * C1f (A1/A2): replace a broken or unproven channel with a new generation. Old callbacks
     * become inert first (generation + channel identity), the readiness gate is disarmed, and
     * the new channel must earn the full proof (SUBSCRIBED + system ok + catch-up) again.
     */
    const replaceRealtimeChannel = async (cause: RealtimeRecoveryCause): Promise<void> => {
      if (disposed || faultDisconnected) return;
      const previous = channel;
      channel = null;
      channelGeneration += 1;
      clearReadinessWatchdog();
      if (readinessGeneration !== null) disarmRealtimeReadiness(readinessGeneration);
      holdCompleteness('unproven', `realtime-recovering-${cause}`);
      reconnect.markNeeded('channel-interrupted');
      emitRecovery({ kind: 'replace-start', cause, generation: channelGeneration });
      if (previous) channelsPendingRemoval.add(previous);
      for (const old of [...channelsPendingRemoval]) {
        try { await supabase.removeChannel(old); } catch { /* verified below */ }
        if (!supabase.getChannels().includes(old)) channelsPendingRemoval.delete(old);
      }
      if (disposed || faultDisconnected) return;
      // supabase.channel(topic) returns an existing channel with the same topic: never reuse a
      // channel whose leave did not complete (handlers would bind twice or the join is skipped).
      if (supabase.getChannels().some(existing => existing.topic === `realtime:${realtimeTopic}`)) {
        emitRecovery({ kind: 'replace-blocked', cause, reason: 'previous-channel-not-removed' });
        throw new Error('P0_2_REALTIME_PREVIOUS_CHANNEL_NOT_REMOVED');
      }
      void subscribeRealtimeChannel(true).catch(() => {
        // Status handlers keep the fail-closed state and request the next recovery.
      });
    };
    const requestRealtimeReconnect = (cause: 'manual' | 'focus' | 'online') => {
      if (disposed || faultDisconnected || testBridge || !completenessHeld) return;
      if (isRealtimeReadyGeneration(readinessGeneration)) {
        // Listening is confirmed: only a complete catch-up started now can prove it.
        if (cause === 'manual') void completeCatchUp(readinessGeneration, 'focus');
        return;
      }
      // focus / online never pre-empt the SDK rejoin of an errored channel or a join that is
      // still inside its pending window; the manual request does (minimum interval applies).
      if (cause !== 'manual' && lastChannelFailure !== 'closed' && !readinessTimedOut) return;
      emitRecovery({ kind: 'reconnect-requested', cause });
      recovery?.request(cause);
    };
    if (!testBridge) {
      recovery = new RealtimeRecoveryScheduler({
        now: () => Date.now(),
        random: () => Math.random(),
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
        shouldRecover: () => !disposed && !faultDisconnected && completenessHeld,
        recover: async cause => {
          // Listening confirmed: only a complete catch-up started now can prove it (never a release
          // by this scheduler). Otherwise the channel itself is replaced and must prove itself.
          if (isRealtimeReadyGeneration(readinessGeneration)) {
            const result = await completeCatchUp(readinessGeneration, 'focus');
            if (!result.proven) throw new Error('P0_2_REALTIME_CATCH_UP_NOT_PROVEN');
            return;
          }
          await replaceRealtimeChannel(cause);
        },
        onChange: view => {
          setRealtimeRecovery(view);
          emitRecovery({ kind: 'recovery-view', ...view });
        },
      });
      realtimeReconnectRef.current = () => { grantUserFullRead(true); requestRealtimeReconnect('manual'); };
    }

    if (testBridge) {
      testBridge.attach({
        emit: async (table, payload) => {
          handlePayload(table, payload);
          await coordinator.flush();
        },
        emitMany: async events => {
          events.forEach(({ table, payload }) => handlePayload(table, payload));
          await coordinator.flush();
        },
        fallback: (reason, resources) => coordinator.fallback(reason, resources ?? activeResources()),
        reconnect: (trigger, resources) => reconnect.request(trigger, resources ?? activeResources()),
        markReconnectNeeded: () => reconnect.markNeeded('channel-interrupted'),
        waitForReconnect: () => reconnect.waitForCurrentCycle(),
        reconnectDiagnostics: () => [...reconnectDiagnostics.current],
        metrics: () => coordinator.snapshotMetrics(),
      });
      markCloudReachable();
      const { readStatus } = getCloudConnectivitySnapshot();
      if (readStatus !== 'fresh-online' && readStatus !== 'fresh-empty') {
        reconnect.ensurePending('subscribed');
        reconnect.updateResources(activeResources());
      }
    } else {
      const environment = {
        projectRef: supabaseEnvironment.projectRef,
        runtimeRole: supabaseEnvironment.role,
        viteMode: import.meta.env.MODE,
        deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENV,
      } as const;
      try {
        stagingFaultController = new StagingRealtimeFaultControl(environment, {
          snapshot: buildFaultSnapshot,
          disconnect: async () => {
            faultDisconnected = true;
            recovery?.cancel();
            clearReadinessWatchdog();
            channelState = 'disconnecting';
            publishFaultSnapshot();
            reconnect.markNeeded('channel-interrupted');
            markCloudUnavailable('realtime-test-disconnected');
            if (readinessGeneration !== null) disarmRealtimeReadiness(readinessGeneration);
            const currentChannel = channel;
            channel = null;
            channelGeneration += 1;
            if (currentChannel) {
              try {
                await removeRealtimeChannel(currentChannel);
              } catch (error) {
                channelState = 'error';
                publishFaultSnapshot();
                throw error;
              }
            }
            channelState = 'unsubscribed';
            publishFaultSnapshot();
            return buildFaultSnapshot();
          },
          reconnect: async () => {
            faultDisconnected = false;
            recovery?.noteExternalReplacement();
            const currentChannel = channel;
            channel = null;
            channelGeneration += 1;
            if (currentChannel) await removeRealtimeChannel(currentChannel);
            reconnect.markNeeded('channel-interrupted');
            markCloudReconnectPending();
            await subscribeRealtimeChannel(true);
            publishFaultSnapshot();
            return buildFaultSnapshot();
          },
        });
        faultControllerRef.current = stagingFaultController;
      } catch {
        faultControllerRef.current = null;
      }
      void subscribeRealtimeChannel(false).catch(() => {
        // Realtime status and reconnect diagnostics already preserve the
        // fail-closed state. A later native SUBSCRIBED transition or explicit
        // Staging reconnect control can start the authoritative catch-up.
      });
    }
    const needsAuthoritativeCatchUp = () => {
      const { readStatus } = getCloudConnectivitySnapshot();
      return reconnect.isPending() && readStatus !== 'fresh-online' && readStatus !== 'fresh-empty';
    };
    const handleFocus = (userInitiated = true) => {
      if (faultDisconnected) return;
      if (userInitiated) grantUserFullRead();
      // C1c: a withheld Fresh can be proven by a complete catch-up once listening is confirmed.
      if (completenessHeld && isRealtimeReadyGeneration(readinessGeneration)) { void completeCatchUp(readinessGeneration, 'focus'); return; }
      requestRealtimeReconnect('focus');
      if (needsAuthoritativeCatchUp()) void reconnect.request('focus', activeResources());
      else void coordinator.fallback('focus', activeResources());
    };
    const handleVisibility = () => {
      if (faultDisconnected) return;
      if (document.visibilityState !== 'visible') return;
      grantUserFullRead();
      wakeFullReadAdmission();
      if (completenessHeld && isRealtimeReadyGeneration(readinessGeneration)) { void completeCatchUp(readinessGeneration, 'visibility'); return; }
      if (needsAuthoritativeCatchUp()) void reconnect.request('visibility', activeResources());
      else void coordinator.fallback('visibility', activeResources());
    };
    const handleOnline = () => {
      if (faultDisconnected) return;
      requestRealtimeReconnect('online');
      void reconnect.request('online', activeResources());
    };
    // Another tab's write marker is not a user action: it never grants an extra full read.
    const handleCrossTabChange = () => handleFocus(false);
    const handleWindowFocus = () => handleFocus(true);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('cloud-cross-tab-change', handleCrossTabChange);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      unregisterBuyAnimeRefresh();
      disposed = true;
      channelGeneration += 1;
      if (readinessGeneration !== null) disarmRealtimeReadiness(readinessGeneration);
      recovery?.dispose();
      clearReadinessWatchdog();
      if (realtimeReconnectRef.current) realtimeReconnectRef.current = null;
      setRealtimeRecovery(null);
      disposedForHolds = true;
      releaseCompleteness();
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('cloud-cross-tab-change', handleCrossTabChange);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
      if (reconnectRef.current === reconnect) reconnectRef.current = null;
      if (faultControllerRef.current === stagingFaultController) faultControllerRef.current = null;
      testBridge?.detach?.();
      reconnect.dispose();
      coordinator.dispose();
      if (channel) void supabase.removeChannel(channel);
      channelsPendingRemoval.forEach(old => { void supabase.removeChannel(old); });
      channelsPendingRemoval.clear();
    };
  }, [enabled, isEditing, notifyConflict, notifyRefreshed, testBridge, user]);

  const resumeAfterEditing = useCallback((resources: CloudResource[]) => {
    if (resources.length === 0) return;
    queueMicrotask(() => {
      void coordinatorRef.current?.resume(resources).catch(error => {
        console.error('Failed to catch up deferred Cloud updates after editing ended', error);
      });
    });
  }, []);

  const refreshFaultSnapshot = useCallback(() => {
    const controller = faultControllerRef.current;
    if (!controller) return;
    try {
      setFaultSnapshot(controller.snapshot());
    } catch {
      setFaultSnapshot(EMPTY_FAULT_SNAPSHOT);
    }
  }, []);

  const registerEditing = useCallback((owner: string, resources: CloudResource[], editing: boolean, draftScope?: CloudDraftScope) => {
    const previous = editingOwners.current.get(owner);
    const affected = [...new Set([...(previous?.resources ?? []), ...resources])];
    const wasEditing = new Set(affected.filter(isEditing));
    editingOwners.current.set(owner, { resources: new Set(resources), editing, draftScope });
    reconnectRef.current?.updateResources([...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))]);
    refreshFaultSnapshot();
    resumeAfterEditing(affected.filter(resource => wasEditing.has(resource) && !isEditing(resource)));
  }, [isEditing, refreshFaultSnapshot, resumeAfterEditing]);

  const unregister = useCallback((owner: string) => {
    const previous = editingOwners.current.get(owner);
    if (!previous) return;
    const affected = [...previous.resources];
    const wasEditing = new Set(affected.filter(isEditing));
    editingOwners.current.delete(owner);
    reconnectRef.current?.updateResources([...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))]);
    refreshFaultSnapshot();
    resumeAfterEditing(affected.filter(resource => wasEditing.has(resource) && !isEditing(resource)));
  }, [isEditing, refreshFaultSnapshot, resumeAfterEditing]);

  const subscribe = useCallback((listener: (resources: CloudResource[]) => void | Promise<void>) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  const clearConflict = useCallback((resources: CloudResource[]) => {
    setConflictedResources(current => {
      const next = new Set(current);
      resources.forEach(resource => next.delete(resource));
      return next;
    });
    dataProvider.clearCloudStale(resources);
  }, []);

  const disconnectStagingRealtime = useCallback(async () => {
    const controller = faultControllerRef.current;
    if (!controller) throw new Error('P0_4_STAGING_REALTIME_FAULT_CONTROL_DISABLED');
    const snapshot = await controller.disconnect();
    setFaultSnapshot(snapshot);
    return snapshot;
  }, []);

  const reconnectRealtime = useCallback(() => { realtimeReconnectRef.current?.(); }, []);

  const reconnectStagingRealtime = useCallback(async () => {
    const controller = faultControllerRef.current;
    if (!controller) throw new Error('P0_4_STAGING_REALTIME_FAULT_CONTROL_DISABLED');
    const snapshot = await controller.reconnect();
    setFaultSnapshot(snapshot);
    return snapshot;
  }, []);

  const manualRefresh = useCallback(async (resources: CloudResource[]) => {
    if (!cloudMode) return false;
    const coordinator = coordinatorRef.current;
    if (!coordinator) throw new Error('CLOUD_REFRESH_UNAVAILABLE');
    return coordinator.manualRefresh(resources);
  }, [cloudMode]);

  const refreshAll = useCallback((): Promise<void> => {
    if (globalRefreshInFlight.current) return globalRefreshInFlight.current;
    const mode = getProviderMode();
    setGlobalRefresh(current => ({ ...current, mode, busy: true, errorAt: null, message: '' }));
    // Start after the in-flight reference is installed, including the local
    // no-reader failure path, so a failed click never pins a rejected promise.
    const pending = Promise.resolve().then(async () => {
      try {
        let message = '已更新至最新資料';
        if (cloudMode) {
          const result = await manualRefresh(GLOBAL_REFRESH_RESOURCES);
          if (!result) throw new Error('CLOUD_REFRESH_UNAVAILABLE');
          message = result.conflicts.length > 0
            ? '雲端資料已讀取；你的草稿已保留，同筆資料衝突需要確認。'
            : result.changed === false ? '目前已是最新資料' : message;
        } else {
          // The mounted route already owns its local authoritative reread.
          // Reuse that subscription; do not introduce another local data source.
          const mountedReaders = [...listeners.current];
          if (mountedReaders.length === 0) throw new Error('LOCAL_REFRESH_UNAVAILABLE');
          await Promise.all(mountedReaders.map(reader => reader(GLOBAL_REFRESH_RESOURCES)));
        }
        setGlobalRefresh({ mode, busy: false, errorAt: null, lastCompletedAt: Date.now(), message });
      } catch (error) {
        setGlobalRefresh(current => ({
          ...current, mode, busy: false, errorAt: Date.now(),
          message: '更新失敗，請稍後再試。原資料與草稿已保留，尚未完成更新。',
        }));
        throw error;
      } finally {
        globalRefreshInFlight.current = null;
      }
    });
    globalRefreshInFlight.current = pending;
    return pending;
  }, [cloudMode, manualRefresh]);

  const value = useMemo<CloudRealtimeContextValue>(() => ({
    conflictedResources,
    registerEditing,
    unregister,
    subscribe,
    clearConflict,
    manualRefresh,
    refreshAll,
    globalRefresh,
    syncPresentation,
    connectivity,
    realtimeRecovery,
    reconnectRealtime,
    stagingFaultControl: {
      available: faultControlAllowed && enabled && !testBridge,
      snapshot: {
        ...faultSnapshot,
        readStatus: connectivity.readStatus,
      },
      disconnect: disconnectStagingRealtime,
      reconnect: reconnectStagingRealtime,
    },
  }), [
    clearConflict,
    manualRefresh,
    refreshAll,
    globalRefresh,
    syncPresentation,
    connectivity,
    conflictedResources,
    disconnectStagingRealtime,
    realtimeRecovery,
    reconnectRealtime,
    enabled,
    faultSnapshot,
    faultControlAllowed,
    reconnectStagingRealtime,
    registerEditing,
    subscribe,
    testBridge,
    unregister,
  ]);

  return (
    <CloudRealtimeContext.Provider value={value}>
      <div className="cloud-runtime-frame">
      <div className="cloud-status-stack">
      {cloudMode && syncPresentation.banner && (
        <div
          role="status"
          aria-live="polite"
          data-global-sync-banner={syncPresentation.status}
          style={{
            background: syncPresentation.tone === 'success' ? '#065f46'
              : syncPresentation.tone === 'warning' ? '#92400e' : '#7f1d1d',
            color: '#fff',
          }}
        >
          {syncPresentation.banner}
          {syncPresentation.action === 'realtime-reconnect' && (
            <span data-realtime-recovery={realtimeRecovery?.inFlight ? 'reconnecting' : realtimeRecovery?.nextAt != null ? 'scheduled' : 'waiting'} style={{ marginLeft: 12 }}>
              {realtimeRecovery?.inFlight
                ? '正在重新連線…'
                : realtimeRecovery?.nextAt != null
                  ? `已排定第 ${realtimeRecovery.attempt + 1} 次自動重新連線`
                  : '可按「立即重新連線」再試一次'}
              <button type="button" data-realtime-reconnect onClick={reconnectRealtime} style={{ marginLeft: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer', borderRadius: 4, padding: '0 8px' }}>立即重新連線</button>
            </span>
          )}
        </div>
      )}
      {conflictedResources.size > 0 && (
        <div role="alert" style={{ background: '#fff7ed', color: '#9a3412' }}>
          資料已被其他使用者更新；目前編輯內容未被覆蓋，結束編輯後會自動更新。
        </div>
      )}
      {mutationConflictMessage && (
        <div role="alert" data-cloud-field-conflict style={{ background: '#fff7ed', color: '#9a3412' }}>
          {mutationConflictMessage}
          <button type="button" aria-label="關閉衝突提示" onClick={() => setMutationConflictMessage('')} style={{ marginLeft: 12, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: 800 }}>×</button>
        </div>
      )}
      </div>
      {children}
      </div>
    </CloudRealtimeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- Provider hooks share this context's single authoritative state.
export function useGlobalSyncControl() {
  const context = useContext(CloudRealtimeContext);
  return {
    connectivity: context?.connectivity ?? getCloudConnectivitySnapshot(),
    refresh: context?.globalRefresh ?? { mode: getProviderMode(), busy: false, errorAt: null, lastCompletedAt: null, message: '' },
    presentation: context?.syncPresentation ?? resolveGlobalSyncPresentation(
      getProviderMode(),
      getCloudConnectivitySnapshot(),
      { mode: getProviderMode(), busy: false, errorAt: null, lastCompletedAt: null, message: '' },
    ),
    refreshAll: context?.refreshAll,
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- Provider hooks share this context's single authoritative state.
export function useCloudResourceSync(
  owner: string,
  resources: CloudResource[],
  editing: boolean,
  onRefresh: () => void | Promise<void>,
  draftScope?: CloudDraftScope,
  options?: { rereadProtectedCacheWhileEditing: boolean },
) {
  const context = useContext(CloudRealtimeContext);
  const resourceKey = resources.join('|');
  const refreshRef = useRef(onRefresh);
  const resourcesRef = useRef(resources);
  const draftScopeKey = JSON.stringify(draftScope);

  const registerEditing = context?.registerEditing;
  const unregister = context?.unregister;
  const subscribe = context?.subscribe;
  const rereadWhileEditing = options?.rereadProtectedCacheWhileEditing ?? false;
  // Opt in only when the route keeps drafts separate from persisted rows.
  // CloudTargetedCache retains their original conflict/CAS baseline; rereading
  // that protected cache can therefore update unrelated rows without reset.

  useEffect(() => {
    refreshRef.current = onRefresh;
    resourcesRef.current = resources;
  }, [onRefresh, resourceKey, resources]);

  useEffect(() => {
    registerEditing?.(owner, resourcesRef.current, editing, draftScopeKey ? JSON.parse(draftScopeKey) as CloudDraftScope : undefined);
  }, [editing, owner, registerEditing, resourceKey, draftScopeKey]);

  useEffect(() => () => unregister?.(owner), [owner, unregister]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe(changed => {
      if ((!editing || rereadWhileEditing) && changed.some(resource => resourcesRef.current.includes(resource))) return refreshRef.current();
    });
  }, [editing, resourceKey, subscribe, rereadWhileEditing]);

  return {
    hasRemoteConflict: Boolean(context && resources.some(resource => context.conflictedResources.has(resource))),
    clearRemoteConflict: () => context?.clearConflict(resources),
    stagingFaultControl: context?.stagingFaultControl ?? null,
    refreshAuthoritative: context?.manualRefresh,
  };
}
