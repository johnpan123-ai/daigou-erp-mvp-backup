import { useCallback, useEffect, useRef, useState } from 'react';
import { getViewSnapshotGeneration } from '../lib/viewSnapshotGeneration';

type LoadWork<T> = () => Promise<T>;
type CommitWork<T> = (value: T) => void;

/**
 * Last committed read per page, in module memory (same tab/session). It lets a remounted page
 * (route return, list -> detail) paint its previous content at once while the normal read runs
 * as a background refresh. Entries are only reused for the same scope (provider mode + user)
 * and the same cloud cache generation, so logout, account/mode switches, Restore and
 * authoritative rereads never show an old snapshot.
 */
const returnCache = new Map<string, { scope: string; generation: number; value: unknown }>();

export interface MountedContentCacheOptions {
  /** Page identity; the page's read must not depend on route params (filter per id on commit). */
  cacheKey: string;
  /** Provider mode + signed-in user. */
  scope: string;
  /** Reject a cached read that cannot serve this mount (e.g. it lacks the requested record). */
  accept?: (value: unknown) => boolean;
}

/**
 * Keeps an already-rendered page mounted while a newer authoritative snapshot
 * is read. Only the cold start is allowed to enter the full-page loading state.
 * A generation guard prevents an older response from replacing a newer commit.
 * With `cache`, a remount starts from the last committed read (`cached`) and the
 * first read is treated as a refresh instead of a cold start.
 */
export function useMountedContentLoadState<C = unknown>(cache?: MountedContentCacheOptions) {
  const [cached] = useState<C | null>(() => {
    if (!cache) return null;
    const entry = returnCache.get(cache.cacheKey);
    if (!entry || entry.scope !== cache.scope || entry.generation !== getViewSnapshotGeneration()) return null;
    return !cache.accept || cache.accept(entry.value) ? entry.value as C : null;
  });
  const [isInitialLoading, setIsInitialLoading] = useState(() => cached === null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasUsableData, setHasUsableData] = useState(() => cached !== null);
  const hasUsableDataRef = useRef(cached !== null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const runLoad = useCallback(async <T,>(read: LoadWork<T>, commit: CommitWork<T>) => {
    const generation = ++generationRef.current;
    const isInitialLoad = !hasUsableDataRef.current;
    if (isInitialLoad) setIsInitialLoading(true);
    else setIsRefreshing(true);

    try {
      const cacheGeneration = getViewSnapshotGeneration();
      const value = await read();
      if (!mountedRef.current || generation !== generationRef.current) return false;
      commit(value);
      hasUsableDataRef.current = true;
      setHasUsableData(true);
      const options = cacheRef.current;
      // A read that straddled a cache invalidation is shown but not kept for later remounts.
      if (options && cacheGeneration === getViewSnapshotGeneration()) {
        returnCache.set(options.cacheKey, { scope: options.scope, generation: cacheGeneration, value });
      }
      return true;
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setIsInitialLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  return { cached, hasUsableData, isInitialLoading, isRefreshing, runLoad };
}

/**
 * Applies a page's own committed edits to a cached read so the next remount does not briefly
 * show pre-edit content. No-op when nothing is cached (or it belongs to another generation).
 */
export function patchMountedContentCache<T>(cacheKey: string, scope: string, patch: (value: T) => T): void {
  const entry = returnCache.get(cacheKey);
  if (!entry || entry.scope !== scope || entry.generation !== getViewSnapshotGeneration()) return;
  returnCache.set(cacheKey, { ...entry, value: patch(entry.value as T) });
}

/** Forget a cached read (e.g. after deleting the record it shows); the next mount cold-loads. */
export function dropMountedContentCache(cacheKey: string): void {
  returnCache.delete(cacheKey);
}
