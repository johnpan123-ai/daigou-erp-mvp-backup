import { CLOUD_RESTORE_TABLES, type CloudRestoreTable } from './cloudAtomicRestore';

export const CLOUD_RESTORE_INTEGRITY_AUDIT_RPC = 'erp_read_cloud_restore_integrity_audit';
const FAILURE = '還原完整性稽核讀取失敗；未執行還原或修改資料。';
const INVALID = '還原完整性稽核回應不完整；不能判定 PASS。';
export const AUDIT_CHECKS = [
  'orphan_count', 'optional_metadata_missing_reference_count',
  'duplicate_variant_id_count', 'duplicate_variant_local_id_count',
  'duplicate_canonical_id_count', 'canonical_identity_anomaly_count',
  'unknown_product_count', 'duplicate_inventory_key_count', 'missing_inventory_key_count',
] as const;
type Counts = Record<CloudRestoreTable, number>;
export interface CloudRestoreIntegrityAudit {
  schema_version: 'cloud-restore-integrity-audit-v1';
  audited_at: string;
  epoch: number;
  table_counts: Counts;
  total_rows: number;
  relationship_hash: string;
  integrity: Record<typeof AUDIT_CHECKS[number], number>;
  audit_policy: {
    policy: 'strict' | 'cross-environment-audit-null-v1' | null;
    covered_updated_by_non_null_count: number;
    covered_updated_by_null_count: number;
  };
  expected_manifest: { counts: Counts; total_rows: number; relationship_hash: string } | null;
  comparison: { counts_match: boolean | null; relationship_hash_match: boolean | null };
  restore_state: {
    latest_completed: {
      attempt_id: string; status: 'completed'; result_epoch: number; replayed: boolean | null;
      source_fingerprint: string; effective_fingerprint: string; completed_at: string;
      source_transformed_updated_by_count: number | null;
    } | null;
    pending_count: number; executing_count: number; processing_request_count: number;
    active_lock_count: number; metadata_inconsistency_count: number;
    partial_state: 'not_detected' | 'inconsistent' | 'unproven';
  };
}
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(INVALID);
  return v as Record<string, unknown>;
};
const count = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(INVALID);
  return v as number;
};
const string = (v: unknown, pattern: RegExp): string => {
  if (typeof v !== 'string' || !pattern.test(v)) throw new Error(INVALID);
  return v;
};
const hash = (v: unknown) => string(v, /^[a-f0-9]{64}$/u);
const date = (v: unknown) => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new Error(INVALID);
  return v;
};
const bool = (v: unknown): boolean | null => {
  if (v !== null && typeof v !== 'boolean') throw new Error(INVALID);
  return v;
};
const counts = (v: unknown): Counts => {
  const raw = record(v);
  if (Object.keys(raw).length !== CLOUD_RESTORE_TABLES.length) throw new Error(INVALID);
  return Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, t]) => [t, count(raw[t])])) as Counts;
};

/** Whitelist DTO: never propagate raw business rows, auth identity or server messages. */
export function parseCloudRestoreIntegrityAudit(value: unknown): CloudRestoreIntegrityAudit {
  const raw = record(value);
  if (raw.schema_version !== 'cloud-restore-integrity-audit-v1') throw new Error(INVALID);
  const integrity = record(raw.integrity), policy = record(raw.audit_policy);
  const state = record(raw.restore_state), comparison = record(raw.comparison);
  const latest = state.latest_completed === null ? null : record(state.latest_completed);
  const expected = raw.expected_manifest === null ? null : record(raw.expected_manifest);
  if (!['strict', 'cross-environment-audit-null-v1', null].includes(policy.policy as string | null)
    || !['not_detected', 'inconsistent', 'unproven'].includes(String(state.partial_state))
    || (latest && latest.status !== 'completed')) throw new Error(INVALID);
  const result: CloudRestoreIntegrityAudit = {
    schema_version: 'cloud-restore-integrity-audit-v1',
    audited_at: date(raw.audited_at), epoch: count(raw.epoch),
    table_counts: counts(raw.table_counts), total_rows: count(raw.total_rows),
    relationship_hash: hash(raw.relationship_hash),
    integrity: Object.fromEntries(AUDIT_CHECKS.map(k => [k, count(integrity[k])])) as CloudRestoreIntegrityAudit['integrity'],
    audit_policy: {
      policy: policy.policy as CloudRestoreIntegrityAudit['audit_policy']['policy'],
      covered_updated_by_non_null_count: count(policy.covered_updated_by_non_null_count),
      covered_updated_by_null_count: count(policy.covered_updated_by_null_count),
    },
    expected_manifest: expected ? { counts: counts(expected.counts), total_rows: count(expected.total_rows), relationship_hash: hash(expected.relationship_hash) } : null,
    comparison: { counts_match: bool(comparison.counts_match), relationship_hash_match: bool(comparison.relationship_hash_match) },
    restore_state: {
      latest_completed: latest ? {
        attempt_id: string(latest.attempt_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu),
        status: 'completed', result_epoch: count(latest.result_epoch), replayed: bool(latest.replayed),
        source_fingerprint: hash(latest.source_fingerprint), effective_fingerprint: hash(latest.effective_fingerprint),
        completed_at: date(latest.completed_at),
        source_transformed_updated_by_count: latest.source_transformed_updated_by_count === null
          ? null : count(latest.source_transformed_updated_by_count),
      } : null,
      pending_count: count(state.pending_count), executing_count: count(state.executing_count),
      processing_request_count: count(state.processing_request_count), active_lock_count: count(state.active_lock_count),
      metadata_inconsistency_count: count(state.metadata_inconsistency_count),
      partial_state: state.partial_state as CloudRestoreIntegrityAudit['restore_state']['partial_state'],
    },
  };
  if (Object.values(result.table_counts).reduce((a, b) => a + b, 0) !== result.total_rows
    || result.audit_policy.covered_updated_by_non_null_count + result.audit_policy.covered_updated_by_null_count !== result.total_rows) {
    throw new Error(INVALID);
  }
  return result;
}

export function cloudRestoreAuditVerdict(a: CloudRestoreIntegrityAudit): 'PASS' | 'FAIL' | 'PENDING' {
  const s = a.restore_state, expected = a.expected_manifest;
  if (Object.values(a.integrity).some(n => n !== 0)
    || s.pending_count + s.executing_count + s.processing_request_count + s.active_lock_count + s.metadata_inconsistency_count > 0
    || (a.audit_policy.policy === 'cross-environment-audit-null-v1' && a.audit_policy.covered_updated_by_non_null_count !== 0)
    || a.comparison.counts_match === false || a.comparison.relationship_hash_match === false) return 'FAIL';
  if (!expected || !s.latest_completed || !a.audit_policy.policy || s.partial_state !== 'not_detected'
    || a.comparison.counts_match !== true || a.comparison.relationship_hash_match !== true) return 'PENDING';
  return expected.total_rows === a.total_rows && expected.relationship_hash === a.relationship_hash
    && CLOUD_RESTORE_TABLES.every(([, t]) => expected.counts[t] === a.table_counts[t])
    && s.latest_completed.result_epoch === a.epoch ? 'PASS' : 'FAIL';
}

/** One authenticated read RPC. No retry, prepare, reconcile, cache replacement or write. */
export async function readCloudRestoreIntegrityAudit(
  client: { rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }> },
): Promise<CloudRestoreIntegrityAudit> {
  let response: { data: unknown; error: unknown };
  try { response = await client.rpc(CLOUD_RESTORE_INTEGRITY_AUDIT_RPC); }
  catch { throw new Error(FAILURE); }
  if (response.error) throw new Error(FAILURE);
  return parseCloudRestoreIntegrityAudit(response.data);
}
