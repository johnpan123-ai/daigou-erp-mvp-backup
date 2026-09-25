import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/authContext';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import { supabase } from '../providers/cloud/supabaseClient';
import {
  CLOUD_TABLE_RESOURCE,
  CloudReconnectCatchUp,
  CloudSyncCoordinator,
  resolveCloudRowIdentity,
  type CloudChange,
  type CloudReconnectDiagnostic,
  type CloudResource,
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
  markCloudReachable,
  markCloudUnavailable,
  subscribeCloudConnectivity,
} from '../providers/cloud/cloudConnectivity';

interface CloudRealtimeContextValue {
  conflictedResources: ReadonlySet<CloudResource>;
  registerEditing: (owner: string, resources: CloudResource[], editing: boolean, draftScope?: CloudDraftScope) => void;
  unregister: (owner: string) => void;
  subscribe: (listener: (resources: CloudResource[]) => void) => () => void;
  clearConflict: (resources: CloudResource[]) => void;
}

const CloudRealtimeContext = createContext<CloudRealtimeContextValue | null>(null);

const REALTIME_TABLES = Object.keys(CLOUD_TABLE_RESOURCE);

export function CloudRealtimeSyncBoundary({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const testBridge = getCloudRealtimeTestBridge();
  const enabled = (getProviderMode() === 'cloud' || Boolean(testBridge)) && Boolean(user);
  const editingOwners = useRef(new Map<string, { resources: Set<CloudResource>; editing: boolean; draftScope?: CloudDraftScope }>());
  const listeners = useRef(new Set<(resources: CloudResource[]) => void>());
  const coordinatorRef = useRef<CloudSyncCoordinator | null>(null);
  const reconnectRef = useRef<CloudReconnectCatchUp | null>(null);
  const reconnectDiagnostics = useRef<CloudReconnectDiagnostic[]>([]);
  const [conflictedResources, setConflictedResources] = useState<Set<CloudResource>>(new Set());
  const [mutationConflictMessage, setMutationConflictMessage] = useState('');
  const connectivity = useSyncExternalStore(
    subscribeCloudConnectivity,
    getCloudConnectivitySnapshot,
    getCloudConnectivitySnapshot,
  );
  const cloudMode = ['cloud', 'fallback'].includes(getProviderMode()) || Boolean(testBridge);
  const showCloudReadStatus = connectivity.status !== 'online'
    || (connectivity.readStatus === 'loading' && connectivity.reason !== 'cloud-background-read')
    || connectivity.readStatus === 'stale-cache'
    || connectivity.readStatus === 'read-error'
    || connectivity.readStatus === 'offline'
    || connectivity.readStatus === 'fresh-empty';

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
    listeners.current.forEach(listener => listener(resources));
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
    });
    coordinatorRef.current = coordinator;
    const activeResources = () => [...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))];
    const reconnect = new CloudReconnectCatchUp({
      refresh: (resources, signal) => coordinator.fallback('reconnect', resources, signal),
      retryDelaysMs: testBridge ? [10, 25, 50, 100] : undefined,
      onDiagnostic: diagnostic => {
        reconnectDiagnostics.current = [...reconnectDiagnostics.current.slice(-49), diagnostic];
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
    } else {
      channel = supabase.channel(`erp-live-${user!.id}`);
      for (const table of REALTIME_TABLES) {
        channel = channel.on('postgres_changes' as never, { event: '*', schema: 'public', table }, payload => {
          handlePayload(table, payload as unknown as CloudRealtimeTestPayload);
        });
      }

      let subscribedOnce = false;
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') {
          markCloudReachable();
          if (subscribedOnce || reconnect.isPending()) {
            void reconnect.request('subscribed', activeResources());
          }
          subscribedOnce = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          markCloudUnavailable(`realtime-${status.toLowerCase()}`);
          reconnect.markNeeded('channel-interrupted');
        }
      });
    }

    const needsAuthoritativeCatchUp = () => {
      const { readStatus } = getCloudConnectivitySnapshot();
      return reconnect.isPending() && readStatus !== 'fresh-online' && readStatus !== 'fresh-empty';
    };
    const handleFocus = () => {
      if (needsAuthoritativeCatchUp()) void reconnect.request('focus', activeResources());
      else void coordinator.fallback('focus', activeResources());
    };
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (needsAuthoritativeCatchUp()) void reconnect.request('visibility', activeResources());
      else void coordinator.fallback('visibility', activeResources());
    };
    const handleOnline = () => {
      void reconnect.request('online', activeResources());
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener('cloud-cross-tab-change', handleFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('cloud-cross-tab-change', handleFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
      if (reconnectRef.current === reconnect) reconnectRef.current = null;
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

  const registerEditing = useCallback((owner: string, resources: CloudResource[], editing: boolean, draftScope?: CloudDraftScope) => {
    const previous = editingOwners.current.get(owner);
    const affected = [...new Set([...(previous?.resources ?? []), ...resources])];
    const wasEditing = new Set(affected.filter(isEditing));
    editingOwners.current.set(owner, { resources: new Set(resources), editing, draftScope });
    reconnectRef.current?.updateResources([...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))]);
    resumeAfterEditing(affected.filter(resource => wasEditing.has(resource) && !isEditing(resource)));
  }, [isEditing, resumeAfterEditing]);

  const unregister = useCallback((owner: string) => {
    const previous = editingOwners.current.get(owner);
    if (!previous) return;
    const affected = [...previous.resources];
    const wasEditing = new Set(affected.filter(isEditing));
    editingOwners.current.delete(owner);
    reconnectRef.current?.updateResources([...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))]);
    resumeAfterEditing(affected.filter(resource => wasEditing.has(resource) && !isEditing(resource)));
  }, [isEditing, resumeAfterEditing]);

  const subscribe = useCallback((listener: (resources: CloudResource[]) => void) => {
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

  const value = useMemo<CloudRealtimeContextValue>(() => ({
    conflictedResources,
    registerEditing,
    unregister,
    subscribe,
    clearConflict,
  }), [clearConflict, conflictedResources, registerEditing, subscribe, unregister]);

  return (
    <CloudRealtimeContext.Provider value={value}>
      <div className="cloud-runtime-frame">
      <div className="cloud-status-stack">
      {cloudMode && showCloudReadStatus && (
        <div role="status" aria-live="polite" style={{ background: connectivity.readStatus === 'fresh-empty' ? '#065f46' : '#7f1d1d', color: '#fff' }}>
          {connectivity.status === 'offline'
            ? 'Offline｜顯示最後雲端快取，所有新增、修改、刪除與匯入已停用'
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

export function useCloudResourceSync(
  owner: string,
  resources: CloudResource[],
  editing: boolean,
  onRefresh: () => void | Promise<void>,
  draftScope?: CloudDraftScope,
) {
  const context = useContext(CloudRealtimeContext);
  const resourceKey = resources.join('|');
  const refreshRef = useRef(onRefresh);
  const resourcesRef = useRef(resources);
  const draftScopeKey = JSON.stringify(draftScope);

  const registerEditing = context?.registerEditing;
  const unregister = context?.unregister;
  const subscribe = context?.subscribe;

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
      if (!editing && changed.some(resource => resourcesRef.current.includes(resource))) void refreshRef.current();
    });
  }, [editing, resourceKey, subscribe]);

  return {
    hasRemoteConflict: Boolean(context && resources.some(resource => context.conflictedResources.has(resource))),
    clearRemoteConflict: () => context?.clearConflict(resources),
  };
}
