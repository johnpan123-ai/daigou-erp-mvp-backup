// 080 root-cause mechanism on the real API path (PostgREST 13 -> authenticator -> authenticated):
// a role-level statement_timeout on `authenticated` cancels the 24-resource export (HTTP 500 / 57014) while
// the same function succeeds in a postgres session; a function-scoped statement_timeout is applied by
// PostgREST for this RPC only. Synthetic data; isolated PostgreSQL + PostgREST.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
const db = await isolatedDatabase();
const out = {};
try {
  const { sql } = db;
  await sql.query("set session_replication_role = replica");
  for (const { conname } of (await sql.query("select conname from pg_constraint where conrelid='public.inventory_items'::regclass and contype='c'")).rows) await sql.query(`alter table public.inventory_items drop constraint "${conname}"`);
  await sql.query("insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,import_sort_index) select gen_random_uuid(),'k'||g,'C'||g,left(repeat(md5(g::text),40),900),'A',g from generate_series(1,40000) g");
  await sql.query("set session_replication_role = origin"); await sql.query('analyze');
  const rpc = async () => { const t = performance.now(); const r = await db.http('/rpc/erp_export_cloud_restore_snapshot_json', {}, owner, { method: 'POST' }); return { status: r.status, code: r.data?.code ?? null, ms: Math.round(performance.now() - t), bytes: r.status === 200 ? JSON.stringify(r.data).length : 0 }; };
  const direct = async () => { const t = performance.now(); await sql.query('begin'); await sql.query("select set_config('request.jwt.claims', json_build_object('sub',$1::text,'role','authenticated')::text, true)", [owner]); const r = await sql.query('select length(public.erp_export_cloud_restore_snapshot_json()::text)::int n'); await sql.query('commit'); return { ms: Math.round(performance.now() - t), bytes: r.rows[0].n }; };
  await sql.query("create function public.erp_debug_timeout() returns text language sql stable as $$ select current_setting('statement_timeout')||' role='||current_user $$; grant execute on function public.erp_debug_timeout() to authenticated");
  // Supabase topology: PostgREST logs in as non-superuser `authenticator` (noinherit) and switches to authenticated.
  await sql.query("do $$ begin if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'synthetic-authenticator'; end if; end $$; grant anon, authenticated to authenticator");
  const dbUrl = new URL(db.url.toString()); db.url.username = 'authenticator'; db.url.password = 'synthetic-authenticator';
  await db.startPostgrest();
  out.directNoTimeout = await direct();
  out.apiNoRoleTimeout = await rpc();
  assert.equal(out.apiNoRoleTimeout.status, 200);
  // Role-level timeout on `authenticated` (Supabase-style) below the export time -> API cancels with 57014.
  const roleTimeout = Math.max(50, Math.round(Math.min(out.directNoTimeout.ms, out.apiNoRoleTimeout.ms) / 4));
  await sql.query(`alter role authenticated set statement_timeout = '${roleTimeout}ms'`);
  await db.stopPostgrest(); await db.startPostgrest();   // PostgREST reads role settings at schema-cache load
  out.roleTimeoutMs = roleTimeout;
  out.apiWithRoleTimeout = await rpc();
  out.directWithRoleTimeout = await direct();              // postgres session: role setting of authenticated not applied
  out.roleSetting = (await sql.query("select rolconfig from pg_roles where rolname='authenticated'")).rows[0].rolconfig;
  out.apiSeenTimeout = (await db.http('/rpc/erp_debug_timeout', {}, owner, { method: 'POST' })).data;
  console.log('API080-PARTIAL ' + JSON.stringify(out));
  assert.equal(out.apiWithRoleTimeout.status, 500); assert.equal(out.apiWithRoleTimeout.code, '57014', 'API path reproduces HTTP 500 / 57014');
  // 080 candidate (function-scoped statement_timeout + single-flight): PostgREST applies it for this RPC only.
  const before = await db.http('/rpc/erp_export_cloud_restore_snapshot_json', {}, owner, { method: 'POST' }).catch(() => null); // still 57014
  await sql.query("alter role authenticated reset statement_timeout"); await db.stopPostgrest(); await db.startPostgrest();
  const reference = JSON.stringify((await db.http('/rpc/erp_export_cloud_restore_snapshot_json', {}, owner, { method: 'POST' })).data);
  await sql.query(`alter role authenticated set statement_timeout = '${roleTimeout}ms'`);
  await sql.query(readFileSync('supabase/candidates/080_backup_export_function_timeout_single_flight.sql', 'utf8'));   // includes NOTIFY pgrst reload
  await db.stopPostgrest(); await db.startPostgrest();
  out.apiWithFunctionTimeout = await rpc();
  out.identicalJsonViaApi = JSON.stringify((await db.http('/rpc/erp_export_cloud_restore_snapshot_json', {}, owner, { method: 'POST' })).data) === reference;
  assert.equal(out.identicalJsonViaApi, true, 'candidate returns the same 24-resource JSON through the API');
  // Single-flight through the API: concurrent callers -> exactly one 200, others fail fast with CLOUD_BACKUP_ALREADY_RUNNING.
  const conc = await Promise.all([0, 1, 2].map(() => db.http('/rpc/erp_export_cloud_restore_snapshot_json', {}, owner, { method: 'POST' })));
  out.apiConcurrent = conc.map(r => r.status === 200 ? 200 : `${r.status}:${r.data?.message}`);
  assert.equal(conc.filter(r => r.status === 200).length >= 1, true);
  assert.ok(conc.every(r => r.status === 200 || r.data?.message === 'CLOUD_BACKUP_ALREADY_RUNNING'));
  // Client abort mid-export: lock released, next export succeeds.
  const ac = new AbortController(); const p = db.http('/rpc/erp_export_cloud_restore_snapshot_json', {}, owner, { method: 'POST', signal: ac.signal }).catch(e => e.name);
  setTimeout(() => ac.abort(), 150); out.abort = await p;
  await new Promise(r => setTimeout(r, 3000));
  out.afterAbort = (await rpc()).status; assert.equal(out.afterAbort, 200);
  void before;
  assert.equal(out.apiWithFunctionTimeout.status, 200, 'function-scoped statement_timeout overrides the role timeout for this RPC');
  // Other RPCs/tables keep the short role timeout (no global change).
  const other = await db.http('/rpc/erp_export_cloud_restore_snapshot', {}, owner, { method: 'POST' }).catch(e => ({ status: 'ERR', data: { code: String(e) } }));
  out.otherRpcStillLimited = { status: other.status, code: other.data?.code ?? null };
  console.log('API080 ' + JSON.stringify(out));
} finally { await db.sql.query('alter role authenticated reset statement_timeout').catch(() => {}); await db.close(); }
