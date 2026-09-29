import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { fingerprintStructuralSnapshot } from '../tools/schema-reconciliation/schemaContract.mjs';

const EXPECTED_FINGERPRINT = '6775a09526b7c55b8dd96d0d1d83dba12954f5d1c8d6dde8503d647f133a963b';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const snapshotSql = await read('../tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql');
const inventorySql = await read('../tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql');
const aclMatrixSql = await read('../tools/schema-reconciliation/sql/018b-import-batches-acl-matrix-readonly.sql');
const restoreCompatibilitySql = await read('../tools/schema-reconciliation/sql/045c-waca-restore-semantic-state-readonly.sql');
const repairFiles = [
  '045c_waca_cloud_atomic_restore_semantic_closure.sql',
  '046b_waca_myacg_parent_compatibility_repair.sql',
  '047_erp_schema_migration_ledger.sql',
];

async function createDatabase() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create schema extensions; create extension pgcrypto with schema extensions;
    create role authenticated; create role anon; create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create publication supabase_realtime;
  `);
  return db;
}

async function apply(db, files, label) {
  for (const file of files) {
    try { await db.exec(await read(`../supabase/sql/${file}`)); }
    catch (error) { throw new Error(`${label}:${file}:${error.message}`, { cause: error }); }
  }
}

async function capture(db) {
  const snapshot = (await db.query(snapshotSql)).rows[0].erp_schema_snapshot;
  snapshot.integrity.inventoryItems = (await db.query(inventorySql)).rows[0].inventory_items_integrity;
  snapshot.completeness.inventoryIntegrity = true;
  snapshot.identity.projectRef = 'rhfdjsklfrgpoqsaqpkn';
  return snapshot;
}

const through044 = CANONICAL_FRESH_INSTALL_V3.slice(
  0, CANONICAL_FRESH_INSTALL_V3.indexOf('045c_waca_cloud_atomic_restore_semantic_closure.sql'),
);
const controlFunctions = [
  'public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)',
  'public.erp_reconcile_cloud_restore_attempt(uuid,uuid)',
  'public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)',
  'public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)',
];

const canonicalDb = await createDatabase();
const partialDb = await createDatabase();
const driftDb = await createDatabase();
try {
  await apply(canonicalDb, CANONICAL_FRESH_INSTALL_V3, 'canonical');
  const canonical = await capture(canonicalDb);
  assert.equal(fingerprintStructuralSnapshot(canonical), EXPECTED_FINGERPRINT);

  await apply(partialDb, through044, 'live-like-through-044');
  await partialDb.exec(`
    grant maintain,references,trigger,truncate on table public.inventory_items to anon;
    grant delete,insert,maintain,references,select,trigger,truncate,update
      on table public.inventory_items to authenticated;
    insert into public.import_batches(platform,file_name) values('waca','partial-live-fixture.xlsx');
    insert into public.waca_orders(order_key,status,payload)
      values('fixture-order','\u8655\u7406\u4e2d',jsonb_build_object('key','fixture-order'));
    insert into public.waca_import_batches(batch_key,payload)
      values('fixture-batch',jsonb_build_object('key','fixture-batch'));
  `);
  const aclBefore = (await partialDb.query(aclMatrixSql)).rows[0].import_batches_acl_matrix;
  assert.equal(aclBefore.roles.find(role => role.role === 'anon').status, 'PASS');
  assert.equal(aclBefore.roles.find(role => role.role === 'authenticated').status, 'PASS');
  assert.equal(aclBefore.roles.find(role => role.role === 'postgres').status, 'PASS');
  assert.equal((await partialDb.query(restoreCompatibilitySql)).rows[0]
    .waca_045c_semantic_state.compatibilityState, 'STATE_A_PRE_045');
  const beforeCounts = (await partialDb.query(`select
    (select count(*)::int from public.import_batches) import_batches,
    (select count(*)::int from public.waca_orders) waca_orders,
    (select count(*)::int from public.waca_import_batches) waca_import_batches,
    (select count(*)::int from public.waca_state) waca_state,
    (select mode from public.waca_state limit 1) mode`)).rows[0];
  const controlBefore = Object.fromEntries(await Promise.all(controlFunctions.map(async signature => [
    signature,(await partialDb.query('select pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition,
  ])));

  const registry = await buildMigrationEffectRegistry();
  const beforePlan = planSchemaDelta(await capture(partialDb), registry, { expectedSnapshot: canonical });
  const migration = id => beforePlan.migrations.find(item => item.migrationId === id);
  assert.equal(migration('018').state, 'SATISFIED');
  assert.equal(migration('018b').state, 'SATISFIED');
  assert.equal(migration('045').state, 'PARTIAL');
  assert.equal(migration('045').coveredByRepair, '045c');
  assert.equal(migration('045b').coveredByRepair, '045c');
  assert.equal(migration('045c').safeToApply, true);
  assert.equal(migration('046').state, 'CONFLICT');
  assert.equal(migration('046').coveredByRepair, '046b');
  assert.equal(migration('046b').safeToApply, true);
  assert.equal(migration('047').safeToApply, true);
  assert.equal(beforePlan.readyForApply, true);
  assert.deepEqual(beforePlan.applyPlan.map(item => item.migrationId), ['045c','046b','047']);
  console.log('PASS exact post-018b planner delta = 045c -> 046b -> 047');

  await apply(partialDb, repairFiles, 'partial-live-repair');
  const afterOnce = await capture(partialDb);
  assert.equal(fingerprintStructuralSnapshot(afterOnce), EXPECTED_FINGERPRINT);
  assert.deepEqual((await partialDb.query(`select
    (select count(*)::int from public.import_batches) import_batches,
    (select count(*)::int from public.waca_orders) waca_orders,
    (select count(*)::int from public.waca_import_batches) waca_import_batches,
    (select count(*)::int from public.waca_state) waca_state,
    (select mode from public.waca_state limit 1) mode`)).rows[0], beforeCounts);
  for (const signature of controlFunctions) {
    const after = (await partialDb.query('select pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition;
    assert.equal(after, controlBefore[signature], signature);
  }
  const restoredSnapshot = (await partialDb.query('select public.erp_cloud_restore_snapshot() snapshot')).rows[0].snapshot;
  assert.equal(Object.keys(restoredSnapshot).length, 24);
  await partialDb.query('select public.erp_cloud_restore_validate_waca_dataset($1::jsonb)', [restoredSnapshot]);
  await partialDb.exec(`begin;
    insert into public.product_groups(id,title)
      values('00000000-0000-4000-8000-000000000090','WACA recompute fixture');
    insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,waca_auto_quantity)
      values('00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000090','G-FIXTURE','WACA recompute fixture','default',0);
    insert into public.waca_order_items(item_key,order_id,feature,product_variant_id,quantity,payload)
      select 'fixture-item',id,'fixture-feature','00000000-0000-4000-8000-000000000091',11,
        jsonb_build_object('key','fixture-item') from public.waca_orders where order_key='fixture-order';
    update public.waca_state set mode='ORDER_DRIVEN_ACTIVE',payload=jsonb_build_object('mode','ORDER_DRIVEN_ACTIVE');
    set local erp.cloud_restore_active='on';
    select public.erp_cloud_restore_recompute_waca_quantities();
  `);
  assert.equal((await partialDb.query("select waca_auto_quantity from public.product_variants where id='00000000-0000-4000-8000-000000000091'"))
    .rows[0].waca_auto_quantity, 11);
  await partialDb.query('select public.erp_cloud_restore_validate_waca_dataset(public.erp_cloud_restore_snapshot())');
  await partialDb.exec('rollback;');
  console.log('PASS 24-resource validator and order-derived WACA recompute 0 -> 11 execute successfully');
  const aclMatrix = (await partialDb.query(aclMatrixSql)).rows[0].import_batches_acl_matrix;
  assert.equal(aclMatrix.roles.find(role => role.role === 'anon').status, 'PASS');
  assert.equal(aclMatrix.roles.find(role => role.role === 'authenticated').status, 'PASS');
  assert.equal(aclMatrix.roles.find(role => role.role === 'postgres').status, 'PASS');
  assert.equal((await partialDb.query(restoreCompatibilitySql)).rows[0]
    .waca_045c_semantic_state.compatibilityState, 'STATE_D_CANONICAL');
  await partialDb.exec(`
    insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000099','acl-owner@example.test');
    update public.profiles set role='owner' where user_id='00000000-0000-4000-8000-000000000099';
    set role authenticated;
    set request.jwt.claim.sub='00000000-0000-4000-8000-000000000099';
    insert into public.import_batches(id,platform,file_name)
      values('00000000-0000-4000-8000-000000000098','waca','acl-owner-test.xlsx');
    update public.import_batches set note='acl-ok' where id='00000000-0000-4000-8000-000000000098';
    delete from public.import_batches where id='00000000-0000-4000-8000-000000000098';
    reset role;
  `);
  assert.equal((await partialDb.query("select count(*)::int n from public.import_batches where file_name='acl-owner-test.xlsx'"))
    .rows[0].n, 0);
  console.log('PASS ACL exact matrix and 041/042/043 control-plane definitions preserved');

  await apply(partialDb, repairFiles, 'partial-live-repair-replay');
  assert.equal(fingerprintStructuralSnapshot(await capture(partialDb)), EXPECTED_FINGERPRINT);
  assert.deepEqual((await partialDb.query(`select
    (select count(*)::int from public.import_batches) import_batches,
    (select count(*)::int from public.waca_orders) waca_orders,
    (select count(*)::int from public.waca_import_batches) waca_import_batches,
    (select count(*)::int from public.waca_state) waca_state,
    (select mode from public.waca_state limit 1) mode`)).rows[0], beforeCounts);
  const finalPlan = planSchemaDelta(await capture(partialDb), registry, { expectedSnapshot: canonical });
  assert.equal(finalPlan.readyForApply, true);
  assert.deepEqual(finalPlan.applyPlan, []);
  assert.ok(['018','018b','045','045b','045c','046','046b','047']
    .every(id => finalPlan.migrations.find(item => item.migrationId === id).state === 'SATISFIED'));
  console.log('PASS repair replay is idempotent and final schema converges to canonical fingerprint');

  await apply(driftDb, through044, 'drift-through-044');
  await driftDb.exec(`do $$declare s text; begin
    s:=pg_get_functiondef('public.erp_cloud_restore_audit_dataset(jsonb)'::regprocedure);
    execute replace(s,'jsonb_object_keys(p_data)) <> 15','jsonb_object_keys(p_data)) <> 14');
  end$$;`);
  await assert.rejects(
    driftDb.exec(await read('../supabase/sql/045c_waca_cloud_atomic_restore_semantic_closure.sql')),
    /WACA_045C_UNKNOWN_SEMANTIC_STATE/u,
  );
  await driftDb.exec('rollback;');
  assert.equal((await driftDb.query("select to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is null absent")).rows[0].absent, true);
  assert.equal((await driftDb.query("select not exists(select 1 from pg_trigger where tgrelid='public.import_batches'::regclass and tgname='erp_cloud_restore_maintenance_guard') absent")).rows[0].absent, true);
  console.log('PASS unknown semantic drift fails closed and transaction leaves no partial 045c state');
} finally {
  await canonicalDb.close(); await partialDb.close(); await driftDb.close();
}

console.log(JSON.stringify({ result: 'PASS', engine: 'PGlite PostgreSQL 18',
  canonicalFingerprint: EXPECTED_FINGERPRINT, liveMutation: 0 }));
