import { CLOUD_RESTORE_TABLES, type CloudRestoreResult } from './cloudAtomicRestore';

export const RESTORE_POSTCOMMIT_RPC = 'erp_verify_committed_cloud_restore';
export interface RestoreVerificationIdentity { attemptId: string; traceId: string; executionId: string }
export interface RestoreVerificationSummary extends RestoreVerificationIdentity {
  contract: 'restore-committed-verification-v1';
  status: 'RESTORE_COMMITTED_VERIFIED' | 'RESTORE_COMMITTED_STATE_MISMATCH';
  restoreEpoch: number; businessGeneration: number; snapshotFingerprint: string;
  serverSnapshotFingerprint: string; serverRelationshipHash: string;
  counts: Record<string, number>; totalRows: number; duplicateCount: number;
  missingIdentityCount: number; orphanCount: number; generationCertified: boolean; elapsedMs: number;
}
export class RestoreReadbackError extends Error {
  readonly rpc = RESTORE_POSTCOMMIT_RPC;
  readonly phase = 'post-commit-verification';
  readonly code: string;
  readonly sqlstate?: string;
  readonly httpStatus?: number;
  readonly elapsedMs?: number;
  constructor(code: string, sqlstate?: string, httpStatus?: number, elapsedMs?: number) {
    super(code === 'RESTORE_COMMITTED_STATE_MISMATCH'
      ? '還原已提交，但目前雲端資料與提交目標不一致；寫入仍暫停，請勿再次還原。'
      : '還原已成功提交，但系統暫時無法完成結果驗證。請重新驗證結果，請勿再次執行還原。');
    this.name = 'RestoreReadbackError';
    this.code = code; this.sqlstate = sqlstate; this.httpStatus = httpStatus; this.elapsedMs = elapsedMs;
  }
}
export function classifyRestoreReadbackError(error: unknown, status?: number, elapsed?: number): RestoreReadbackError {
  if (error instanceof RestoreReadbackError) return error;
  const e = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const sqlstate = typeof e.code === 'string' && /^[A-Z0-9]{5}$/u.test(e.code) ? e.code : undefined;
  const code = sqlstate === '57014' || e.name === 'TimeoutError' || e.name === 'AbortError'
    ? 'RESTORE_READBACK_TIMEOUT'
    : sqlstate === '42501' || status === 401 || status === 403 ? 'RESTORE_READBACK_PERMISSION_ERROR'
    : error instanceof TypeError || e.code === 'NETWORK_ERROR' ? 'RESTORE_READBACK_NETWORK_ERROR'
    : 'RESTORE_READBACK_SERVER_ERROR';
  return new RestoreReadbackError(code, sqlstate, status, elapsed);
}
export function parseRestoreVerificationSummary(raw: unknown, identity: RestoreVerificationIdentity): RestoreVerificationSummary {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const validCount = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  const counts = r.counts && typeof r.counts === 'object' && !Array.isArray(r.counts) ? r.counts as Record<string, unknown> : {};
  if (r.contract !== 'restore-committed-verification-v1'
    || !['RESTORE_COMMITTED_VERIFIED', 'RESTORE_COMMITTED_STATE_MISMATCH'].includes(String(r.status))
    || Object.entries(identity).some(([k, v]) => r[k] !== v)
    || ['restoreEpoch', 'businessGeneration', 'totalRows', 'duplicateCount', 'missingIdentityCount', 'orphanCount', 'elapsedMs'].some(k => !validCount(r[k]))
    || ['snapshotFingerprint', 'serverSnapshotFingerprint', 'serverRelationshipHash'].some(k => !/^[a-f0-9]{64}$/u.test(String(r[k])))
    || typeof r.generationCertified !== 'boolean' || Object.keys(counts).length !== CLOUD_RESTORE_TABLES.length
    || CLOUD_RESTORE_TABLES.some(([, table]) => !validCount(counts[table]))
    || Object.values(counts).reduce<number>((sum, n) => sum + Number(n), 0) !== r.totalRows) {
    throw new RestoreReadbackError('RESTORE_READBACK_SERVER_ERROR');
  }
  // Never expose arbitrary server properties or business payloads.
  return Object.fromEntries(['contract', 'status', ...Object.keys(identity), 'restoreEpoch', 'businessGeneration',
    'snapshotFingerprint', 'serverSnapshotFingerprint', 'serverRelationshipHash', 'counts', 'totalRows',
    'duplicateCount', 'missingIdentityCount', 'orphanCount', 'generationCertified', 'elapsedMs'].map(k => [k, r[k]])) as unknown as RestoreVerificationSummary;
}
export async function readRestoreVerificationSummary(client: {
  rpc: (name: string, parameters: Record<string, string>) => PromiseLike<{ data: unknown; error: unknown; status?: number }>;
}, identity: RestoreVerificationIdentity): Promise<RestoreVerificationSummary> {
  const started = performance.now();
  let response;
  try {
    response = await client.rpc(RESTORE_POSTCOMMIT_RPC, { p_attempt_id: identity.attemptId,
      p_trace_id: identity.traceId, p_execution_id: identity.executionId });
  } catch (error) { throw classifyRestoreReadbackError(error, undefined, performance.now() - started); }
  if (response.error) throw classifyRestoreReadbackError(response.error, response.status, performance.now() - started);
  return parseRestoreVerificationSummary(response.data, identity);
}
/** Bounded READ-only retry. This dependency has no Prepare/Execute capability. */
export async function verifyCommittedRestore(read: () => Promise<RestoreVerificationSummary>, result: CloudRestoreResult,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (const delay of [0, 1_000, 2_000, 4_000]) {
    if (delay) await wait(delay);
    try {
      const summary = await read();
      if (summary.status !== 'RESTORE_COMMITTED_VERIFIED' || !summary.generationCertified
        || summary.restoreEpoch !== result.restoreEpoch || summary.snapshotFingerprint !== result.snapshotFingerprint
        || summary.totalRows !== result.manifest.totalRows || summary.duplicateCount !== 0 || summary.missingIdentityCount !== 0 || summary.orphanCount !== 0
        || CLOUD_RESTORE_TABLES.some(([, table]) => summary.counts[table] !== result.manifest.counts[table])) {
        throw new RestoreReadbackError('RESTORE_COMMITTED_STATE_MISMATCH');
      }
      return summary;
    } catch (error) {
      const safe = classifyRestoreReadbackError(error);
      if (!['RESTORE_READBACK_TIMEOUT', 'RESTORE_READBACK_NETWORK_ERROR'].includes(safe.code)
        && !(safe.code === 'RESTORE_READBACK_SERVER_ERROR' && (safe.httpStatus ?? 0) >= 500)) throw safe;
      if (delay === 4_000) throw safe;
    }
  }
  throw new RestoreReadbackError('RESTORE_COMMITTED_VERIFICATION_PENDING');
}
