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
import type { GlobalRefreshSnapshot } from './globalSyncPresentation';
import {
  StagingRealtimeFaultControl,
  type RealtimeChannelState,
  type StagingRealtimeFaultSnapshot,
} from '../lib/stagingRealtimeFaultControl';
import { assertP04HarnessBoundary } from '../lib/stagingP04AuthenticatedHarness';

interface CloudRealtimeContextValue {
  conflictedResources: ReadonlySet<CloudResource>;
  registerEditing: (owner: string, resources: CloudResource[], editing: boolean, draftScope?: CloudDraftScope) => void;
  unregister: (owner: string) => void;
  subscribe: (listener: (resources: CloudResource[]) => void | Promise<void>) => () => void;
  clearConflict: (resources: CloudResource[]) => void;
  manualRefresh: (resources: CloudResource[]) => Promise<CloudRefreshResult | false>;
  refreshAll: () => Promise<void>;
  globalRefresh: GlobalRefreshSnapshot;
  connectivity: CloudConnectivitySnapshot;
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
  const showCloudReadStatus = connectivity.status !== 'online'
    || (connectivity.readStatus === 'loading' && connectivity.reason !== 'cloud-background-read')
    || connectivity.readStatus === 'stale-cache'
    || connectivity.readStatus === 'read-error'
    || connectivity.readStatus === 'offline'
    || connectivity.readStatus === 'fresh-empty';
  const isSoftCloudReadTimeout = connectivity.reason?.includes('Cloud sync timed out after 4000ms') ?? false;

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
    const coordinator = new CloudSyncCoordinator({
      refresh: (request, signal) => cache.refreshWithResult(request, signal),
      authoritativeDrafts: true,
      isEditing,
      onRefreshed: notifyRefreshed,
      onConflict: notifyConflict,
      onCommitted: async resources => { await Promise.all([...listeners.current].map(listener => listener(resources))); },
    });
    coordinatorRef.current = coordinator;
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
    const reconnect = new CloudReconnectCatchUp({
      refresh: (resources, signal) => coordinator.fallback('reconnect', resources, signal),
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
    let subscribedOnce = false;
    let faultDisconnected = false;
    let disposed = false;
    let stagingFaultController: StagingRealtimeFaultControl | null = null;

    const removeRealtimeChannel = async (currentChannel: NonNullable<typeof channel>) => {
      const result = await supabase.removeChannel(currentChannel);
      if (result !== 'ok') throw new Error(`P0_4_REALTIME_DISCONNECT_${String(result).toUpperCase().replaceAll(' ', '_')}`);
    };

    const subscribeRealtimeChannel = (forceAuthoritativeCatchUp: boolean): Promise<boolean> => {
      channelState = 'subscribing';
      publishFaultSnapshot();
      const generation = ++channelGeneration;
      let nextChannel = supabase.channel(`erp-live-${user!.id}`);
      for (const table of REALTIME_TABLES) {
        nextChannel = nextChannel.on('postgres_changes' as never, { event: '*', schema: 'public', table }, payload => {
          if (disposed || generation !== channelGeneration || channel !== nextChannel) return;
          handlePayload(table, payload as unknown as CloudRealtimeTestPayload);
        });
      }
      nextChannel = nextChannel.on('postgres_changes' as never, {
        event: 'UPDATE', schema: 'public', table: CLOUD_RESTORE_EPOCH_TABLE,
      }, () => {
        if (disposed || generation !== channelGeneration || channel !== nextChannel) return;
        reconnect.markNeeded('channel-interrupted');
        void reconnect.request('subscribed', activeResources());
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
            const { readStatus } = getCloudConnectivitySnapshot();
            const hasFreshAuthority = readStatus === 'fresh-online' || readStatus === 'fresh-empty';
            const needsCatchUp = forceAuthoritativeCatchUp || subscribedOnce || reconnect.isPending() || !hasFreshAuthority;
            subscribedOnce = true;
            publishFaultSnapshot();
            if (!needsCatchUp) {
              settle(true);
              return;
            }
            reconnect.ensurePending('subscribed');
            reconnect.updateResources(activeResources());
            void reconnect.waitForCurrentCycle().then(completed => {
              publishFaultSnapshot();
              settle(completed, completed ? undefined : new Error('P0_4_REALTIME_CATCH_UP_INCOMPLETE'));
            });
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            channelState = 'error';
            markCloudUnavailable(`realtime-${status.toLowerCase()}`);
            reconnect.markNeeded('channel-interrupted');
            publishFaultSnapshot();
            settle(false, new Error(`P0_4_REALTIME_${status}`));
          }
        });
      });
    };

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
            channelState = 'disconnecting';
            publishFaultSnapshot();
            reconnect.markNeeded('channel-interrupted');
            markCloudUnavailable('realtime-test-disconnected');
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
    const handleFocus = () => {
      if (faultDisconnected) return;
      if (needsAuthoritativeCatchUp()) void reconnect.request('focus', activeResources());
      else void coordinator.fallback('focus', activeResources());
    };
    const handleVisibility = () => {
      if (faultDisconnected) return;
      if (document.visibilityState !== 'visible') return;
      if (needsAuthoritativeCatchUp()) void reconnect.request('visibility', activeResources());
      else void coordinator.fallback('visibility', activeResources());
    };
    const handleOnline = () => {
      if (faultDisconnected) return;
      void reconnect.request('online', activeResources());
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener('cloud-cross-tab-change', handleFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      channelGeneration += 1;
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('cloud-cross-tab-change', handleFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
      if (reconnectRef.current === reconnect) reconnectRef.current = null;
      if (faultControllerRef.current === stagingFaultController) faultControllerRef.current = null;
      testBridge?.detach?.();
      reconnect.dispose();
      coordinator.dispose();
      if (channel) void supabase.removeChannel(channel);
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
    connectivity,
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
    connectivity,
    conflictedResources,
    disconnectStagingRealtime,
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
      {cloudMode && showCloudReadStatus && (
        <div role="status" aria-live="polite" style={{ background: connectivity.readStatus === 'fresh-empty' ? '#065f46' : isSoftCloudReadTimeout ? '#92400e' : '#7f1d1d', color: '#fff' }}>
          {connectivity.status === 'offline'
            ? 'Offline｜顯示最後雲端快取，所有新增、修改、刪除與匯入已停用'
            : isSoftCloudReadTimeout
              ? connectivity.readStatus === 'stale-cache'
                ? '雲端仍在同步｜目前顯示上次快取；寫入已暫停'
                : '雲端仍在同步｜等待最新資料；寫入已暫停'
            : connectivity.readStatus === 'stale-cache'
              ? '雲端讀取失敗｜目前顯示舊快取，資料不是最新；寫入已暫停'
              : connectivity.readStatus === 'read-error'
                ? '雲端讀取失敗｜目前沒有可確認的最新資料；寫入已暫停'
                : connectivity.readStatus === 'offline'
                  ? '雲端已恢復連線｜等待重新讀取雲端最新資料；寫入仍暫停'
                : connectivity.readStatus === 'fresh-empty'
                  ? '雲端已確認｜目前沒有資料'
                  : '雲端資料讀取中｜所有新增、修改、刪除與匯入暫停'}
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
    refreshAll: context?.refreshAll,
  };
}

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
