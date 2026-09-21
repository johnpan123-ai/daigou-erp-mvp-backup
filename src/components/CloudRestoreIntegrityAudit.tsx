import { useEffect, useRef, useState } from 'react';
import { dataProvider } from '../providers/dataProvider';
import { CLOUD_RESTORE_TABLES } from '../providers/cloud/cloudAtomicRestore';
import {
  AUDIT_CHECKS, cloudRestoreAuditVerdict, type CloudRestoreIntegrityAudit as Audit,
} from '../providers/cloud/cloudRestoreIntegrityAudit';

/** Rendered only for the authenticated Cloud OWNER, keyed by auth identity in parent. */
export default function CloudRestoreIntegrityAudit() {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const read = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true); setFailed(false); setAudit(null);
    try {
      const result = await dataProvider.readCloudRestoreIntegrityAudit();
      if (mounted.current) setAudit(result);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <section aria-label="還原完整性稽核" data-testid="restore-integrity-audit" style={{ marginTop: 18 }}>
      <h3>還原完整性稽核</h3>
      <p>OWNER 專用唯讀查驗。包含已刪除列的 15 表 raw counts，不是上方 active／logical 統計。不會還原或查證／修改 attempt。</p>
      <button type="button" className="btn btn-outline" disabled={pending} onClick={() => void read()}>
        {pending ? '稽核讀取中…' : 'Restore Integrity Audit'}
      </button>
      {failed && <p role="alert">FAIL：無法取得完整稽核回應；未執行還原或修改資料。</p>}
      {audit && <div data-testid="restore-integrity-result">
        <p role="status">{cloudRestoreAuditVerdict(audit)} · epoch {audit.epoch} · raw total {audit.total_rows}</p>
        <p>稽核時間：{audit.audited_at}。比對最近 completed Restore manifest；後續合法業務變更也可能造成不一致，不代表可自動重跑 Restore。</p>
        <table><thead><tr><th>資料表（含 deleted）</th><th>目前 raw</th><th>completed manifest</th></tr></thead>
          <tbody>{CLOUD_RESTORE_TABLES.map(([, t]) => <tr key={t}><td>{t}</td><td>{audit.table_counts[t]}</td><td>{audit.expected_manifest?.counts[t] ?? '未知'}</td></tr>)}</tbody>
        </table>
        <p>Relationship hash：<code>{audit.relationship_hash}</code></p>
        <p>預期 hash：<code>{audit.expected_manifest?.relationship_hash ?? '未知'}</code></p>
        <ul>{AUDIT_CHECKS.map(k => <li key={k}>{k}: {audit.integrity[k]}</li>)}</ul>
        <p>Policy：{audit.audit_policy.policy ?? '未知'}；target updated_by non-null = {audit.audit_policy.covered_updated_by_non_null_count}，NULL = {audit.audit_policy.covered_updated_by_null_count}</p>
        <p>來源轉換筆數（非 target readback）：{audit.restore_state.latest_completed?.source_transformed_updated_by_count ?? '未知'}</p>
        <p>pending = {audit.restore_state.pending_count}；executing = {audit.restore_state.executing_count}；
          processing requests = {audit.restore_state.processing_request_count}；locks = {audit.restore_state.active_lock_count}</p>
        <p>Metadata 不一致 = {audit.restore_state.metadata_inconsistency_count}；partial state = {audit.restore_state.partial_state}</p>
        <p>範圍：單次資料快照及另行取樣的即時鎖狀態；檢查筆數、identity、關聯與 audit 欄位，不宣稱其他 business 欄位逐值相同。</p>
        {audit.restore_state.latest_completed && <details><summary>Completed Restore metadata</summary>
          <pre>{JSON.stringify(audit.restore_state.latest_completed, null, 2)}</pre>
        </details>}
      </div>}
    </section>
  );
}
