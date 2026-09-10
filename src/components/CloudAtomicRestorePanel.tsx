import { useRef, useState } from 'react';
import { AlertTriangle, FileCheck2, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth/authContext';
import { useRole } from '../auth/useRole';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import { getCloudConnectivitySnapshot } from '../providers/cloud/cloudConnectivity';
import {
  CLOUD_RESTORE_TABLES,
  prepareCloudRestoreSnapshot,
  type CloudRestoreCandidate,
  type CloudRestoreResult,
} from '../providers/cloud/cloudAtomicRestore';

const CONFIRMATION_TEXT = 'OVERWRITE CLOUD DATA';

interface CloudAtomicRestorePanelProps {
  executeRestore?: (command: Parameters<typeof dataProvider.restoreCloudSnapshot>[0]) => ReturnType<typeof dataProvider.restoreCloudSnapshot>;
}

export default function CloudAtomicRestorePanel({ executeRestore }: CloudAtomicRestorePanelProps = {}) {
  const { user } = useAuth();
  const { role } = useRole();
  const fileRef = useRef<HTMLInputElement>(null);
  const retryKeys = useRef(new Map<string, string>());
  const [candidate, setCandidate] = useState<CloudRestoreCandidate | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<'idle' | 'preflighting' | 'ready' | 'restoring' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<CloudRestoreResult | null>(null);
  const cloudMode = getProviderMode() === 'cloud';
  const owner = role === 'owner';
  const online = getCloudConnectivitySnapshot().status === 'online';
  const allowed = cloudMode && Boolean(user) && owner && online;

  const selectFile = async (file: File | undefined) => {
    if (!file) return;
    setStatus('preflighting');
    setMessage('正在本機解析並檢查 JSON；尚未寫入雲端。');
    setCandidate(null);
    setResult(null);
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
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const execute = async () => {
    if (!candidate || !allowed || confirmation !== CONFIRMATION_TEXT) return;
    if (!window.confirm('最後確認：這會以選定快照完整覆蓋 Cloud authoritative data。Server 會先建立 rollback snapshot。確定繼續？')) return;
    setStatus('restoring');
    setMessage('Server 正在鎖定寫入、建立 rollback snapshot、驗證並執行原子還原…');
    try {
      const fingerprint = candidate.manifest.snapshotFingerprint;
      const idempotencyKey = retryKeys.current.get(fingerprint) ?? crypto.randomUUID();
      retryKeys.current.set(fingerprint, idempotencyKey);
      const restored = await (executeRestore ?? (command => dataProvider.restoreCloudSnapshot(command)))({
        idempotencyKey,
        candidate,
        confirmation: CONFIRMATION_TEXT,
      });
      setResult(restored);
      setStatus('success');
      setMessage(`Cloud Restore 完成；authoritative refresh 已完成。Rollback snapshot：${restored.rollbackSnapshotId}`);
      window.dispatchEvent(new CustomEvent('cloud-restore-completed', { detail: { restoreEpoch: restored.restoreEpoch } }));
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : String(error));
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
        {!cloudMode ? '僅 Cloud Mode 可用。' : !user ? '請先登入。' : !owner ? '僅 owner 可執行。' : !online ? '目前離線；Cloud Restore 已拒絕。' : 'Owner / online：可進行本機 preflight。'}
      </p>
      <button type="button" className="btn btn-outline" disabled={!allowed || status === 'restoring'} onClick={() => fileRef.current?.click()}>
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
          />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="cloud-restore-submit"
            disabled={!allowed || status === 'restoring' || confirmation !== CONFIRMATION_TEXT}
            onClick={() => void execute()}
            style={{ marginLeft: 10 }}
          >
            <RotateCcw size={16} /> {status === 'restoring' ? 'Server 原子還原中…' : '確認覆蓋 Cloud'}
          </button>
        </div>
      )}
      <p role={status === 'error' ? 'alert' : 'status'} data-testid="cloud-restore-status" style={{ marginBottom: 0 }}>{message}</p>
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
