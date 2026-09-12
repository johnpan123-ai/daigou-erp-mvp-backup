import { useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, FileCheck2, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth/authContext';
import { useRole } from '../auth/useRole';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import {
  getCloudConnectivitySnapshot,
  subscribeCloudConnectivity,
} from '../providers/cloud/cloudConnectivity';
import { useCloudResourceSync } from '../contexts/CloudRealtimeSyncContext';
import type { CloudResource } from '../providers/cloud/cloudSyncDomain';
import {
  CLOUD_RESTORE_TABLES,
  prepareCloudRestoreSnapshot,
  type CloudRestoreCandidate,
  type CloudRestoreResult,
} from '../providers/cloud/cloudAtomicRestore';
import {
  CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE,
  formatCloudRestoreSubmitError,
  inspectCurrentCloudRestoreReadiness,
  normalizeCloudRestoreSubmitError,
  readOrCreateCloudRestoreIdempotencyKey,
  recordCloudRestoreSubmitDiagnostic,
} from '../providers/cloud/cloudRestoreSubmit';

const CONFIRMATION_TEXT = 'OVERWRITE CLOUD DATA';
const CLOUD_RESTORE_READINESS_RESOURCES: CloudResource[] = [
  'products',
  'purchases',
  'privateOrders',
  'inventory',
  'bundles',
  'japanPackages',
  'outboundShipments',
  'salesOrders',
];
const ignoreCloudResourceRefresh = () => {};

interface CloudAtomicRestorePanelProps {
  executeRestore?: (command: Parameters<typeof dataProvider.restoreCloudSnapshot>[0]) => ReturnType<typeof dataProvider.restoreCloudSnapshot>;
}

interface PendingRestoreAttempt {
  correlationId: string;
  idempotencyKey: string;
  fingerprint: string;
}

export default function CloudAtomicRestorePanel({ executeRestore }: CloudAtomicRestorePanelProps = {}) {
  const { user } = useAuth();
  const { role } = useRole();
  const fileRef = useRef<HTMLInputElement>(null);
  const retryKeys = useRef(new Map<string, string>());
  const pendingAttemptRef = useRef<PendingRestoreAttempt | null>(null);
  const inFlightRef = useRef(false);
  const submissionLockedRef = useRef(false);
  const [candidate, setCandidate] = useState<CloudRestoreCandidate | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<'idle' | 'preflighting' | 'ready' | 'confirming' | 'restoring' | 'success' | 'error' | 'unknown'>('idle');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<CloudRestoreResult | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const cloudMode = getProviderMode() === 'cloud';
  const owner = role === 'owner';
  const connectivity = useSyncExternalStore(
    subscribeCloudConnectivity,
    getCloudConnectivitySnapshot,
    getCloudConnectivitySnapshot,
  );
  const browserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
  const online = browserOnline && connectivity.status === 'online';
  const fresh = connectivity.readStatus === 'fresh-online' || connectivity.readStatus === 'fresh-empty';
  const canPreflight = cloudMode && Boolean(user) && owner && online;
  const allowed = canPreflight && fresh;
  useCloudResourceSync(
    'cloud-restore-authoritative-readiness',
    CLOUD_RESTORE_READINESS_RESOURCES,
    false,
    ignoreCloudResourceRefresh,
  );

  const selectFile = async (file: File | undefined) => {
    if (!file) return;
    setStatus('preflighting');
    setMessage('正在本機解析並檢查 JSON；尚未寫入雲端。');
    setCandidate(null);
    setResult(null);
    submissionLockedRef.current = false;
    pendingAttemptRef.current = null;
    setConfirmationOpen(false);
    try {
      const prepared = await prepareCloudRestoreSnapshot(await file.text(), {
        fileName: file.name,
        sourceEnvironment: window.location.origin,
      });
      setCandidate(prepared);
      setStatus('ready');
      setMessage('Preflight 通過。請核對 15 個資源與 fingerprint，再完成第二次明確確認。');
    } catch (error) {
      setStatus('error');
      setMessage(formatCloudRestoreSubmitError(normalizeCloudRestoreSubmitError(error, 'submit', {
        source: 'local',
      })));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const beginConfirmation = () => {
    if (!candidate || !allowed || confirmation !== CONFIRMATION_TEXT) return;
    if (inFlightRef.current || pendingAttemptRef.current || submissionLockedRef.current) return;
    const fingerprint = candidate.manifest.snapshotFingerprint;
    const pending = {
      correlationId: crypto.randomUUID(),
      idempotencyKey: readOrCreateCloudRestoreIdempotencyKey(fingerprint, retryKeys.current),
      fingerprint,
    };
    pendingAttemptRef.current = pending;
    recordCloudRestoreSubmitDiagnostic({
      event: 'submit-start',
      phase: 'confirmation',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
      readStatus: getCloudConnectivitySnapshot().readStatus,
    });
    setStatus('confirming');
    setMessage('請在最終確認對話框再次核對目前雲端狀態。');
    setConfirmationOpen(true);
  };

  const cancelConfirmation = () => {
    const pending = pendingAttemptRef.current;
    if (!pending || inFlightRef.current) return;
    recordCloudRestoreSubmitDiagnostic({
      event: 'confirmation-complete',
      phase: 'confirmation',
      outcome: 'cancelled',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
      readStatus: getCloudConnectivitySnapshot().readStatus,
    });
    recordCloudRestoreSubmitDiagnostic({
      event: 'submit-finish',
      phase: 'submit',
      outcome: 'cancelled',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
    });
    pendingAttemptRef.current = null;
    setConfirmationOpen(false);
    setStatus('ready');
    setMessage('已取消；本次尚未送出。');
  };

  const execute = async () => {
    const pending = pendingAttemptRef.current;
    if (!candidate || !pending || inFlightRef.current || submissionLockedRef.current) return;
    if (pending.fingerprint !== candidate.manifest.snapshotFingerprint || confirmation !== CONFIRMATION_TEXT) return;
    recordCloudRestoreSubmitDiagnostic({
      event: 'confirmation-complete',
      phase: 'confirmation',
      outcome: 'success',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
      readStatus: getCloudConnectivitySnapshot().readStatus,
    });
    const readiness = inspectCurrentCloudRestoreReadiness({
      cloudMode: getProviderMode() === 'cloud',
      authenticated: Boolean(user),
      owner: role === 'owner',
    });
    if (!readiness.allowed) {
      const visible = normalizeCloudRestoreSubmitError({ code: readiness.code }, 'readiness', {
        source: 'pre-dispatch',
        attemptCorrelationId: pending.correlationId,
      });
      recordCloudRestoreSubmitDiagnostic({
        event: 'readiness-check-blocked',
        phase: 'readiness',
        outcome: 'not-submitted',
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        readStatus: readiness.connectivity.readStatus,
        error: visible,
      });
      recordCloudRestoreSubmitDiagnostic({
        event: 'submit-finish',
        phase: 'submit',
        outcome: 'not-submitted',
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
      });
      pendingAttemptRef.current = null;
      setConfirmationOpen(false);
      setConfirmation('');
      setStatus('error');
      setMessage(CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE);
      return;
    }
    recordCloudRestoreSubmitDiagnostic({
      event: 'readiness-check-pass',
      phase: 'readiness',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
      readStatus: readiness.connectivity.readStatus,
    });
    inFlightRef.current = true;
    setConfirmationOpen(false);
    setStatus('restoring');
    setMessage('Server 正在鎖定寫入、建立 rollback snapshot、驗證並執行原子還原…');
    try {
      recordCloudRestoreSubmitDiagnostic({
        event: 'rpc-invocation',
        phase: 'rpc',
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        readStatus: readiness.connectivity.readStatus,
      });
      const restored = await (executeRestore ?? (command => dataProvider.restoreCloudSnapshot(command)))({
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        candidate,
        confirmation: CONFIRMATION_TEXT,
      });
      setResult(restored);
      setStatus('success');
      submissionLockedRef.current = true;
      const syncPending = restored.authoritativeRefresh?.status === 'pending';
      setMessage(syncPending
        ? `還原已完成，畫面同步待完成；請勿再次還原。Rollback snapshot：${restored.rollbackSnapshotId}`
        : `Cloud Restore 完成；authoritative refresh 已完成。Rollback snapshot：${restored.rollbackSnapshotId}`);
      window.dispatchEvent(new CustomEvent('cloud-restore-completed', { detail: { restoreEpoch: restored.restoreEpoch } }));
      recordCloudRestoreSubmitDiagnostic({
        event: 'submit-finish',
        phase: 'submit',
        outcome: syncPending ? 'sync-pending' : 'success',
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
      });
    } catch (error) {
      const visible = normalizeCloudRestoreSubmitError(error, 'rpc', {
        source: 'post-dispatch',
        attemptCorrelationId: pending.correlationId,
      });
      const unknown = visible.outcome === 'unknown';
      if (visible.outcome === 'not-submitted') {
        recordCloudRestoreSubmitDiagnostic({
          event: 'readiness-check-blocked',
          phase: 'readiness',
          outcome: 'not-submitted',
          attemptCorrelationId: pending.correlationId,
          idempotencyKey: pending.idempotencyKey,
          readStatus: getCloudConnectivitySnapshot().readStatus,
          error: visible,
        });
      }
      submissionLockedRef.current = unknown;
      setStatus(unknown ? 'unknown' : 'error');
      setMessage(formatCloudRestoreSubmitError(visible));
      recordCloudRestoreSubmitDiagnostic({
        event: 'submit-finish',
        phase: 'submit',
        outcome: visible.outcome,
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        error: visible,
      });
    } finally {
      inFlightRef.current = false;
      pendingAttemptRef.current = null;
    }
  };

  return (
    <section data-testid="cloud-atomic-restore" style={{ padding: 16, border: '2px solid #dc2626', borderRadius: 8, background: '#fff7ed' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <AlertTriangle color="#b91c1c" size={20} />
        <div>
          <div className="font-medium" style={{ color: '#991b1b' }}>Cloud JSON 原子還原</div>
          <div className="text-xs text-muted">Cloud DB 是唯一 authoritative source。快取不會被當成 restore source。</div>
        </div>
      </div>
      <p data-testid="cloud-restore-access" style={{ margin: '12px 0' }}>
        {!cloudMode
          ? '僅 Cloud Mode 可用。'
          : !user
            ? '請先登入。'
            : !owner
              ? '僅 owner 可執行。'
              : !online
                ? '目前離線；Cloud Restore 已拒絕。'
                : !fresh
                  ? '等待重新讀取雲端最新資料，完成後才能還原'
                  : 'Owner / authoritative fresh：可進行本機 preflight 與還原確認。'}
      </p>
      <button type="button" className="btn btn-outline" disabled={!canPreflight || status === 'restoring' || status === 'unknown'} onClick={() => fileRef.current?.click()}>
        <FileCheck2 size={16} /> 選擇 JSON 並 Preflight
      </button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => void selectFile(event.target.files?.[0])} />

      {candidate && (
        <div data-testid="cloud-restore-preflight" style={{ marginTop: 14 }}>
          <div><strong>檔案：</strong>{candidate.fileName}</div>
          <div><strong>Schema：</strong>{candidate.schemaVersion}</div>
          <div><strong>資源：</strong>{candidate.manifest.resourceCount}／{CLOUD_RESTORE_TABLES.length}</div>
          <div><strong>總筆數：</strong>{candidate.manifest.totalRows}</div>
          <div><strong>Snapshot fingerprint：</strong><code>{candidate.manifest.snapshotFingerprint}</code></div>
          <div><strong>Relationship hash：</strong><code>{candidate.manifest.relationshipHash}</code></div>
          <div><strong>完整性：</strong>blocking orphan {candidate.manifest.orphanCount}；metadata missing {candidate.manifest.optionalMetadataMissingReferenceCount}；canonical anomalies {candidate.manifest.canonicalIdentityAnomalyCount}；duplicate IDs {candidate.manifest.duplicateCanonicalIdCount}；rollback snapshot 將由 Server 在 transaction 內建立。</div>
          <details style={{ marginTop: 8 }}>
            <summary>各資源筆數</summary>
            <ul>{CLOUD_RESTORE_TABLES.map(([, table]) => <li key={table}>{table}: {candidate.manifest.counts[table]}</li>)}</ul>
          </details>
          <label htmlFor="cloud-restore-confirmation" style={{ display: 'block', marginTop: 12 }}>
            請輸入 <code>{CONFIRMATION_TEXT}</code>
          </label>
          <input
            id="cloud-restore-confirmation"
            data-testid="cloud-restore-confirmation"
            value={confirmation}
            onChange={event => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={!allowed || status === 'confirming' || status === 'restoring' || status === 'success' || status === 'unknown'}
          />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="cloud-restore-submit"
            disabled={!allowed || status === 'confirming' || status === 'restoring' || status === 'success' || status === 'unknown' || confirmation !== CONFIRMATION_TEXT}
            onClick={beginConfirmation}
            style={{ marginLeft: 10 }}
          >
            <RotateCcw size={16} /> {status === 'restoring' ? 'Server 原子還原中…' : '確認覆蓋 Cloud'}
          </button>
        </div>
      )}
      {confirmationOpen && candidate && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cloud-restore-final-confirmation-title"
          data-testid="cloud-restore-final-confirmation"
          style={{ marginTop: 14, padding: 14, border: '2px solid #991b1b', borderRadius: 8, background: '#fff' }}
        >
          <div id="cloud-restore-final-confirmation-title" className="font-medium">最後確認：完整覆蓋 Cloud authoritative data</div>
          <p>Server 會先建立 rollback snapshot。確認文字必須維持 <code>{CONFIRMATION_TEXT}</code>。</p>
          {!allowed && <p role="alert">{CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE}</p>}
          <form onSubmit={event => { event.preventDefault(); void execute(); }}>
            <button type="button" className="btn btn-outline" onClick={cancelConfirmation} disabled={status === 'restoring'}>取消</button>
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="cloud-restore-final-submit"
              disabled={!allowed || status === 'restoring'}
              style={{ marginLeft: 10 }}
            >
              最終確認並送出
            </button>
          </form>
        </div>
      )}
      <p role={status === 'error' || status === 'unknown' ? 'alert' : 'status'} data-testid="cloud-restore-status" style={{ marginBottom: 0 }}>{message}</p>
      {result && (
        <div data-testid="cloud-restore-result">
          replayed={String(result.replayed)}；epoch={result.restoreEpoch}
          {result.timingsMs && (
            <details data-testid="cloud-restore-timings" style={{ marginTop: 8 }}>
              <summary>Server phase timings（ms）</summary>
              <pre>{JSON.stringify(result.timingsMs, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
