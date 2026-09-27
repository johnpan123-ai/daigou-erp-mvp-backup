/** 041 returns only these safe codes; raw database messages never reach the UI. */
export const CLOUD_RESTORE_FAILURE_CATEGORIES = [
  'TIMEOUT', 'VALIDATION', 'PORTABILITY', 'CONSTRAINT', 'AUTHORIZATION', 'STALE', 'INTERNAL', 'UNKNOWN',
] as const;
export type CloudRestoreFailureCategory = typeof CLOUD_RESTORE_FAILURE_CATEGORIES[number];
export interface CloudRestoreFailure {
  phase: 'precheck' | 'builder' | 'atomic-restore' | 'canonical-result' | 'reconcile';
  category: CloudRestoreFailureCategory;
  code: string;
  sqlstate: string | null;
  timeoutClassification: 'query-canceled' | 'not-timeout' | 'unobserved';
  evidence: 'caught-subtransaction' | 'reconciled-noncommit';
  failedAt: string;
}
export function isCloudRestoreFailureCode(code: string): boolean {
  return CLOUD_RESTORE_FAILURE_CATEGORIES.some(category => code === `CLOUD_RESTORE_FAILURE_${category}`);
}
export function parseCloudRestoreFailure(value: unknown): CloudRestoreFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CLOUD_RESTORE_ATTEMPT_RESULT_INVALID');
  const r = value as Record<string, unknown>;
  if (!CLOUD_RESTORE_FAILURE_CATEGORIES.some(category => category === r.category)
    || r.code !== `CLOUD_RESTORE_FAILURE_${r.category}`
    || !['precheck', 'builder', 'atomic-restore', 'canonical-result', 'reconcile'].includes(String(r.phase))
    || (r.sqlstate !== null && (typeof r.sqlstate !== 'string' || !/^[0-9A-Z]{5}$/u.test(r.sqlstate)))
    || !['query-canceled', 'not-timeout', 'unobserved'].includes(String(r.timeoutClassification))
    || !['caught-subtransaction', 'reconciled-noncommit'].includes(String(r.evidence))
    || typeof r.failedAt !== 'string' || !Number.isFinite(Date.parse(r.failedAt))) {
    throw new Error('CLOUD_RESTORE_ATTEMPT_RESULT_INVALID');
  }
  // Project only known fields; do not copy a raw exception attached to a response.
  return { phase: r.phase, category: r.category, code: r.code, sqlstate: r.sqlstate,
    timeoutClassification: r.timeoutClassification, evidence: r.evidence, failedAt: r.failedAt } as CloudRestoreFailure;
}
