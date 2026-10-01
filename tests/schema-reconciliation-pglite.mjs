import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { detectInventoryBridgeState, planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { fingerprintStructuralSnapshot, fingerprintStructuralSnapshotV2 } from '../tools/schema-reconciliation/schemaContract.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const snapshotSql = await read('../tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql');
const inventorySql = await read('../tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql');
const saveabilityFiles = CANONICAL_FRESH_INSTALL_V3.slice(-3);
const v4Fingerprint = 'bc0cb320bb57dce141b7ce9c24990097f35ce739e441c7835fbe20ca5b64d317';
const v5Fingerprint = JSON.parse(await read('../config/erp-environment-identity.json')).schemaBaseline.canonicalFingerprint;
const partialPlans = [];

async function createDatabase() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create role authenticated;
    create role anon;
    create schema auth;
    create schema storage;
    create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
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
  const structural = (await db.query(snapshotSql)).rows[0].erp_schema_snapshot;
  structural.integrity.inventoryItems = (await db.query(inventorySql)).rows[0].inventory_items_integrity;
  structural.completeness.inventoryIntegrity = true;
  structural.identity.projectRef = 'rhfdjsklfrgpoqsaqpkn';
  return structural;
}

const fresh = await createDatabase();
const upgraded = await createDatabase();
const partialBridge = await createDatabase();
const compatibility = await createDatabase();
try {
  assert.deepEqual(saveabilityFiles.map(file => file.slice(0, 3)), ['049', '050', '051']);
  await apply(fresh, CANONICAL_FRESH_INSTALL_V3.slice(0, -3), 'fresh-v4');
  const freshV4Snapshot = await capture(fresh);
  assert.equal(fingerprintStructuralSnapshotV2(freshV4Snapshot), v4Fingerprint);
  await apply(fresh, saveabilityFiles, 'fresh-v5');
  const freshSnapshot = await capture(fresh);
  assert.equal(fingerprintStructuralSnapshot(freshSnapshot), v5Fingerprint);
  assert.equal(fingerprintStructuralSnapshotV2(freshSnapshot), '0bdcd2b4e65219107e4f815abecb8e54fc69886ac90bc5ccbb608e31243755ef');
  const bridgeIndex = CANONICAL_FRESH_INSTALL_V3.indexOf('026b_cloud_inventory_uuid_identity_bridge.sql');
  const wacaStart = CANONICAL_FRESH_INSTALL_V3.indexOf('044_waca_cloud_ledger.sql');
  await apply(upgraded, CANONICAL_FRESH_INSTALL_V3.slice(0, bridgeIndex), 'pre-bridge');
  const preBridgeSnapshot = await capture(upgraded);
  assert.deepEqual(detectInventoryBridgeState(preBridgeSnapshot), {
    state: 'STATE_A', safeToApply: true, reason: 'legacy identity and data preconditions pass',
  });
  await apply(upgraded, ['026b_cloud_inventory_uuid_identity_bridge.sql'], 'bridge');
  assert.equal(detectInventoryBridgeState(await capture(upgraded)).state, 'STATE_C');
  await apply(upgraded, CANONICAL_FRESH_INSTALL_V3.slice(bridgeIndex + 1, wacaStart), 'through-043');
  const preWacaSnapshot = await capture(upgraded);
  const preWacaPlan = planSchemaDelta(preWacaSnapshot, await buildMigrationEffectRegistry(), { expectedSnapshot: freshSnapshot });
  assert.ok(['041','042','043'].every(id => preWacaPlan.migrations.find(item => item.migrationId === id).state === 'SATISFIED'));
  assert.equal(preWacaPlan.migrations.find(item => item.migrationId === '044').state, 'NEEDS_APPLY');
  assert.ok(preWacaPlan.migrations.every(item => item.historicalExecution === 'UNPROVEN'));
  const beforeBridgeReplay = fingerprintStructuralSnapshot(preWacaSnapshot);
  await apply(upgraded, ['026b_cloud_inventory_uuid_identity_bridge.sql'], 'bridge-replay');
  assert.equal(fingerprintStructuralSnapshot(await capture(upgraded)), beforeBridgeReplay);
  await apply(upgraded, CANONICAL_FRESH_INSTALL_V3.slice(wacaStart), 'upgrade-tail');

  await apply(partialBridge, CANONICAL_FRESH_INSTALL_V3.slice(0, bridgeIndex), 'partial-base');
  await partialBridge.exec('alter table public.inventory_items add column id uuid not null default extensions.gen_random_uuid();');
  assert.equal(detectInventoryBridgeState(await capture(partialBridge)).state, 'STATE_B');
  console.log('PASS isolated fixtures cover pre-026b, post-026b, partial-026b, 043/no-ledger, and WACA-absent');

  const upgradedSnapshot = await capture(upgraded);
  assert.equal(fingerprintStructuralSnapshot(freshSnapshot), fingerprintStructuralSnapshot(upgradedSnapshot));
  console.log('PASS fresh target fingerprint = reconciled upgrade target fingerprint');

  const registry = await buildMigrationEffectRegistry();
  const plan = planSchemaDelta(freshSnapshot, registry, { expectedSnapshot: upgradedSnapshot,
    requiredBaselineId: 'erp2-canonical-schema-v5-saveability' });
  const failed = plan.migrations.filter(item => item.state !== 'SATISFIED');
  assert.deepEqual(failed.map(item => ({ id: item.migrationId, state: item.state,
    failed: item.postconditions.filter(check => check.result !== 'MATCH').map(check => check.condition.object) })), []);
  assert.equal(plan.readyForApply, true);
  assert.ok(plan.migrations.every(item => item.historicalExecution === 'UNPROVEN'));
  console.log('PASS actual PostgreSQL-equivalent catalog satisfies migration effect registry');

  const original046Index = CANONICAL_FRESH_INSTALL_V3.indexOf('046_waca_myacg_parent_evidence.sql');
  const repair046Index = CANONICAL_FRESH_INSTALL_V3.indexOf('046b_waca_myacg_parent_compatibility_repair.sql');
  assert.equal(repair046Index, original046Index + 1);
  await apply(compatibility, CANONICAL_FRESH_INSTALL_V3.slice(0, original046Index), 'live-like-through-045');
  await compatibility.exec(`
    grant maintain,references,trigger,truncate on table public.inventory_items to anon;
    grant delete,insert,maintain,references,select,trigger,truncate,update
      on table public.inventory_items to authenticated;
  `);
  const liveLikeBefore = await capture(compatibility);
  const beforePlan = planSchemaDelta(liveLikeBefore, registry, { expectedSnapshot: freshSnapshot });
  assert.equal(beforePlan.migrations.find(item => item.migrationId === '046').state, 'CONFLICT');
  assert.equal(beforePlan.migrations.find(item => item.migrationId === '046').coveredByRepair, '046b');
  assert.equal(beforePlan.migrations.find(item => item.migrationId === '046b').safeToApply, true);
  assert.equal(beforePlan.migrations.find(item => item.migrationId === '047').dependencyBlocker, undefined);
  await apply(compatibility, ['046b_waca_myacg_parent_compatibility_repair.sql'], 'live-like-repair');
  const once = fingerprintStructuralSnapshot(await capture(compatibility));
  await apply(compatibility, ['046b_waca_myacg_parent_compatibility_repair.sql'], 'live-like-repair-replay');
  assert.equal(fingerprintStructuralSnapshot(await capture(compatibility)), once);
  await apply(compatibility, [
    '047_erp_schema_migration_ledger.sql',
    '048_erp2_live_canonical_contract_reconciliation.sql',
  ], 'live-like-ledger-and-contract');
  const repairedSnapshot = await capture(compatibility);
  assert.equal(fingerprintStructuralSnapshotV2(repairedSnapshot), v4Fingerprint);
  assert.equal(fingerprintStructuralSnapshot(repairedSnapshot), fingerprintStructuralSnapshot(freshV4Snapshot));
  const repairedPlan = planSchemaDelta(repairedSnapshot, registry, { expectedSnapshot: freshSnapshot });
  assert.ok(['046','046b','047','048'].every(id => repairedPlan.migrations.find(item => item.migrationId === id).state === 'SATISFIED'));
  assert.equal(repairedPlan.readyForApply, true);
  assert.deepEqual(repairedPlan.applyPlan.map(item => item.migrationId), ['049', '050', '051']);
  console.log('PASS fresh and repaired live-like 048 preserve the independent v4 baseline fingerprint');

  for (const [index, file] of saveabilityFiles.entries()) {
    await apply(compatibility, [file], 'v4-to-v5');
    const stage = await capture(compatibility);
    const stagePlan = planSchemaDelta(stage, registry, { expectedSnapshot: freshSnapshot });
    const remaining = saveabilityFiles.slice(index + 1).map(entry => entry.slice(0, 3));
    assert.equal(stagePlan.readyForApply, true);
    assert.equal(stagePlan.blockers.length, 0);
    assert.deepEqual(stagePlan.applyPlan.map(item => item.migrationId), remaining);
    partialPlans.push({ applied: file.slice(0, 3), remaining });
  }
  const finalSnapshot = await capture(compatibility);
  assert.equal(fingerprintStructuralSnapshot(finalSnapshot), v5Fingerprint);
  assert.deepEqual(Object.keys(finalSnapshot.tables).sort(), Object.keys(repairedSnapshot.tables).sort());
  await apply(compatibility, saveabilityFiles, 'v5-replay');
  assert.equal(fingerprintStructuralSnapshot(await capture(compatibility)), v5Fingerprint);

  const partialV5 = structuredClone(finalSnapshot);
  delete partialV5.functions['public.erp_reconcile_private_order_transaction(uuid, jsonb)'];
  // Catalog capture uses PostgreSQL's canonical regprocedure signature spacing.
  for (const key of Object.keys(partialV5.functions)) {
    if (key.startsWith('public.erp_reconcile_private_order_transaction(')) delete partialV5.functions[key];
  }
  const partialV5Plan = planSchemaDelta(partialV5, registry, { expectedSnapshot: freshSnapshot });
  assert.equal(partialV5Plan.migrations.find(item => item.migrationId === '049').state, 'PARTIAL');
  assert.equal(partialV5Plan.readyForApply, false);
  const unknownV5 = structuredClone(finalSnapshot);
  unknownV5.completeness.functions = false;
  const unknownV5Plan = planSchemaDelta(unknownV5, registry, { expectedSnapshot: freshSnapshot });
  assert.equal(unknownV5Plan.readyForApply, false);
  assert.ok(unknownV5Plan.migrations.some(item => item.state === 'UNKNOWN'));
  console.log('PASS v4→049→050→051 partial planners, final v5, reapply, and UNKNOWN/PARTIAL fail-closed');

  const owner = '00000000-0000-4000-8000-000000000099';
  await fresh.exec(`insert into auth.users(id,email) values('${owner}','owner@example.com');
    update public.profiles set role='owner' where user_id='${owner}';
    set role authenticated; set request.jwt.claim.sub='${owner}';`);
  const metadata = JSON.stringify({ historicalMigrationExecutionClaimed: false,
    classification: 'ENVIRONMENT_LOCAL_NON_PORTABLE_OPS_METADATA' });
  const args = ['BASELINE_ADOPTED','erp2-canonical-schema-v5-saveability','a'.repeat(64),'c'.repeat(40),
    'checkpoint-fixture','b'.repeat(64),'b'.repeat(64),'PRODUCTION','rhfdjsklfrgpoqsaqpkn','PASS',metadata];
  const placeholders = args.map((_, index) => index === args.length - 1
    ? `$${index + 1}::jsonb` : `$${index + 1}`).join(',');
  const recorded = await fresh.query(`select public.erp_record_schema_migration_event(${placeholders}) result`, args);
  assert.equal(recorded.rows[0].result.eventType, 'BASELINE_ADOPTED');
  await fresh.exec('reset role;');
  const businessSnapshot = (await fresh.query('select public.erp_cloud_restore_snapshot() snapshot')).rows[0].snapshot;
  assert.equal(Object.keys(businessSnapshot).length, 24);
  assert.equal(Object.hasOwn(businessSnapshot, 'erp_schema_migration_ledger'), false);
  console.log('PASS baseline ledger is owner-only operational metadata outside 24-resource Restore');
} finally {
  await fresh.close(); await upgraded.close(); await partialBridge.close(); await compatibility.close();
}

console.log(JSON.stringify({ result: 'PASS', engine: 'PGlite PostgreSQL 18',
  v4Fingerprint, v5Fingerprint, partialPlans, reapply: true, unknownPartialFailClosed: true,
  liveMutation: 0 }));
