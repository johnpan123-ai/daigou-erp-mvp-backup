import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// ONLY an isolated in-memory PostgreSQL or explicitly loopback test database.
const native = process.env.RESTORE_FAILURE_LOCAL_PG;
let db;
if (native) {
  const url = new URL(native);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/restore_failure_fixture(?:_\d+)?$/u);
  const { Client } = await import('pg');
  db = new Client({ connectionString: native });
  await db.connect();
  db.exec = sql => db.query(sql);
  db.close = () => db.end();
} else {
  const runtime = process.env.RESTORE_AUDIT_PGLITE_PATH
    || resolve('../experimental-cloud-atomic-json-restore/scratch/restore-audit-pg-runtime/node_modules/@electric-sql/pglite/dist');
  const { PGlite } = await import(pathToFileURL(resolve(runtime, 'index.js')));
  const { pgcrypto } = await import(pathToFileURL(resolve(runtime, 'contrib/pgcrypto.js')));
  db = new PGlite({ extensions: { pgcrypto } });
}
const sql038 = readFileSync(new URL('../supabase/sql/038_cloud_restore_durable_attempt_envelope.sql', import.meta.url), 'utf8');
const sql041 = readFileSync(new URL('../supabase/sql/041_cloud_restore_durable_failure_recovery.sql', import.meta.url), 'utf8');
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const source = 'a'.repeat(64);
const effective = 'b'.repeat(64);
const manifest = { snapshotFingerprint: effective, portability: {
  sourceSnapshotFingerprint: source, policyVersion: 'cross-environment-audit-null-v1', targetProjectRef: 'rhfdjsklfrgpoqsaqpkn',
} };
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
let passed = 0;
const pass = message => { passed++; console.log('PASS', message); };

try {
  await db.exec(`
    create schema auth; create schema extensions;
    create extension pgcrypto with schema extensions;
    do $$begin
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
    end$$;
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function public.is_owner(id uuid) returns boolean language sql stable as $$select id='${OWNER}'::uuid$$;
    grant usage on schema auth,extensions to authenticated,anon;
    create table public.erp_cloud_restore_epoch(singleton boolean primary key,epoch bigint,snapshot_fingerprint text);
    insert into public.erp_cloud_restore_epoch values(true,7,'${'c'.repeat(64)}');
    create table public.erp_cloud_restore_requests(idempotency_key uuid primary key,status text,canonical_result jsonb);
    create table public.erp_cloud_restore_snapshots(id uuid primary key);
    create table public.fixture_business(id integer primary key,value text not null);
    insert into public.fixture_business values(1,'before');
  `);
  // Install real 038 table, policies, prepare/begin/execute/reconcile. The old
  // preflight checks 037 builder internals, which are covered by their own suites.
  const from = sql038.indexOf('create table public.erp_cloud_restore_attempts');
  const to = sql038.indexOf('do $restore_attempt_postflight$');
  assert(from > 0 && to > from);
  await db.exec(`
    create function public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text) returns jsonb
      language plpgsql security definer as $$begin
        if $1->>'fault'='PORTABILITY' then raise exception using errcode='22023',message='CLOUD_RESTORE_PORTABILITY_ROW_INVALID'; end if;
        return $1; end$$;
    create function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) returns jsonb
      language plpgsql security definer set search_path=pg_catalog,public,extensions set statement_timeout='120s' as $$
      declare n bigint; fault text:=$3->>'fault'; begin
        insert into public.erp_cloud_restore_requests values($1,'processing',null);
        insert into public.erp_cloud_restore_snapshots values($1);
        delete from public.fixture_business;
        insert into public.fixture_business values(2,'replacement');
        if fault='CONSTRAINT' then insert into public.fixture_business values(2,'duplicate-sensitive-value'); end if;
        if fault='VALIDATION' then raise exception using errcode='22023',message='fixture raw sensitive validation'; end if;
        if fault='TIMEOUT' then raise query_canceled using message='fixture raw cancelled SQL'; end if;
        if fault='REAL_TIMEOUT' then perform pg_sleep(5); end if;
        if fault='SLOW_SUCCESS' then perform pg_sleep(1); end if;
        if fault='INTERNAL' then raise exception using errcode='XX000',message='fixture secret internal'; end if;
        if fault='UNKNOWN' then raise exception 'fixture private failure'; end if;
        if fault='AUTHORIZATION' then raise insufficient_privilege; end if;
        -- Simulates an inner final validator after destructive writes.
        if fault='FINAL_VALIDATOR' then raise exception using errcode='22023',message='CLOUD_RESTORE_FINAL_VALIDATION_FAILED'; end if;
        update public.erp_cloud_restore_epoch set epoch=epoch+1,snapshot_fingerprint=$2 returning epoch into n;
        update public.erp_cloud_restore_requests set status='completed',canonical_result=jsonb_build_object('ok',true,'restoreEpoch',n) where idempotency_key=$1;
        if fault='BAD_CANONICAL' then return jsonb_build_object('ok',false); end if;
        return jsonb_build_object('ok',true,'restoreEpoch',n,'snapshotFingerprint',$2,'replayed',false);
      end$$;
    create function public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text) returns jsonb language sql as $$select '{}'::jsonb$$;
    create function public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text) returns jsonb language sql as $$select '{}'::jsonb$$;
    create function public.erp_read_cloud_restore_integrity_audit() returns jsonb language sql as $$select '{}'::jsonb$$;
    revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
    revoke all on function public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text) from public,anon,authenticated;
  `);
  await db.exec(sql038.slice(from, to));
  await db.exec(sql041); // Exact complete candidate migration, NOT extracted body.
  pass('complete 041 migration on isolated PostgreSQL with real 038 envelope/RLS');
  const login = async (id = OWNER, role = 'authenticated') => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",
      [id, JSON.stringify({ host: 'rhfdjsklfrgpoqsaqpkn.supabase.co' })]);
    await db.exec(`set role ${role}`);
  };
  const prepare = async () => {
    const attempt = randomUUID(), trace = randomUUID();
    const prepared = await scalar('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,120000,$7) as value',
      [attempt, trace, source, effective, 'cross-environment-audit-null-v1', 'rhfdjsklfrgpoqsaqpkn', 'postgresql-statement-timeout-v1']);
    assert.equal(prepared.status, 'prepared');
    const begin = await scalar('select public.erp_begin_cloud_restore_attempt($1,$2) as value', [attempt, trace]);
    return { attempt, trace, execution: begin.executionId };
  };
  const execute = (a, fault = '', m = manifest) => scalar('select public.erp_restore_cloud_snapshot_attempt($1,$2,$3,$4,$5,$6,$7,$8) as value',
    [a.attempt, a.trace, a.execution, effective, JSON.stringify({ fault }), JSON.stringify(m), 'fixture', 'cross-environment-audit-null-v1']);
  const reconcile = a => scalar('select public.erp_reconcile_cloud_restore_attempt($1,$2) as value', [a.attempt, a.trace]);
  const unchanged = async () => {
    await db.exec('reset role');
    assert.equal(Number(await scalar('select epoch as value from public.erp_cloud_restore_epoch')), 7);
    assert.equal(await scalar('select count(*)::integer as value from public.erp_cloud_restore_requests'), 0);
    assert.equal(await scalar('select count(*)::integer as value from public.erp_cloud_restore_snapshots'), 0);
    assert.deepEqual((await db.query('select * from public.fixture_business')).rows, [{ id: 1, value: 'before' }]);
    await login();
  };
  await login();
  for (const [fault, category] of [['CONSTRAINT','CONSTRAINT'],['VALIDATION','VALIDATION'],['TIMEOUT','TIMEOUT'],
    ['PORTABILITY','PORTABILITY'],['INTERNAL','INTERNAL'],['UNKNOWN','UNKNOWN'],['AUTHORIZATION','AUTHORIZATION'],
    ['FINAL_VALIDATOR','VALIDATION'],['BAD_CANONICAL','INTERNAL']]) {
    const a = await prepare();
    const result = await execute(a, fault);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'not_committed');
    assert.equal(result.failure.category, category);
    assert.equal(result.failure.evidence, 'caught-subtransaction');
    assert(!JSON.stringify(result).match(/sensitive|secret|private|raw cancelled/));
    await unchanged(); // separate statements AFTER the failed call committed
    const durable = await scalar('select code as value from public.erp_cloud_restore_failures where attempt_id=$1', [a.attempt]);
    assert.equal(durable, `CLOUD_RESTORE_FAILURE_${category}`);
    assert.deepEqual(await execute(a, ''), result, 'same execution cannot replay business work');
    assert.deepEqual(await reconcile(a), result);
    await assert.rejects(() => scalar('select public.erp_begin_cloud_restore_attempt($1,$2) as value', [a.attempt,a.trace]));
    await unchanged();
    pass(`${fault}: rollback + durable safe failure + terminal replay + reconcile + same attempt begin blocked`);
  }
  if (native) {
    const a = await prepare();
    await db.exec("set statement_timeout='150ms'");
    const start = Date.now();
    const result = await execute(a, 'REAL_TIMEOUT');
    await db.exec('set statement_timeout=0');
    assert.equal(result.failure.sqlstate, '57014');
    assert(Date.now()-start < 3000);
    await unchanged();
    pass('real PostgreSQL statement_timeout during pg_sleep, caught and persisted after rollback');
  } else console.log('NOT MEASURED native wall-clock statement timeout; SQLSTATE 57014 exception tested');
  const expired = await prepare();
  assert.equal((await reconcile(expired)).reason, 'timeout-grace-active');
  await db.exec('reset role');
  await db.query("update public.erp_cloud_restore_attempts set execution_started_at=now()-interval '10 minutes' where attempt_id=$1", [expired.attempt]);
  await login();
  await assert.rejects(() => execute(expired), /CLOUD_RESTORE_ATTEMPT_PENDING/);
  const closed = await reconcile(expired);
  assert.equal(closed.status, 'not_committed');
  assert.equal(closed.failure.evidence, 'reconciled-noncommit');
  assert.equal(closed.failure.sqlstate, null);
  await unchanged();
  pass('expired executing: no reexecute, reconcile closes with UNKNOWN cause and proven noncommit');
  const ambiguous = await prepare();
  await db.exec('reset role');
  await db.query("update public.erp_cloud_restore_attempts set execution_started_at=now()-interval '10 minutes' where attempt_id=$1", [ambiguous.attempt]);
  await db.exec('update public.erp_cloud_restore_epoch set epoch=8');
  await login();
  assert.equal((await reconcile(ambiguous)).status, 'pending');
  await db.exec('reset role');
  await db.exec('update public.erp_cloud_restore_epoch set epoch=7');
  await db.query("insert into public.erp_cloud_restore_requests values($1,'processing',null)", [ambiguous.attempt]);
  await login();
  assert.equal((await reconcile(ambiguous)).status, 'pending');
  await db.exec('reset role');
  await db.query('delete from public.erp_cloud_restore_requests where idempotency_key=$1', [ambiguous.attempt]);
  await login(); await reconcile(ambiguous);
  pass('ambiguous epoch/request evidence stays pending; no false rollback');
  const stale = await prepare();
  await db.exec('reset role'); await db.exec('update public.erp_cloud_restore_epoch set epoch=8'); await login();
  assert.equal((await execute(stale)).failure.category, 'STALE');
  await db.exec('reset role'); await db.exec('update public.erp_cloud_restore_epoch set epoch=7'); await login();
  await unchanged();
  pass('stale expected epoch is terminal safe STALE; no business write');
  await login(OTHER);
  assert.equal(await scalar('select count(*)::integer as value from public.erp_cloud_restore_failures'), 0);
  await assert.rejects(() => reconcile(expired), /CLOUD_RESTORE_OWNER_REQUIRED/);
  await assert.rejects(() => execute(expired), /CLOUD_RESTORE_OWNER_REQUIRED/);
  await login('', 'anon');
  await assert.rejects(() => reconcile(expired), /permission denied/);
  await assert.rejects(() => db.query('select * from public.erp_cloud_restore_failures'), /permission denied/);
  await login();
  await assert.rejects(() => db.query('delete from public.erp_cloud_restore_failures'), /permission denied/);
  await assert.rejects(() => scalar('select public.erp_cloud_restore_failure_result($1) as value', [expired.attempt]), /permission denied/);
  pass('OWNER RLS read; non-owner invisible; anon denied; direct writes/private helper denied');
  const success = await prepare();
  let good;
  if (native) {
    const { Client } = await import('pg');
    const peer = new Client({ connectionString: native, application_name: 'restore_failure_lock_fixture' });
    await peer.connect();
    try {
      await peer.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER]);
      await peer.query('set role authenticated');
      // A separate transaction holds the real attempt lock; reconcile must not wait.
      await peer.query('begin');
      await peer.query("select pg_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:'||$1,0))", [success.attempt]);
      const start = Date.now();
      assert.equal((await reconcile(success)).reason, 'active-execution-lock');
      assert(Date.now()-start < 1500);
      await assert.rejects(() => execute(success), /CLOUD_RESTORE_ATTEMPT_EXECUTION_CONFLICT/);
      await peer.query('rollback');
      // Row lock without advisory lock (e.g. begin response outstanding) is also nonblocking.
      await peer.query('reset role'); await peer.query('begin');
      await peer.query('select * from public.erp_cloud_restore_attempts where attempt_id=$1 for update', [success.attempt]);
      assert.equal((await reconcile(success)).reason, 'active-execution-lock');
      await peer.query('rollback');
      pass('two real PostgreSQL sessions: active attempt and row locks fail closed without blocking');
      await peer.query('set role authenticated');
      const inFlight = peer.query('select public.erp_restore_cloud_snapshot_attempt($1,$2,$3,$4,$5,$6,$7,$8) as value',
        [success.attempt, success.trace, success.execution, effective, JSON.stringify({ fault: 'SLOW_SUCCESS' }), JSON.stringify(manifest), 'fixture', 'cross-environment-audit-null-v1']);
      await db.exec('reset role');
      for (let n=0; n<100; n++) {
        if (await scalar("select exists(select 1 from pg_stat_activity where application_name='restore_failure_lock_fixture' and wait_event='PgSleep') as value")) break;
        if (n===99) throw new Error('fixture did not enter pg_sleep');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await login();
      assert.equal((await reconcile(success)).reason, 'active-execution-lock');
      await assert.rejects(() => execute(success), /CLOUD_RESTORE_ATTEMPT_EXECUTION_CONFLICT/);
      good = (await inFlight).rows[0].value;
      pass('slow execute + simultaneous reconcile/duplicate execute: one business transaction only');
    } finally { await peer.end(); }
  } else good = await execute(success);
  assert.equal(good.ok, true); assert.equal(good.restoreEpoch, 8);
  assert.equal((await execute(success)).replayed, true);
  assert.equal((await reconcile(success)).restoreResult.restoreEpoch, 8);
  await db.exec('reset role');
  assert.equal(await scalar('select count(*)::integer as value from public.erp_cloud_restore_snapshots'), 1);
  assert.equal(await scalar('select count(*)::integer as value from public.erp_cloud_restore_requests'), 1);
  pass('success epoch/canonical result/snapshot atomic; duplicate execute returns canonical replay only');
  assert.match(sql041, /set statement_timeout='120s'/);
  console.log(JSON.stringify({ passed, backend: native ? 'native PostgreSQL' : 'PGlite PostgreSQL', liveConnections: 0 }));
} finally { await db.close(); }
