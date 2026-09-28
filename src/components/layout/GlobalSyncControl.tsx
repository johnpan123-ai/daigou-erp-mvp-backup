import { RefreshCw } from 'lucide-react';
import { useGlobalSyncControl } from '../../contexts/CloudRealtimeSyncContext';
import { getProviderMode } from '../../providers/providerMode';

const symbols = { local: '●', fresh: '●', syncing: '◌', 'syncing-cached': '◌', cached: '⚠', failed: '✕' } as const;

export function GlobalSyncControl() {
  const { connectivity, refresh, presentation, refreshAll } = useGlobalSyncControl();
  const mode = getProviderMode();
  const activeRefresh = refresh.mode === mode
    ? refresh : { mode, busy: false, errorAt: null, lastCompletedAt: null, message: '' };
  const status = presentation.status;
  const lastSync = mode === 'cloud' || mode === 'fallback'
    ? connectivity.lastFreshReadAt : activeRefresh.lastCompletedAt;
  const tooltip = lastSync ? `最後同步：${new Date(lastSync).toLocaleString('zh-TW', { hour12: false })}` : undefined;

  return (
    <div className="global-sync-control" data-global-sync-control>
      <span className={`global-sync-status global-sync-status--${status}`} role="status" title={tooltip} aria-live="polite">
        <span aria-hidden="true">{symbols[status]}</span> {presentation.label}
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
