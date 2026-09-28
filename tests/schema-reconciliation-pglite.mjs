import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { detectInventoryBridgeState, planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { fingerprintStructuralSnapshot } from '../tools/schema-reconciliation/schemaContract.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const snapshotSql = await read('../tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql');
const inventorySql = await read('../tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql');

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
try {
  await apply(fresh, CANONICAL_FRESH_INSTALL_V3, 'fresh');
  const freshSnapshot = await capture(fresh);
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
    requiredBaselineId: 'erp2-canonical-schema-v4' });
  const failed = plan.migrations.filter(item => item.state !== 'SATISFIED');
  assert.deepEqual(failed.map(item => ({ id: item.migrationId, state: item.state,
    failed: item.postconditions.filter(check => check.result !== 'MATCH').map(check => check.condition.object) })), []);
  assert.equal(plan.readyForApply, true);
  assert.ok(plan.migrations.every(item => item.historicalExecution === 'UNPROVEN'));
  console.log('PASS actual PostgreSQL-equivalent catalog satisfies migration effect registry');

  const owner = '00000000-0000-4000-8000-000000000099';
  await fresh.exec(`insert into auth.users(id,email) values('${owner}','owner@example.com');
    update public.profiles set role='owner' where user_id='${owner}';
    set role authenticated; set request.jwt.claim.sub='${owner}';`);
  const metadata = JSON.stringify({ historicalMigrationExecutionClaimed: false,
    classification: 'ENVIRONMENT_LOCAL_NON_PORTABLE_OPS_METADATA' });
  const args = ['BASELINE_ADOPTED','erp2-canonical-schema-v4','a'.repeat(64),'c'.repeat(40),
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
  await fresh.close(); await upgraded.close(); await partialBridge.close();
}

console.log(JSON.stringify({ result: 'PASS', engine: 'PGlite PostgreSQL 18', liveMutation: 0 }));
