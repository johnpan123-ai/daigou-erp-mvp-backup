import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

// Explicitly isolated only. A missing URL never falls back to Supabase or a
// local main cluster. 045 is applied only to a disposable loopback database.
const url = process.env.WACA_ISOLATED_PG_URL;
if (!url) throw new Error('Set WACA_ISOLATED_PG_URL to the disposable PostgreSQL test database.');
const target = new URL(url);
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.port, '55492');
assert.ok(target.pathname.startsWith('/waca_v3_'));
const databaseName = `waca_v3_test_${randomBytes(4).toString('hex')}`;
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const isolatedUrl = new URL(url);
isolatedUrl.pathname = `/${databaseName}`;
const client = new pg.Client({ connectionString: isolatedUrl.toString() });
const historicalCloudRestoreMigrations = [
  '024_cloud_restore_snapshot_export.sql',
  '025_cloud_atomic_restore_execution_timeout.sql',
  '026_cloud_restore_guarded_full_delete.sql',
  // 027 was a historical transitional artifact whose id-only inventory PK
  // contract is incompatible with the canonical inventory_key schema. 028
  // supersedes it and is the installed cloud baseline for this candidate.
  '028_cloud_restore_schema_aware_safeupdate_delete.sql',
  // 029 also requires the transitional id-only inventory PK; the final 030+
  // chain is validated below against canonical inventory_key.
  '030_cloud_restore_cross_environment_audit_identity_portability.sql',
  // 031-034 are separate Japan/outbound feature migrations. Their schema
  // preflight requires the full business schema, not this Restore fixture.
  '035_cloud_restore_cross_environment_effective_path.sql',
  '036_cloud_restore_final_closure.sql',
  '037_cloud_restore_row_shape_fix.sql',
  '038_cloud_restore_durable_attempt_envelope.sql',
  '039_cloud_restore_integrity_audit.sql',
  '040_cloud_restore_owner_builder_proof.sql',
  '041_cloud_restore_durable_failure_recovery.sql',
  '042_cloud_restore_durable_execution_closure.sql',
  '043_cloud_restore_execute_dispatch_boundary.sql',
];

function functionDdl(source, name) {
  const marker = new RegExp(`create(?: or replace)? function public\\.${name}\\s*\\(`, 'i');
  const match = marker.exec(source);
  assert.ok(match, `${name} function missing`);
  const start = match.index;
  const rest = source.slice(start);
  const delimiter = /\bas (\$[A-Za-z_0-9]*\$)/i.exec(rest);
  assert.ok(delimiter, `${name} body delimiter missing`);
  const bodyStart = delimiter.index + delimiter[0].length;
  const end = rest.indexOf(delimiter[1], bodyStart);
  assert.ok(end > bodyStart, `${name} body close missing`);
  const semi = rest.indexOf(';', end + delimiter[1].length);
  assert.ok(semi >= 0, `${name} terminator missing`);
  return rest.slice(0, semi + 1).replace(/^create function/i, 'create or replace function');
}

await admin.connect();
await admin.query(`create database ${databaseName}`);
await client.connect();
try {
  await client.query(readFileSync('tests/sql/waca-isolated-bootstrap.sql', 'utf8'));
  await client.query('create schema extensions');
  await client.query('create extension if not exists pgcrypto with schema extensions');
  await client.query(readFileSync('supabase/sql/044_waca_cloud_ledger.sql', 'utf8'));
  await client.query(readFileSync('tests/sql/waca-isolated-transaction.sql', 'utf8'));
  await client.query('reset role');
  await client.query(`create function public.waca_isolated_fault() returns trigger language plpgsql as $$
    begin raise exception 'WACA_ISOLATED_INJECTED_FAILURE:%',tg_table_name; end $$`);
  await client.query('set role authenticated');
  await client.query("set request.jwt.claim.sub='00000000-0000-4000-8000-000000000099'");
  const { rows: baselineRows } = await client.query('select public.erp_read_waca_snapshot() as snapshot');
  await client.query('reset role');
  const incoming = structuredClone(baselineRows[0].snapshot);
  incoming.orders.push({ key: 'WACA::FAULT-B', orderNumber: 'FAULT-B', status: '完成付款', purchasedAt: '2026-09-28' });
  incoming.items.push({ ...incoming.items[0], key: 'WACA::FAULT-B::F2', orderKey: 'WACA::FAULT-B',
    feature: 'F2', quantity: 1 });
  incoming.mappings.push({ ...incoming.mappings[0], feature: 'F2' });
  incoming.batches.push({ ...incoming.batches[0], id: 'FAULT-B2' });
  for (const [table, event] of [
    ['waca_order_items', 'insert'], // after order upsert
    ['waca_mappings', 'insert'], // mapping failure
    ['waca_import_batches', 'insert'], // before quantity projection
    ['product_variants', 'update'], // quantity recompute failure
  ]) {
    await client.query(`create trigger waca_isolated_fault before ${event} on public.${table}
      for each row execute function public.waca_isolated_fault()`);
    await client.query('set role authenticated');
    await assert.rejects(() => client.query('select public.erp_commit_waca_snapshot($1::jsonb,5,true)', [incoming]),
      /WACA_ISOLATED_INJECTED_FAILURE/u);
    await client.query('reset role');
    await client.query(`drop trigger waca_isolated_fault on public.${table}`);
    const { rows: unchanged } = await client.query(`select
      (select revision from public.waca_state) revision,
      (select count(*)::integer from public.waca_orders) orders,
      (select count(*)::integer from public.waca_order_items) items,
      (select count(*)::integer from public.waca_import_batches) batches,
      (select waca_auto_quantity from public.product_variants where local_id='v-11') quantity`);
    assert.deepEqual(unchanged[0], { revision: '5', orders: 1, items: 1, batches: 1, quantity: 11 },
      `${table} fault must roll back the entire import transaction`);
  }
  await client.query('drop function public.waca_isolated_fault()');
  await client.query(readFileSync('tests/sql/waca-isolated-restore-core.sql', 'utf8'));
  await client.query(`do $$ declare v_table text; begin
    foreach v_table in array array[
      'inventory_items','product_groups','product_categories','bundle_components',
      'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders',
      'sales_order_items','japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
    ] loop
      execute format('alter table public.%I add column updated_by uuid references auth.users(id) on delete set null',v_table);
    end loop;
  end $$`);
  await client.query(readFileSync('supabase/sql/023_cloud_atomic_json_restore.sql', 'utf8'));
  await client.query('set check_function_bodies=off');
  await client.query('create table public.import_batches(id uuid primary key,updated_by uuid references auth.users(id) on delete set null)');
  await client.query('create table public.dashboard_category_images(id uuid primary key,category_key text unique,updated_by uuid references auth.users(id) on delete set null)');
  for (const file of historicalCloudRestoreMigrations) {
    try { await client.query(readFileSync(`supabase/sql/${file}`, 'utf8')); }
    catch (error) { throw new Error(`Historical migration ${file} failed: ${error.message}`, { cause: error }); }
  }
  const migration = readFileSync('supabase/sql/045_waca_cloud_atomic_restore_closure.sql', 'utf8');
  try { await client.query(migration); }
  catch (error) {
    await client.query('rollback');
    const { rows: diagnosis } = await client.query(`select pg_get_functiondef('public.erp_cloud_restore_audit_dataset(jsonb)'::regprocedure) as definition`);
    const text = diagnosis[0].definition;
    const at = text.indexOf('relspec(child_table');
    console.error('Audit source anchor:', JSON.stringify(text.slice(at - 100, at + 80)));
    throw error;
  }
  // Apply the actual installed 020 CAS gateway source, not a mock whitelist.
  // Function-body validation is off because this disposable core fixture does
  // not contain unrelated 020 entity columns; 046 is a source-exact patch.
  await client.query(functionDdl(readFileSync('supabase/sql/020_cloud_field_cas.sql', 'utf8'),
    'erp_apply_field_mutations'));
  await client.query(readFileSync('supabase/sql/046_waca_myacg_parent_evidence.sql', 'utf8'));
  const { rows: parentRows } = await client.query(`select pg_get_functiondef(
    'public.erp_apply_field_mutations(text,jsonb)'::regprocedure) as definition`);
  assert.ok(parentRows[0].definition.includes("'myacg_item_code','myacg_parent_code','product_id'"));
  const { rows: parentColumn } = await client.query(`select column_name from information_schema.columns
    where table_schema='public' and table_name='inventory_items' and column_name='myacg_parent_code'`);
  assert.equal(parentColumn.length, 1);
  const { rows } = await client.query(`select pg_get_functiondef('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure) as definition`);
  assert.ok(rows[0].definition.includes("'resourceCount', 24"));
  assert.ok(rows[0].definition.includes('erp_cloud_restore_recompute_waca_quantities'));
  const { rows: snapshots } = await client.query(`select jsonb_build_object(
    'import_batches','[]'::jsonb,
    'dashboard_category_images','[]'::jsonb,
    'product_variants',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.product_variants t),
    'waca_orders',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_orders t),
    'waca_order_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_order_items t),
    'waca_mappings',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_mappings t),
    'waca_master_links',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_master_links t),
    'waca_import_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_import_batches t),
    'waca_cutover_audit',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_cutover_audit t),
    'waca_state',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_state t)
  ) as data`);
  const snapshot = snapshots[0].data;
  await client.query('select public.erp_cloud_restore_validate_waca_dataset($1::jsonb)', [snapshot]);
  const tables = [
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders',
    'sales_order_items','japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items',
    'dashboard_category_images','import_batches','waca_orders','waca_order_items','waca_mappings',
    'waca_master_links','waca_import_batches','waca_cutover_audit','waca_state',
  ];
  const fullSnapshot = Object.fromEntries(tables.map(table => [table, snapshot[table] ?? []]));
  const { rows: audited } = await client.query('select public.erp_cloud_restore_audit_dataset($1::jsonb) as result', [fullSnapshot]);
  assert.equal(Object.keys(audited[0].result.table_counts).length, 24);
  assert.equal(audited[0].result.table_counts.waca_order_items, 1);

  await client.query(`insert into public.dashboard_category_images(id,category_key)
    values('00000000-0000-4000-8000-000000000031','hololive')`);
  await client.query(`insert into public.import_batches(id)
    values('00000000-0000-4000-8000-000000000032')`);
  const { rows: live } = await client.query('select public.erp_cloud_restore_snapshot() as data');
  const liveData = live[0].data;
  assert.equal(Object.keys(liveData).length, 24);
  const { rows: liveAudit } = await client.query('select public.erp_cloud_restore_audit_dataset($1::jsonb) as result', [liveData]);
  assert.equal(Number(liveAudit[0].result.integrity.orphan_count), 0);
  const manifest = {
    schemaVersion: 'cloud-erp-snapshot-v2', resourceCount: 24,
    counts: liveAudit[0].result.table_counts, totalRows: Number(liveAudit[0].result.total_rows),
    orphanCount: 0, duplicateVariantIdCount: 0, duplicateVariantLocalIdCount: 0,
  };
  await client.query('set role authenticated');
  await client.query("set request.jwt.claim.sub='00000000-0000-4000-8000-000000000099'");
  await assert.rejects(() => client.query(`select public.erp_restore_cloud_snapshot(
    '00000000-0000-4000-8000-000000000040'::uuid,repeat('f',64),$1::jsonb,$2::jsonb,'isolated')`,
  [liveData, manifest]), /permission denied/);
  await client.query('reset role');
  // 043 intentionally revokes the direct writer from authenticated users.
  // Invoke it as the isolated postgres owner to exercise the internal writer;
  // separate dispatch tests cover the public proof/execute transport.
  const { rows: restored } = await client.query(`select public.erp_restore_cloud_snapshot(
    '00000000-0000-4000-8000-000000000041'::uuid,repeat('a',64),$1::jsonb,$2::jsonb,'isolated') as result`,
  [liveData, manifest]);
  assert.equal(restored[0].result.ok, true);
  const { rows: afterRestore } = await client.query('select public.erp_cloud_restore_snapshot() as data');
  assert.equal(afterRestore[0].data.product_variants[0].waca_auto_quantity, 11);
  assert.equal(afterRestore[0].data.waca_order_items.length, 1);
  assert.equal(afterRestore[0].data.dashboard_category_images.length, 1);
  assert.equal(afterRestore[0].data.import_batches.length, 1);
  const invalidRestore = structuredClone(afterRestore[0].data);
  invalidRestore.dashboard_category_images.push({
    id: '00000000-0000-4000-8000-000000000033', category_key: 'hololive', updated_by: null,
  });
  const invalidManifest = { ...manifest,
    counts: { ...manifest.counts, dashboard_category_images: 2 }, totalRows: manifest.totalRows + 1 };
  await assert.rejects(() => client.query(`select public.erp_restore_cloud_snapshot(
    '00000000-0000-4000-8000-000000000042'::uuid,repeat('b',64),$1::jsonb,$2::jsonb,'isolated')`,
  [invalidRestore, invalidManifest]), /duplicate key|unique/u);
  const { rows: afterFailure } = await client.query('select public.erp_cloud_restore_snapshot() as data');
  assert.deepEqual(afterFailure[0].data, afterRestore[0].data, 'failed 24-resource restore must roll back all business tables');
  const changed = structuredClone(snapshot);
  changed.product_variants[0].waca_auto_quantity += 1;
  await assert.rejects(() => client.query('select public.erp_cloud_restore_validate_waca_dataset($1::jsonb)', [changed]),
    /WACA_RESTORE_QUANTITY_MISMATCH/);
  console.log('PASS isolated PostgreSQL: WACA 5x import, 4 injected import rollback points, 24-resource restore rollback, Restore-specific 023-026/028/030/035-043 plus 045 and actual-020 CAS 046; authenticated direct writer denied');
} finally {
  await client.end();
  await admin.query(`drop database ${databaseName}`);
  await admin.end();
}
