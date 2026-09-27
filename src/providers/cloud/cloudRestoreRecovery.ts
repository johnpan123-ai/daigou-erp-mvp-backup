import type { CloudRestoreAttemptCommand } from './cloudAtomicRestore';
import { createCloudRestoreSafeSubmitError } from './cloudRestoreSubmit';

/** Safe projection only; ownership is enforced by the existing 038 SELECT RLS. */
export interface CloudRestoreRecoveryAttempt extends CloudRestoreAttemptCommand {
  status: 'prepared' | 'executing';
  submittedAt: string;
  expectedEpoch: number;
  effectiveFingerprint: string;
}

export const CLOUD_RESTORE_RECOVERY_COLUMNS = 'attempt_id,trace_id,status,submitted_at,expected_epoch,effective_fingerprint,target_environment';

export function parseCloudRestoreRecoveryRows(value: unknown, target: string): CloudRestoreRecoveryAttempt[] {
  const invalid = () => createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_RESULT_INVALID' }, 'server-response');
  if (!Array.isArray(value)) throw invalid();
  const ids = new Set<string>();
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid();
    const r = row as Record<string, unknown>;
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
    if (typeof r.attempt_id !== 'string' || !uuid.test(r.attempt_id)
      || typeof r.trace_id !== 'string' || !uuid.test(r.trace_id)
      || (r.status !== 'prepared' && r.status !== 'executing')
      || typeof r.submitted_at !== 'string' || !Number.isFinite(Date.parse(r.submitted_at))
      || !Number.isSafeInteger(r.expected_epoch) || Number(r.expected_epoch) < 0
      || typeof r.effective_fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(r.effective_fingerprint)
      || r.target_environment !== target || ids.has(r.attempt_id)) throw invalid();
    ids.add(r.attempt_id);
    return Object.freeze({ attemptId: r.attempt_id, traceId: r.trace_id, status: r.status,
      submittedAt: r.submitted_at, expectedEpoch: r.expected_epoch as number,
      effectiveFingerprint: r.effective_fingerprint });
  });
}
