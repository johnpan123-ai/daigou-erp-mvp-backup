import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(new URL('../supabase/sql/042_cloud_restore_durable_execution_closure.sql', import.meta.url), 'utf8');
const SQL_028 = readFileSync(new URL('../supabase/sql/028_cloud_restore_schema_aware_safeupdate_delete.sql', import.meta.url), 'utf8');
const PROVIDER = readFileSync(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../src/components/CloudAtomicRestorePanel.tsx', import.meta.url), 'utf8');
const SCHEDULE = readFileSync(new URL('../src/providers/cloud/cloudRestoreReconcileSchedule.ts', import.meta.url), 'utf8');

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.doesNotMatch(SQL, /create\s+(?:table|schema)|alter\s+table/iu,
  '042 is a function-only closure and must not introduce unrelated schema state');
assert.match(SQL, /CLOUD_RESTORE_EXECUTION_CLOSURE_BASE_MISSING/u);
assert.match(SQL, /CLOUD_RESTORE_EXECUTION_CLOSURE_POSTFLIGHT_MISMATCH/u);
assert.match(SQL, /set statement_timeout='120s'/u);
assert.match(SQL, /set statement_timeout='10s'/u);
for (const phase of ['input_validation', 'before_snapshot', 'delete', 'insert', 'integrity', 'epoch_idempotency']) {
  assert.match(SQL_028, new RegExp(`CLOUD_RESTORE_TIMING phase=${phase}`, 'u'));
  assert.match(SQL, new RegExp(`cloud_restore_timingphase=${phase}`, 'u'));
}

const executeFunction = SQL.slice(
  SQL.indexOf('create or replace function public.erp_restore_cloud_snapshot_attempt('),
  SQL.indexOf('revoke all on function public.erp_restore_cloud_snapshot_attempt('),
);
assert.match(executeFunction, /if v_attempt\.status='prepared'[\s\S]+set status='executing',execution_id=p_execution_id/u);
assert.match(executeFunction, /elsif v_attempt\.status='executing'/u,
  'Previously deployed 038/041 executing envelopes remain readable and executable');
assert.equal((executeFunction.match(/public\.erp_restore_cloud_snapshot\(/gu) || []).length, 1);
assert.match(executeFunction, /exception when query_canceled or others/u);
assert.match(executeFunction, /insert into public\.erp_cloud_restore_failures/u);
assert.match(executeFunction, /set status='not_committed'/u);
assert.match(executeFunction, /set status='completed'/u);
for (const phase of ['PREPARING', 'BUILDING_EFFECTIVE_SNAPSHOT', 'ATOMIC_RESTORE', 'FINAL_VALIDATION', 'COMPLETED']) {
  assert.match(executeFunction, new RegExp(phase, 'u'));
}
assert.doesNotMatch(executeFunction, /raise log[^;]*(?:p_source_snapshot|p_manifest|v_effective)/iu,
  'Safe phase logs must never contain payload or manifest data');

const reconcileFunction = SQL.slice(
  SQL.indexOf('create or replace function public.erp_reconcile_cloud_restore_attempt('),
  SQL.indexOf('revoke all on function public.erp_reconcile_cloud_restore_attempt('),
);
assert.match(reconcileFunction, /status in \('prepared','executing'\)/u);
assert.match(reconcileFunction, /active-execution-lock/u);
assert.match(reconcileFunction, /timeout-grace-active/u);
assert.match(reconcileFunction, /epoch-or-request-ambiguous/u);
assert.match(reconcileFunction, /reconciled-noncommit/u);
assert.match(reconcileFunction, /set status='not_committed'/u);
assert.doesNotMatch(reconcileFunction, /erp_restore_cloud_snapshot\(|delete from public\.(?:inventory|product|purchase|private|sales|japan|outbound)/iu,
  'Reconciliation is evidence-only and must never execute business restore work');

for (const signature of [
  'public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)',
  'public.erp_reconcile_cloud_restore_attempt(uuid,uuid)',
]) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  assert.match(SQL, new RegExp(`revoke all on function ${escaped} from public,anon,authenticated`, 'u'));
  assert.match(SQL, new RegExp(`grant execute on function ${escaped} to authenticated`, 'u'));
}

const prepareMethod = PROVIDER.slice(
  PROVIDER.indexOf('async prepareCloudRestoreAttempt('),
  PROVIDER.indexOf('async reconcileCloudRestoreAttempt('),
);
assert.equal((prepareMethod.match(/supabase\.rpc\(CLOUD_RESTORE_ATTEMPT_PREPARE_RPC/gu) || []).length, 1);
assert.doesNotMatch(prepareMethod, /CLOUD_RESTORE_ATTEMPT_BEGIN_RPC/u);
assert.match(prepareMethod, /outcome\.status !== 'prepared'/u);

const restoreMethod = PROVIDER.slice(
  PROVIDER.indexOf('async restoreCloudSnapshot('),
  PROVIDER.indexOf('private async applyCloudFieldMutations'),
);
assert.equal((restoreMethod.match(/supabase\.rpc\(CLOUD_RESTORE_RPC/gu) || []).length, 1);
assert.doesNotMatch(restoreMethod, /\bretry\b|setInterval|while\s*\(/iu);
assert.match(restoreMethod, /reconcileDestructiveUncertainty\(command\.attempt\)/u);

assert.match(PANEL, /durableAttempt\.executionId \?\? crypto\.randomUUID\(\)/u);
assert.match(PANEL, /status: durableAttempt\.status/u);
assert.match(PANEL, /window\.addEventListener\('online', wake\)/u);
assert.match(PANEL, /window\.addEventListener\('focus', wake\)/u);
assert.match(PANEL, /document\.addEventListener\('visibilitychange', visible\)/u);
assert.match(PANEL, /connectivity\.lastFreshReadAt/u);
assert.match(PANEL, /!browserOnline/u);
assert.doesNotMatch(PANEL, /void execute\([^)]*\)[\s\S]{0,180}(?:setTimeout|setInterval)/u,
  'Recovery wakeups may reconcile evidence but must never retry execute');

assert.match(SCHEDULE, /count >= 2/u);
assert.match(SCHEDULE, /return 1_000/u);
assert.doesNotMatch(SCHEDULE, /setInterval|while\s*\(/u);

console.log('PASS 042 durable execution closure: prepared-direct atomic transition, legacy compatibility, persistent caught failures, and bounded evidence-only reconciliation');
console.log('PASS client lifecycle closure: no BEGIN dispatch, single execute, online/focus/visibility/manual-refresh wakeups, and no automatic Restore retry');
