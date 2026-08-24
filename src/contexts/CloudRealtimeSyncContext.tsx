import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { consumeLocalCloudEchoAliases } from '../providers/cloud/cloudRealtimeEchoRegistry';

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
        const { rowId, databaseId } = resolveCloudRowIdentity(row || {});
        if (!rowId) return;
        const isLocalEcho = consumeLocalCloudEchoAliases(table, [rowId, databaseId]);
        coordinator.receive({
          table,
          rowId,
          databaseId,
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
        if (subscribedOnce) {
          const active = [...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))];
          void coordinator.fallback('reconnect', active);
        }
        subscribedOnce = true;
      }
    });

    const activeResources = () => [...new Set([...editingOwners.current.values()].flatMap(scope => [...scope.resources]))];
    const handleFocus = () => { void coordinator.fallback('focus', activeResources()); };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void coordinator.fallback('visibility', activeResources());
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('focus', handleFocus);
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
      {conflictedResources.size > 0 && (
        <div role="alert" style={{ position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 10050, padding: '8px 14px', borderRadius: 8, background: '#fff7ed', color: '#9a3412', border: '1px solid #fdba74', boxShadow: '0 4px 12px rgba(15,23,42,.12)', fontSize: 13, fontWeight: 600 }}>
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
