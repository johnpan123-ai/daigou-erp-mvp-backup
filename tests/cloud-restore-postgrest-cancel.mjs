import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const apiUrl = new URL(process.env.RESTORE_POSTGREST_URL ?? '');
const connectionString = process.env.RESTORE_FAILURE_LOCAL_PG ?? '';
const jwtSecret = process.env.RESTORE_POSTGREST_JWT_SECRET ?? '';
assert(['127.0.0.1', 'localhost'].includes(apiUrl.hostname));
const databaseUrl = new URL(connectionString);
assert(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
assert.match(databaseUrl.pathname, /^\/restore_failure_fixture(?:_\d+)?$/u);
assert(jwtSecret.length >= 32);

const OWNER = '11111111-1111-4111-8111-111111111111';
const source = 'a'.repeat(64);
const effective = 'b'.repeat(64);
const attempt = randomUUID();
const trace = randomUUID();
const execution = randomUUID();
const manifest = {
  snapshotFingerprint: effective,
  portability: {
    sourceSnapshotFingerprint: source,
    policyVersion: 'cross-environment-audit-null-v1',
    targetProjectRef: 'rhfdjsklfrgpoqsaqpkn',
  },
};

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
  sub: OWNER,
  role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 600,
})}`;
const token = `${unsigned}.${createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')}`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const db = new Client({ connectionString, application_name: 'postgrest_cancel_observer' });
await db.connect();
try {
  // The native fixture supports direct pg session claims and PostgREST's
  // request.jwt.claims JSON. Production Supabase auth.uid() already handles
  // the latter; this replacement is local-fixture-only.
  await db.query(`create or replace function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub',true),''),
      nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'
    )::uuid
  $$`);
  await db.query('begin');
  await db.query('delete from public.erp_cloud_restore_requests');
  await db.query('delete from public.erp_cloud_restore_snapshots');
  await db.query('delete from public.erp_cloud_restore_failures');
  await db.query('delete from public.erp_cloud_restore_attempts');
  await db.query('delete from public.fixture_business');
  await db.query("insert into public.fixture_business values(1,'before')");
  await db.query("update public.erp_cloud_restore_epoch set epoch=7,snapshot_fingerprint=$1", ['c'.repeat(64)]);
  await db.query(`insert into public.erp_cloud_restore_attempts(
    attempt_id,trace_id,actor_key,source_fingerprint,effective_fingerprint,restore_policy,
    target_environment,expected_epoch,timeout_budget_ms,timeout_contract_version,status
  ) values($1,$2,encode(extensions.digest($3::text,'sha256'),'hex'),$4,$5,$6,$7,7,120000,$8,'prepared')`, [
    attempt, trace, OWNER, source, effective, 'cross-environment-audit-null-v1',
    'rhfdjsklfrgpoqsaqpkn', 'postgresql-statement-timeout-v1',
  ]);
  await db.query('commit');

  const controller = new AbortController();
  const request = fetch(new URL('/rpc/erp_restore_cloud_snapshot_attempt', apiUrl), {
    method: 'POST', headers, signal: controller.signal, body: JSON.stringify({
      p_attempt_id: attempt,
      p_trace_id: trace,
      p_execution_id: execution,
      p_snapshot_fingerprint: effective,
      p_source_snapshot: { fault: 'SLOW_SUCCESS' },
      p_manifest: manifest,
      p_source_environment: 'fixture',
      p_restore_mode: 'cross-environment-audit-null-v1',
    }),
  });
  void request.catch(() => undefined);
  let entered = false;
  for (let n = 0; n < 250; n += 1) {
    const activity = await db.query(`select exists(
      select 1 from pg_stat_activity
       where pid<>pg_backend_pid() and query like '%erp_restore_cloud_snapshot_attempt%'
         and wait_event='PgSleep'
    ) as entered`);
    if (activity.rows[0].entered) { entered = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(entered, 'PostgREST RPC did not enter the real PostgreSQL function');
  controller.abort('isolated-http-client-disconnect');
  let abortReason;
  try {
    await request;
    assert.fail('aborted HTTP client unexpectedly received a response');
  } catch (error) {
    abortReason = error;
  }
  assert(abortReason === 'isolated-http-client-disconnect'
    || abortReason?.name === 'TypeError' || abortReason?.name === 'AbortError');

  for (let n = 0; n < 300; n += 1) {
    const activity = await db.query(`select exists(
      select 1 from pg_stat_activity
       where pid<>pg_backend_pid() and query like '%erp_restore_cloud_snapshot_attempt%'
    ) as active`);
    if (!activity.rows[0].active) break;
    if (n === 299) throw new Error('PostgREST RPC remained active after bounded observation');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const row = (await db.query(`select status,execution_id,result_epoch,canonical_result
    from public.erp_cloud_restore_attempts where attempt_id=$1`, [attempt])).rows[0];
  const failures = Number((await db.query('select count(*)::integer as count from public.erp_cloud_restore_failures where attempt_id=$1', [attempt])).rows[0].count);

  let reconciliation;
  if (row.status === 'completed') {
    assert.equal(row.execution_id, execution);
    assert.equal(Number(row.result_epoch), 8);
    assert.equal(row.canonical_result.ok, true);
    assert.equal(failures, 0);
    const response = await fetch(new URL('/rpc/erp_reconcile_cloud_restore_attempt', apiUrl), {
      method: 'POST', headers, body: JSON.stringify({ p_attempt_id: attempt, p_trace_id: trace }),
    });
    assert.equal(response.status, 200);
    reconciliation = await response.json();
    assert.equal(reconciliation.status, 'completed');
  } else {
    assert.equal(row.status, 'prepared');
    assert.equal(row.execution_id, null);
    assert.equal(failures, 0);
    assert.equal(Number((await db.query('select epoch from public.erp_cloud_restore_epoch where singleton=true')).rows[0].epoch), 7);
    await db.query("update public.erp_cloud_restore_attempts set submitted_at=now()-interval '10 minutes' where attempt_id=$1", [attempt]);
    const response = await fetch(new URL('/rpc/erp_reconcile_cloud_restore_attempt', apiUrl), {
      method: 'POST', headers, body: JSON.stringify({ p_attempt_id: attempt, p_trace_id: trace }),
    });
    assert.equal(response.status, 200);
    reconciliation = await response.json();
    assert.equal(reconciliation.status, 'not_committed');
  }

  console.log(JSON.stringify({
    runtime: 'PostgREST 14.16 + PostgreSQL 18',
    httpClient: 'aborted-after-rpc-entered-pg-sleep',
    serverTerminalState: row.status,
    failureRowsBeforeReconcile: failures,
    reconciledStatus: reconciliation.status,
    secondExecuteDispatches: 0,
    liveConnections: 0,
  }));
  console.log('PASS real PostgREST HTTP abort preserves an evidence-based committed or prepared state; reconcile never re-executes');
} finally {
  await db.end();
}
