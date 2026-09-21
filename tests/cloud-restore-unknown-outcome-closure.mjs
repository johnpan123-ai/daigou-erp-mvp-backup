import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(new URL('../supabase/sql/038_cloud_restore_durable_attempt_envelope.sql', import.meta.url), 'utf8');
const PROVIDER = readFileSync(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../src/components/CloudAtomicRestorePanel.tsx', import.meta.url), 'utf8');
const SUBMIT = readFileSync(new URL('../src/providers/cloud/cloudRestoreSubmit.ts', import.meta.url), 'utf8');

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.match(SQL, /create table public\.erp_cloud_restore_attempts/u);
assert.match(SQL, /actor_key text not null check \(actor_key ~ '\^\[0-9a-f\]\{64\}\$'\)/u);
assert.doesNotMatch(SQL, /raw_snapshot|auth_uuid|access_token|refresh_token/iu);
assert.match(SQL, /timeout_budget_ms integer not null check \(timeout_budget_ms = 120000\)/u);
assert.match(SQL, /grace_ms integer not null default 15000 check \(grace_ms = 15000\)/u);
assert.match(SQL, /status text not null check \(status in \('prepared','executing','completed','not_committed'\)\)/u);
assert.match(SQL, /create unique index erp_cloud_restore_attempts_active_epoch_uq[\s\S]+where status in \('prepared','executing'\)/u);
assert.match(SQL, /create unique index erp_cloud_restore_attempts_completed_fingerprint_uq[\s\S]+where status = 'completed'/u);
assert.match(SQL, /create policy "cloud restore own durable attempt read"[\s\S]+digest\(auth\.uid\(\)::text, 'sha256'\)/u);

for (const name of [
  'erp_prepare_cloud_restore_attempt',
  'erp_begin_cloud_restore_attempt',
  'erp_restore_cloud_snapshot_attempt',
  'erp_reconcile_cloud_restore_attempt',
]) {
  assert.match(SQL, new RegExp(`create function public\\.${name}\\(`, 'u'));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${name}\\(`, 'u'));
}
assert.match(SQL, /revoke all on function public\.erp_restore_cloud_snapshot_effective\([^)]+\) from authenticated/u);
const executeFunction = SQL.slice(
  SQL.indexOf('create function public.erp_restore_cloud_snapshot_attempt('),
  SQL.indexOf('create function public.erp_reconcile_cloud_restore_attempt('),
);
assert.equal((executeFunction.match(/public\.erp_restore_cloud_snapshot\(/gu) || []).length, 1);
assert(executeFunction.indexOf('v_result := public.erp_restore_cloud_snapshot(') < executeFunction.indexOf("set status = 'completed'"));
assert.match(executeFunction, /where attempt_id = p_attempt_id and trace_id = p_trace_id and actor_key = v_actor_key for update/u);
assert.match(executeFunction, /status <> 'executing' or v_attempt\.execution_id is distinct from p_execution_id/u);
assert.match(executeFunction, /erp-cloud-restore-attempt:/u);
assert.match(executeFunction, /set statement_timeout = '120s'/u);

const reconcileFunction = SQL.slice(
  SQL.indexOf('create function public.erp_reconcile_cloud_restore_attempt('),
  SQL.indexOf('revoke all on function public.erp_prepare_cloud_restore_attempt('),
);
assert.match(reconcileFunction, /timeout-grace-active/u);
assert.match(reconcileFunction, /epoch-or-fingerprint-ambiguous/u);
assert.match(reconcileFunction, /active-execution-lock/u);
assert.match(reconcileFunction, /status = 'not_committed'/u);
assert.doesNotMatch(reconcileFunction, /delete from|insert into public\.(?!erp_cloud_restore_attempts)|erp_restore_cloud_snapshot\(/iu);

const restoreMethod = PROVIDER.slice(PROVIDER.indexOf('async restoreCloudSnapshot('), PROVIDER.indexOf('private async applyCloudFieldMutations'));
assert.equal((restoreMethod.match(/supabase\.rpc\(CLOUD_RESTORE_RPC/gu) || []).length, 1);
assert.doesNotMatch(restoreMethod, /\bretry\b|\bwhile\s*\(|\bsetInterval\b|\bsetTimeout\b|\bPromise\.race\b/u);
assert.match(restoreMethod, /reconcileDestructiveUncertainty\(command\.attempt\)/u);
assert.match(PROVIDER, /reconcileDestructiveUncertainty[\s\S]+missing\/failed reconciliation[\s\S]+CLOUD_RESTORE_ATTEMPT_PENDING/u);
assert.match(PROVIDER, /async prepareCloudRestoreAttempt\([\s\S]+CLOUD_RESTORE_ATTEMPT_PREPARE_RPC[\s\S]+CLOUD_RESTORE_ATTEMPT_BEGIN_RPC/u);
assert.match(PANEL, /cloud-restore-check-outcome/u);
assert.match(PANEL, /查證伺服器結果（不會重跑 Restore）/u);
assert.match(PANEL, /submissionLockedRef\.current = requiresOutcomeCheck \|\| visible\.code === 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED'/u);
assert.match(PROVIDER, /Preserve a known PostgreSQL\/PostgREST category[\s\S]+createCloudRestoreSafeSubmitError\(error, 'server-response'\)/u);
assert.match(SUBMIT, /CLOUD_RESTORE_ATTEMPT_PENDING/u);
assert.match(SUBMIT, /CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED/u);

class DurableAttemptModel {
  epoch = 3;
  fingerprint = 'before';
  business = { marker: 'before' };
  attempt = null;
  dispatches = 0;
  lock = false;

  prepare({ attemptId = crypto.randomUUID(), fingerprint = 'target' } = {}) {
    if (this.attempt?.status === 'completed' && this.attempt.fingerprint === fingerprint) return this.outcome();
    if (this.attempt && ['prepared', 'executing'].includes(this.attempt.status)) throw new Error('CLOUD_RESTORE_ATTEMPT_PENDING');
    this.attempt = { attemptId, traceId: crypto.randomUUID(), status: 'prepared', expectedEpoch: this.epoch, fingerprint };
    return this.outcome();
  }

  begin() {
    if (this.attempt.status !== 'prepared') throw new Error('CLOUD_RESTORE_ATTEMPT_PENDING');
    this.attempt.status = 'executing';
    this.attempt.executionId = crypto.randomUUID();
    return this.outcome();
  }

  execute({ fail = null, responseLost = false } = {}) {
    if (this.attempt.status !== 'executing') throw new Error('CLOUD_RESTORE_ATTEMPT_NOT_EXECUTABLE');
    this.dispatches += 1;
    const before = structuredClone(this.business);
    const beforeEpoch = this.epoch;
    const beforeFingerprint = this.fingerprint;
    this.lock = true;
    try {
      this.business = { marker: 'candidate' };
      if (fail) throw new Error(fail);
      this.epoch += 1;
      this.fingerprint = this.attempt.fingerprint;
      this.attempt.status = 'completed';
      this.attempt.resultEpoch = this.epoch;
      this.attempt.restoreResult = { ok: true, restoreEpoch: this.epoch };
      if (responseLost) throw Object.assign(new Error('RESPONSE_LOST_AFTER_COMMIT'), { committed: true });
      return this.outcome();
    } catch (error) {
      if (error.committed) throw error;
      this.business = before;
      this.epoch = beforeEpoch;
      this.fingerprint = beforeFingerprint;
      throw error;
    } finally {
      this.lock = false;
    }
  }

  reconcile({ graceElapsed = true } = {}) {
    if (this.attempt.status === 'completed') return this.outcome();
    if (!graceElapsed || this.lock) return { ...this.outcome(), status: 'pending' };
    if (this.epoch !== this.attempt.expectedEpoch || this.fingerprint === this.attempt.fingerprint) {
      return { ...this.outcome(), status: 'pending' };
    }
    this.attempt.status = 'not_committed';
    return this.outcome();
  }

  outcome() { return structuredClone(this.attempt); }
}

// A/B: durable evidence exists before destructive work and success is atomic with epoch/data.
const success = new DurableAttemptModel();
assert.equal(success.prepare().status, 'prepared');
assert.equal(success.begin().status, 'executing');
assert.equal(success.execute().status, 'completed');
assert.equal(success.epoch, 4);
assert.deepEqual(success.business, { marker: 'candidate' });

// C: response lost after commit reconciles to completed without a second dispatch.
const lostSuccess = new DurableAttemptModel();
lostSuccess.prepare();
lostSuccess.begin();
assert.throws(() => lostSuccess.execute({ responseLost: true }), /RESPONSE_LOST_AFTER_COMMIT/u);
assert.equal(lostSuccess.reconcile().status, 'completed');
assert.equal(lostSuccess.dispatches, 1);
assert.equal(lostSuccess.epoch, 4);

// D/23503/57014: rollback preserves the independently committed envelope and no business partial write.
for (const code of ['23503', '57014']) {
  const rolledBack = new DurableAttemptModel();
  rolledBack.prepare();
  rolledBack.begin();
  assert.throws(() => rolledBack.execute({ fail: code }), new RegExp(code, 'u'));
  assert.equal(rolledBack.attempt.status, 'executing');
  assert.equal(rolledBack.epoch, 3);
  assert.deepEqual(rolledBack.business, { marker: 'before' });
  assert.equal(rolledBack.reconcile({ graceElapsed: false }).status, 'pending');
  assert.equal(rolledBack.reconcile({ graceElapsed: true }).status, 'not_committed');
  assert.equal(rolledBack.dispatches, 1);
}

// E/F/G: active lock and changed epoch stay fail-closed; duplicate active intent is rejected.
const active = new DurableAttemptModel();
active.prepare();
active.begin();
active.lock = true;
assert.equal(active.reconcile().status, 'pending');
active.lock = false;
active.epoch = 4;
assert.equal(active.reconcile().status, 'pending');
assert.throws(() => active.prepare(), /CLOUD_RESTORE_ATTEMPT_PENDING/u);

// H: a completed fingerprint is replay evidence, not a second destructive dispatch.
const replay = new DurableAttemptModel();
replay.prepare({ fingerprint: 'target' });
replay.begin();
replay.execute();
assert.equal(replay.prepare({ fingerprint: 'target' }).status, 'completed');
assert.equal(replay.dispatches, 1);

console.log('PASS durable PREPARE/BEGIN/EXECUTE/RECONCILE lifecycle, rollback, response-loss, pending, duplicate, and replay matrix');
console.log('PASS 038 fail-closed static contract, 120s+15s reconciliation boundary, hashed actor identity, RLS/ACL, and legacy bypass closure');
console.log('PENDING real PostgreSQL 038 apply/postflight: Staging SQL apply is forbidden in this turn');
