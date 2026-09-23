import { useCallback, useEffect, useRef, useState } from 'react';

type LoadWork<T> = () => Promise<T>;
type CommitWork<T> = (value: T) => void;

/**
 * Keeps an already-rendered page mounted while a newer authoritative snapshot
 * is read. Only the cold start is allowed to enter the full-page loading state.
 * A generation guard prevents an older response from replacing a newer commit.
 */
export function useMountedContentLoadState() {
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasUsableData, setHasUsableData] = useState(false);
  const hasUsableDataRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

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
      const value = await read();
      if (!mountedRef.current || generation !== generationRef.current) return false;
      commit(value);
      hasUsableDataRef.current = true;
      setHasUsableData(true);
      return true;
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setIsInitialLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  return { hasUsableData, isInitialLoading, isRefreshing, runLoad };
}
