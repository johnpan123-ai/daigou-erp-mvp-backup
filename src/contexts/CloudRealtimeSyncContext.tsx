import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import { supabase } from '../providers/cloud/supabaseClient';
import {
  CLOUD_TABLE_RESOURCE,
  CloudSyncCoordinator,
  resolveCloudRowIdentity,
  type CloudChange,
  type CloudResource,
} from '../providers/cloud/cloudSyncDomain';
import { CloudTargetedCache } from '../providers/cloud/cloudTargetedCache';
import { consumeLocalCloudEcho } from '../providers/cloud/cloudRealtimeEchoRegistry';
import {
  getCloudConnectivitySnapshot,
  markCloudReachable,
  markCloudRequestFailed,
  markCloudUnavailable,
  subscribeCloudConnectivity,
} from '../providers/cloud/cloudConnectivity';

interface CloudRealtimeContextValue {
  conflictedResources: ReadonlySet<CloudResource>;
  registerEditing: (owner: string, resources: CloudResource[], editing: boolean) => void;
  unregister: (owner: string) => void;
  subscribe: (listener: (resources: CloudResource[]) => void) => () => void;
  clearConflict: (resources: CloudResource[]) => void;
}

const CloudRealtimeContext = createContext<CloudRealtimeContextValue | null>(null);

const REALTIME_TABLES = Object.keys(CLOUD_TABLE_RESOURCE);

export function CloudRealtimeSyncBoundary({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const enabled = getProviderMode() === 'cloud' && Boolean(user);
  const editingOwners = useRef(new Map<string, { resources: Set<CloudResource>; editing: boolean }>());
  const listeners = useRef(new Set<(resources: CloudResource[]) => void>());
  const [conflictedResources, setConflictedResources] = useState<Set<CloudResource>>(new Set());
  const connectivity = useSyncExternalStore(
    subscribeCloudConnectivity,
    getCloudConnectivitySnapshot,
    getCloudConnectivitySnapshot,
  );
  const cloudMode = ['cloud', 'fallback'].includes(getProviderMode());
  const showCloudReadStatus = connectivity.status !== 'online'
    || connectivity.readStatus === 'loading'
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

  const isEditing = useCallback((resource: CloudResource) => (
    [...editingOwners.current.values()].some(scope => scope.editing && scope.resources.has(resource))
  ), []);

  const notifyRefreshed = useCallback((resources: CloudResource[]) => {
    dataProvider.clearCloudStale(resources);
    listeners.current.forEach(listener => listener(resources));
  }, []);

  const notifyConflict = useCallback((resources: CloudResource[]) => {
    setConflictedResources(current => new Set([...current, ...resources]));
    dataProvider.markCloudStale(resources);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const cache = new CloudTargetedCache();
    cache.initializeCursor();
    const coordinator = new CloudSyncCoordinator({
      refresh: request => cache.refresh(request),
      isEditing,
      onRefreshed: notifyRefreshed,
      onConflict: notifyConflict,
    });

    let channel = supabase.channel(`erp-live-${user!.id}`);
    for (const table of REALTIME_TABLES) {
      channel = channel.on('postgres_changes' as any, { event: '*', schema: 'public', table }, (payload: any) => {
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
      });
    }

    let subscribedOnce = false;
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        markCloudReachable();
        if (subscribedOnce) {
          const active = [...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))];
          void coordinator.fallback('reconnect', active);
        }
        subscribedOnce = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        markCloudUnavailable(`realtime-${status.toLowerCase()}`);
      }
    });

    const activeResources = () => [...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))];
    const handleFocus = () => { void coordinator.fallback('focus', activeResources()); };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void coordinator.fallback('visibility', activeResources());
    };
    const handleOnline = () => {
      void coordinator.fallback('reconnect', activeResources()).catch(markCloudRequestFailed);
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      coordinator.dispose();
      void supabase.removeChannel(channel);
    };
  }, [enabled, isEditing, notifyConflict, notifyRefreshed, user]);

  const value = useMemo<CloudRealtimeContextValue>(() => ({
    conflictedResources,
    registerEditing: (owner, resources, editing) => {
      editingOwners.current.set(owner, { resources: new Set(resources), editing });
    },
    unregister: owner => { editingOwners.current.delete(owner); },
    subscribe: listener => {
      listeners.current.add(listener);
      return () => { listeners.current.delete(listener); };
    },
    clearConflict: resources => {
      setConflictedResources(current => {
        const next = new Set(current);
        resources.forEach(resource => next.delete(resource));
        return next;
      });
      dataProvider.clearCloudStale(resources);
    },
  }), [conflictedResources]);

  return (
    <CloudRealtimeContext.Provider value={value}>
      {cloudMode && showCloudReadStatus && (
        <div role="status" aria-live="polite" style={{ position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 10060, padding: '9px 15px', borderRadius: 8, background: connectivity.readStatus === 'fresh-empty' ? '#065f46' : '#7f1d1d', color: '#fff', border: `1px solid ${connectivity.readStatus === 'fresh-empty' ? '#6ee7b7' : '#fecaca'}`, boxShadow: '0 4px 12px rgba(15,23,42,.18)', fontSize: 13, fontWeight: 700 }}>
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
        <div role="alert" style={{ position: 'fixed', top: showCloudReadStatus ? 54 : 8, left: '50%', transform: 'translateX(-50%)', zIndex: 10050, padding: '8px 14px', borderRadius: 8, background: '#fff7ed', color: '#9a3412', border: '1px solid #fdba74', boxShadow: '0 4px 12px rgba(15,23,42,.12)', fontSize: 13, fontWeight: 600 }}>
          資料已被其他使用者更新；目前編輯內容未被覆蓋，請重新載入後再儲存。
        </div>
      )}
      {children}
    </CloudRealtimeContext.Provider>
  );
}

export function useCloudResourceSync(
  owner: string,
  resources: CloudResource[],
  editing: boolean,
  onRefresh: () => void | Promise<void>,
) {
  const context = useContext(CloudRealtimeContext);
  const resourceKey = resources.join('|');
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!context) return;
    context.registerEditing(owner, resources, editing);
    return () => context.unregister(owner);
  }, [context, editing, owner, resourceKey]);

  useEffect(() => {
    if (!context) return;
    return context.subscribe(changed => {
      if (!editing && changed.some(resource => resources.includes(resource))) void refreshRef.current();
    });
  }, [context, editing, resourceKey]);

  return {
    hasRemoteConflict: Boolean(context && resources.some(resource => context.conflictedResources.has(resource))),
    clearRemoteConflict: () => context?.clearConflict(resources),
  };
}
