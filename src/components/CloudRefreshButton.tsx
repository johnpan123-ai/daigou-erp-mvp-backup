import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getProviderMode } from '../providers/providerMode';
import type { CloudRefreshResult, CloudResource } from '../providers/cloud/cloudSyncDomain';
import './CloudRefreshButton.css';

export function CloudRefreshButton({ resources, onLocalRefresh, refresh }: {
  resources: CloudResource[];
  onLocalRefresh: () => void | Promise<void>;
  refresh?: (resources: CloudResource[]) => Promise<CloudRefreshResult | false>;
}) {
  const pending = useRef(false);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reload = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (!refresh && ['cloud', 'fallback'].includes(getProviderMode())) throw new Error('CLOUD_REFRESH_UNAVAILABLE');
      const authoritative = await refresh?.(resources);
      if (!authoritative) await onLocalRefresh();
      if (mounted.current) setMessage(authoritative && authoritative.conflicts.length > 0
        ? '雲端資料已讀取；你的草稿已保留，同筆資料衝突需要確認。'
        : authoritative && authoritative.changed === false ? '目前已是最新資料' : '已更新至最新資料');
    } catch {
      if (mounted.current) setError('更新失敗，請稍後再試。原資料與草稿已保留，尚未完成更新。');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <div className="cloud-refresh-control">
    {/* Keep worksheet focus: its blur handler commits a draft, which refresh must not do. */}
    <button type="button" className="btn cloud-refresh-button" disabled={busy} aria-busy={busy}
      onMouseDown={event => event.preventDefault()}
      onClick={() => void reload()}>
      <RefreshCw size={17} aria-hidden="true" className={busy ? 'cloud-refresh-spinner' : undefined} />
      {busy ? '正在更新…' : '重新載入最新資料'}
    </button>
    <div className="cloud-refresh-feedback" role={error ? 'alert' : 'status'} aria-live="polite">
      {error || (busy ? '正在讀取最新雲端資料…' : message)}
    </div>
  </div>;
}
