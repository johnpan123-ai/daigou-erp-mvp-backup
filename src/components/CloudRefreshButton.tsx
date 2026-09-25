import { useEffect, useRef, useState } from 'react';
import { getProviderMode } from '../providers/providerMode';
import type { CloudResource } from '../providers/cloud/cloudSyncDomain';

export function CloudRefreshButton({ resources, onLocalRefresh, refresh }: {
  resources: CloudResource[];
  onLocalRefresh: () => void | Promise<void>;
  refresh?: (resources: CloudResource[]) => Promise<boolean>;
}) {
  const pending = useRef(false);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reload = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (!refresh && ['cloud', 'fallback'].includes(getProviderMode())) throw new Error('CLOUD_REFRESH_UNAVAILABLE');
      const authoritative = await refresh?.(resources);
      if (!authoritative) await onLocalRefresh();
      // Cloud consumers reread only after commit notification, not before it.
      // In particular, an editing consumer must not replace its draft/base.
    } catch {
      if (mounted.current) setError('無法取得最新雲端資料；原資料與草稿已保留，尚未完成更新。');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <div style={{ marginBottom: 12 }}>
    {/* Keep worksheet focus: its blur handler commits a draft, which refresh must not do. */}
    <button type="button" className="btn btn-outline" disabled={busy} aria-busy={busy}
      onMouseDown={event => event.preventDefault()}
      onClick={() => void reload()}>
      {busy ? '更新中…' : '重新載入最新資料'}
    </button>
    {error && <div role="alert">{error}</div>}
  </div>;
}
