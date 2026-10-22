// Reviewed custom business conflicts only. Never catch/rewrite a PostgreSQL error.
export const WACA_TRANSPORT_REASONS = Object.freeze({
  'public.erp_commit_waca_snapshot_v044(jsonb,bigint,boolean)': ['WACA_STALE_REVISION'],
  'public.erp_commit_waca_counted_snapshot_v074(jsonb,bigint,jsonb)': [
    'WACA_STALE_REVISION', 'WACA_RESTORE_EPOCH_CHANGED', 'WACA_COUNTED_PREVIEW_MISMATCH',
  ],
  'public.erp_plan_waca_recognition(jsonb)': ['WACA_STALE_REVISION', 'WACA_RESTORE_EPOCH_CHANGED'],
  'public.erp_commit_waca_recognition(jsonb,jsonb)': [
    'WACA_RESTORE_EPOCH_CHANGED', 'WACA_RECOGNITION_PREVIEW_CHANGED',
    'WACA_RECOGNITION_VARIANT_CHANGED', 'WACA_STALE_REVISION',
  ],
});

export function reviewedWacaConflictDefinition(signature, definition) {
  const reasons = WACA_TRANSPORT_REASONS[signature];
  if (!reasons) return definition;
  let result = definition;
  for (const reason of reasons) {
    const anchor = `errcode='40001',message='${reason}'`;
    if (result.split(anchor).length !== 2) throw new Error(`WACA_TRANSPORT_ANCHOR_MISMATCH:${signature}:${reason}`);
    result = result.replace(anchor, `errcode='PT409',message='${reason}'`);
  }
  // Every converted RAISE is a specific, reviewed application rejection.
  // No EXCEPTION handler, serialization_failure trap, predicate or DML changes.
  return result;
}
