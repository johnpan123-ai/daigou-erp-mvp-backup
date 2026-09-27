import { RefreshCw } from 'lucide-react';
import { useGlobalSyncControl } from '../../contexts/CloudRealtimeSyncContext';
import { GLOBAL_SYNC_LABELS, resolveGlobalSyncStatus } from '../../contexts/globalSyncPresentation';
import { getProviderMode } from '../../providers/providerMode';

const symbols = { fresh: '●', syncing: '◌', cached: '⚠', failed: '✕' } as const;

export function GlobalSyncControl() {
  const { connectivity, refresh, refreshAll } = useGlobalSyncControl();
  const mode = getProviderMode();
  const activeRefresh = refresh.mode === mode
    ? refresh : { mode, busy: false, errorAt: null, lastCompletedAt: null, message: '' };
  const status = resolveGlobalSyncStatus(mode, connectivity, activeRefresh);
  const lastSync = mode === 'cloud' || mode === 'fallback'
    ? connectivity.lastFreshReadAt : activeRefresh.lastCompletedAt;
  const tooltip = lastSync ? `最後同步：${new Date(lastSync).toLocaleString('zh-TW', { hour12: false })}` : undefined;

  return (
    <div className="global-sync-control" data-global-sync-control>
      <span className={`global-sync-status global-sync-status--${status}`} role="status" title={tooltip} aria-live="polite">
        <span aria-hidden="true">{symbols[status]}</span> {GLOBAL_SYNC_LABELS[status]}
      </span>
      <button
        type="button"
        className="global-sync-button"
        disabled={!refreshAll || activeRefresh.busy}
        aria-busy={activeRefresh.busy}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { void refreshAll?.().catch(() => undefined); }}
      >
        <RefreshCw size={14} aria-hidden="true" className={activeRefresh.busy ? 'cloud-refresh-spinner' : undefined} />
        {activeRefresh.busy ? '同步中…' : '同步資料'}
      </button>
      <span className="global-sync-feedback" role={activeRefresh.errorAt ? 'alert' : 'status'} aria-live="polite">
        {activeRefresh.message}
      </span>
    </div>
  );
}
