// 080 candidate contract (isolated PostgreSQL, synthetic rows): same 24-resource JSON byte-for-byte,
// function config/ACL, owner gate, single-flight (fail closed, lock released on commit/cancel), rollback.
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
// The candidate is canonical LF; keep the rollback file's original transport
// bytes because the deployed v33 function is known to have a CRLF prosrc.
// Compare rollback bodies after newline normalization for isolated portability.
const sqlText = file => readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n');
const CANDIDATE = sqlText('supabase/candidates/080_backup_export_function_timeout_single_flight.sql');
const ROLLBACK = readFileSync('supabase/candidates/080_rollback.sql', 'utf8');
const RESOURCES = ['inventory_items', 'product_groups', 'product_categories', 'product_variants', 'bundle_components', 'purchase_batches', 'purchase_batch_items',
  'private_orders', 'private_order_items', 'sales_orders', 'sales_order_items', 'japan_packages', 'japan_package_items', 'outbound_shipments', 'outbound_shipment_items',
  'dashboard_category_images', 'import_batches', 'waca_orders', 'waca_order_items', 'waca_mappings', 'waca_master_links', 'waca_import_batches', 'waca_cutover_audit', 'waca_state'];
const db = await isolatedDatabase();
const other = '00000000-0000-4000-8000-000000000098';
const clients = [];
try {
  const { sql } = db;
  await sql.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'viewer@example.invalid','{}') on conflict do nothing", [other]);
  for (let n = 1; n <= 30; n++) await sql.query("insert into public.product_groups(id,title,show_in_purchase_list) values(gen_random_uuid(),$1,false)", [`合成備份測試 ${n}`]);
  await sql.query("insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,import_sort_index) select gen_random_uuid(),'k'||g,'C'||g,'合成','A',g from generate_series(1,50) g");
  const connect = async () => { const c = new pg.Client({ connectionString: db.url.toString() }); c.on('error', () => {}); await c.connect(); clients.push(c); return c; };
  const exportAs = async (client, actor, { begin = true, commit = true, timeout } = {}) => {
    if (begin) await client.query('begin');
    if (timeout) await client.query(`set local statement_timeout = ${timeout}`);
    if (actor) await client.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role','authenticated')::text, true)", [actor]);
    await client.query('set local role authenticated');
    const r = await client.query('select public.erp_export_cloud_restore_snapshot_json()::text t');
    if (commit) await client.query('commit');
    return r.rows[0].t;
  };
  const fnState = async () => (await sql.query(`select provolatile v, prosecdef sd, proconfig cfg, proacl::text acl, prosrc src from pg_proc where oid='public.erp_export_cloud_restore_snapshot_json()'::regprocedure`)).rows[0];
  const a = await connect(), b = await connect();
  const before = await exportAs(a, owner); const stateBefore = await fnState();
  assert.deepEqual(Object.keys(JSON.parse(before)), RESOURCES, '24 resources in contract order');

  const settingsBefore = (await sql.query('select count(*)::int n from pg_db_role_setting')).rows[0].n;
  await sql.query(CANDIDATE);
  const st = await fnState();
  assert.equal(st.v, 's', 'STABLE kept'); assert.equal(st.sd, true, 'SECURITY DEFINER kept');
  assert.ok(st.cfg.includes('statement_timeout=60s'), 'timeout scoped to this function'); assert.ok(!st.cfg.some(c => c.startsWith('jit=')), 'no ineffective jit clause'); assert.ok(st.cfg.some(c => c.startsWith('search_path=')), 'search_path kept');
  assert.ok(!st.cfg.some(c => c.startsWith('work_mem=')), 'work_mem not raised');
  assert.equal(st.acl, stateBefore.acl, 'ACL unchanged');
  assert.equal((await sql.query("select current_setting('statement_timeout') t")).rows[0].t, '0', 'no session/global timeout change'); assert.equal((await sql.query("select count(*)::int n from pg_db_role_setting")).rows[0].n, settingsBefore, 'no role/database setting change');
  const after = await exportAs(a, owner);
  assert.equal(after, before, 'byte-identical snapshot');
  // Owner gate unchanged.
  await assert.rejects(exportAs(b, null), /AUTHENTICATION_REQUIRED/u); await b.query('rollback');
  await assert.rejects(exportAs(b, other), /CLOUD_RESTORE_OWNER_REQUIRED/u); await b.query('rollback');
  // Single flight: A holds the export transaction open -> B fails fast; after A commits B succeeds.
  await exportAs(a, owner, { commit: false });
  const t = performance.now();
  await assert.rejects(exportAs(b, owner), /CLOUD_BACKUP_ALREADY_RUNNING/u); await b.query('rollback');
  assert.ok(performance.now() - t < 2000, 'second caller rejected immediately');
  await a.query('commit');
  assert.equal(await exportAs(b, owner), before, 'lock released on commit');
  // Cancellation is deterministic in the disposable DB: add only a test-local
  // sleep before the unchanged aggregate, cancel at 10ms, then restore the
  // exact candidate before checking that the transaction-scoped lock is gone.
  const slowCandidate = CANDIDATE.replace('  select json_build_object(', '  perform pg_sleep(0.05);\n  select json_build_object(');
  await sql.query(slowCandidate);
  await assert.rejects(exportAs(a, owner, { timeout: 10 }), /canceling statement|57014/u); await a.query('rollback');
  await sql.query(CANDIDATE);
  assert.equal(await exportAs(b, owner), before, 'lock released after cancel');
  // The read-only root-cause script runs as-is (both EXPLAIN ANALYZE passes) and persists nothing.
  const groupsBefore = (await sql.query('select count(*)::int n from public.product_groups')).rows[0].n;
  await sql.query(sqlText('supabase/candidates/080_readonly_root_cause_diagnostics.sql'));
  assert.equal((await sql.query("select current_setting('statement_timeout') t")).rows[0].t, '0', 'diagnostics left no setting behind');
  assert.equal((await sql.query('select count(*)::int n from public.product_groups')).rows[0].n, groupsBefore);
  // Rollback restores 065 state exactly (config, volatility, ACL) and the same output.
  await sql.query(ROLLBACK);
  const rb = await fnState();
  assert.deepEqual([rb.v, rb.sd, rb.acl, rb.src.replace(/\r\n?/gu, '\n')], [stateBefore.v, stateBefore.sd, stateBefore.acl, stateBefore.src.replace(/\r\n?/gu, '\n')], 'rollback = 055 body + 065 STABLE (newline-normalized)');
  assert.deepEqual(rb.cfg, stateBefore.cfg);
  assert.equal(await exportAs(a, owner), before);
  await a.end(); await b.end();
  console.log('PASS 080 candidate: identical 24-resource JSON, statement_timeout scoped to the RPC (no role/global change), ACL/owner gate unchanged, single-flight fail-closed, rollback exact');
} finally { await Promise.allSettled(clients.map(client => client.end())); await db.close(); }
