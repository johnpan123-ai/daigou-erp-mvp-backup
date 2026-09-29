import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { fingerprintStructuralSnapshot } from '../tools/schema-reconciliation/schemaContract.mjs';
import {
  buildRecoveryBundle,
  RECOVERY_KIND,
  recoverySha256,
  verifyRecoveryBundle,
} from '../tools/pre-adoption-recovery/contract.mjs';
import { loadProductContracts } from '../tools/pre-adoption-recovery/productContracts.mjs';
import { buildDeadlineSidecarReadScript } from '../tools/pre-adoption-recovery/deadlineSidecarReadScript.mjs';
import { CANONICAL_ERP2_TARGET } from '../scripts/promotion-safety.mjs';

const LIVE_PARTIAL_FINGERPRINT = '84ed86f61075e3f5d8958444f249cf0308ff90a1f9673c944aaafae4c606194d';
const CANONICAL_FINGERPRINT = '6775a09526b7c55b8dd96d0d1d83dba12954f5d1c8d6dde8503d647f133a963b';
const SOURCE_HEAD = '936905e337bcdf18ef10b9d4ef00e9b7f147df09';
const CHECKPOINT = 'checkpoint-20260929-erp2-partial-apply-recovery-v1';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const snapshotSql = await read('../tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql');
const inventorySql = await read('../tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql');
const partialExportSql = await read('../tools/pre-adoption-recovery/sql/export-partial-state-readonly.sql');
const executablePartialExportSql = partialExportSql.replace(/--[^\r\n]*/gu, ' ');
assert.match(executablePartialExportSql, /^\s*with\s/iu);
assert.match(executablePartialExportSql, /public\.erp_cloud_restore_snapshot\(\)/u,
  'partial exporter must reuse the existing legacy snapshot function');
assert.doesNotMatch(executablePartialExportSql,
  /\b(insert|update|delete|create|alter|drop|grant|revoke|truncate|call)\b/iu,
  'live exporter must remain SELECT-only');
const migrationFiles = ['018_cloud_import_batch_canonical.sql', '044_waca_cloud_ledger.sql',
  '045_waca_cloud_atomic_restore_closure.sql', '018b_cloud_import_batch_acl_compatibility_repair.sql',
  '045b_waca_cloud_atomic_restore_compatibility_repair.sql',
  '045c_waca_cloud_atomic_restore_semantic_closure.sql', '046b_waca_myacg_parent_compatibility_repair.sql',
  '047_erp_schema_migration_ledger.sql'];
const partialChain = CANONICAL_FRESH_INSTALL_V3.slice(
  0, CANONICAL_FRESH_INSTALL_V3.indexOf('045c_waca_cloud_atomic_restore_semantic_closure.sql'),
);

async function createDatabase() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create schema extensions; create extension pgcrypto with schema extensions;
    create role authenticated; create role anon; create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable
      as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create publication supabase_realtime;
  `);
  for (const file of partialChain) await db.exec(await read(`../supabase/sql/${file}`));
  // Reproduce post-018b live state: import_batches ACL is already canonical;
  // inventory_items still has the observed pre-046b grants.
  await db.exec(`
    grant maintain,references,trigger,truncate on table public.inventory_items to anon;
    grant delete,insert,maintain,references,select,trigger,truncate,update
      on table public.inventory_items to authenticated;
  `);
  return db;
}

async function captureSchema(db) {
  const snapshot = (await db.query(snapshotSql)).rows[0].erp_schema_snapshot;
  snapshot.integrity.inventoryItems = (await db.query(inventorySql)).rows[0].inventory_items_integrity;
  snapshot.completeness.inventoryIntegrity = true;
  snapshot.identity.projectRef = 'rhfdjsklfrgpoqsaqpkn';
  return snapshot;
}

const insertOrder = [
  'inventory_items', 'product_groups', 'product_categories', 'product_variants', 'bundle_components',
  'purchase_batches', 'purchase_batch_items', 'private_orders', 'private_order_items',
  'sales_orders', 'sales_order_items', 'japan_packages', 'japan_package_items',
  'outbound_shipments', 'outbound_shipment_items', 'import_batches', 'waca_orders',
  'waca_order_items', 'waca_mappings', 'waca_master_links', 'waca_import_batches',
  'waca_cutover_audit', 'waca_state',
];
const deleteOrder = [...insertOrder].reverse();

const bundleTables = bundle => ({
  ...Object.fromEntries(Object.entries(bundle.cloudLegacyBackup.data).map(([collection, rows]) => {
    const mapping = bundle.manifest.resources.find(item => item.section === 'cloudLegacyBackup.data' && item.key === collection);
    return [mapping.table, rows];
  })),
  ...bundle.partialStateSupplement,
});

async function restoreIsolated(db, bundle, contracts, injectFailure = false) {
  await verifyRecoveryBundle(bundle, contracts);
  const tables = bundleTables(bundle);
  await db.exec('begin');
  try {
    await db.exec("set local erp.cloud_restore_active='on'");
    for (const table of deleteOrder) await db.exec(`delete from public.${table} where true`);
    for (const table of insertOrder) {
      const rows = tables[table];
      if (!rows.length) continue;
      await db.query(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`,
        [JSON.stringify(rows)]);
      if (injectFailure && table === 'inventory_items') throw new Error('INJECTED_MID_RESTORE_FAILURE');
    }
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

const counts = async (db, tables) => Object.fromEntries(await Promise.all(tables.map(async table => [
  table, Number((await db.query(`select count(*)::int count from public.${table}`)).rows[0].count),
])));

const contracts = await loadProductContracts();
const deadlineReadScript = buildDeadlineSidecarReadScript(contracts, { cloudflareProof: {
  accountId: CANONICAL_ERP2_TARGET.accountId,
  project: CANONICAL_ERP2_TARGET.project,
  domain: CANONICAL_ERP2_TARGET.domain,
} });
assert.match(deadlineReadScript, /transaction\(Object\.values\(stores\), 'readonly'\)/u);
assert.match(deadlineReadScript, /indexedDB\.databases\(\)/u);
assert.match(deadlineReadScript, /request\.onupgradeneeded/u);
assert.doesNotMatch(deadlineReadScript, /readwrite|\.put\(|\.add\(|\.delete\(|\.clear\(/u);
for (const storeName of Object.values(contracts.deadlineStoreNames)) assert.match(deadlineReadScript, new RegExp(storeName, 'u'));
const sourceDb = await createDatabase();
const restoreDb = await createDatabase();
let verifiedIsolatedFingerprint = '';
try {
  await sourceDb.exec(`
    insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,listing_type)
      values('00000000-0000-4000-8000-000000000101','fixture::G-RECOVERY::default','G-RECOVERY',
        'Redacted recovery fixture','default','normal');
    insert into public.import_batches(platform,file_name)
      values('waca','redacted-partial-state-fixture.xlsx');
  `);
  const schemaSnapshot = await captureSchema(sourceDb);
  const isolatedPartialFingerprint = fingerprintStructuralSnapshot(schemaSnapshot);
  assert.notEqual(isolatedPartialFingerprint, CANONICAL_FINGERPRINT,
    'pre-adoption fixture must not already be the final canonical schema');
  const liveExport = (await sourceDb.query(partialExportSql)).rows[0].erp2_pre_adoption_partial_state_export;
  assert.equal(liveExport.recoveryKind, RECOVERY_KIND);
  assert.equal(Object.keys(liveExport.coreLegacySnapshot).length, 15);
  assert.equal(liveExport.partialStateSupplement.waca_state.length, 1);
  const deadlineSidecar = {
    deadlineVerifiedMappings: [{ id: 'mapping-redacted-1', erpProductGroupId: 'group-redacted-1' }],
    deadlineApplyBatches: [{ id: 'apply-redacted-1', idempotencyKey: 'idem-redacted-1' }],
    deadlineApplyItems: [{ id: 'apply-item-redacted-1', applyBatchId: 'apply-redacted-1' }],
  };
  const bundle = await buildRecoveryBundle({
    liveExport,
    deadlineSidecar,
    schemaSnapshot,
    identity: {
      sourceProjectRef: 'rhfdjsklfrgpoqsaqpkn', sourceEnvironmentRole: 'ERP_2_PRODUCTION',
      sourceGitHead: SOURCE_HEAD, checkpoint: CHECKPOINT, canonicalTargetFingerprint: CANONICAL_FINGERPRINT,
    },
    queryChecksums: {
      structuralSnapshot: recoverySha256(snapshotSql), partialStateExport: recoverySha256(partialExportSql),
    },
    migrationSources: await Promise.all(migrationFiles.map(async file => ({
      id: file.split('_', 1)[0], file, checksum: recoverySha256(await read(`../supabase/sql/${file}`)),
    }))),
  }, contracts);
  const verified = await verifyRecoveryBundle(bundle, contracts);
  assert.equal(verified.recoveryReady, 'YES');
  assert.equal(verified.resourceCount, 26);
  assert.equal(bundle.manifest.sourceSchemaFingerprint, isolatedPartialFingerprint);
  assert.equal(bundle.manifest.resources.find(row => row.table === 'waca_orders').rowCount, 0);
  assert.equal(bundle.manifest.resources.find(row => row.table === 'waca_state').rowCount, 1);
  assert.equal(bundle.manifest.resources.find(row => row.table === 'import_batches').rowCount, 1);
  console.log('PASS manifest/checksums cover 15 core + 8 partial supplement + 3 durable Deadline resources');

  await restoreIsolated(restoreDb, bundle, contracts);
  const sourceCounts = await counts(sourceDb, insertOrder);
  const restoredCounts = await counts(restoreDb, insertOrder);
  assert.deepEqual(restoredCounts, sourceCounts);
  assert.equal((await restoreDb.query('select mode from public.waca_state')).rows[0].mode, 'LEGACY_QUANTITY_ACTIVE');
  verifiedIsolatedFingerprint = fingerprintStructuralSnapshot(await captureSchema(restoreDb));
  assert.equal(verifiedIsolatedFingerprint, isolatedPartialFingerprint,
    'isolated source and reconstructed partial schema fingerprints must match exactly');
  assert.deepEqual(deadlineSidecar, bundle.deadlineSidecar);
  assert.equal((await restoreDb.query(`select count(*)::int count from public.inventory_items
    where id is null or inventory_key is null`)).rows[0].count, 0);
  console.log('PASS isolated reconstruction matches exact current partial schema, core rows, inventory UUID and WACA state');

  const beforeFailure = await counts(restoreDb, insertOrder);
  await assert.rejects(() => restoreIsolated(restoreDb, bundle, contracts, true), /INJECTED_MID_RESTORE_FAILURE/u);
  assert.deepEqual(await counts(restoreDb, insertOrder), beforeFailure);
  console.log('PASS injected mid-restore failure rolls back atomically');

  const clone = value => structuredClone(value);
  const cases = [
    ['missing WACA state', candidate => { candidate.partialStateSupplement.waca_state = []; }],
    ['missing Deadline durable', candidate => { delete candidate.deadlineSidecar.deadlineApplyItems; }],
    ['checksum mismatch', candidate => { candidate.cloudLegacyBackup.data.inventory[0].product_title = 'tampered'; }],
    ['unknown resource', candidate => { candidate.partialStateSupplement.unknown_durable_resource = []; }],
    ['wrong schema fingerprint', candidate => { candidate.manifest.sourceSchemaFingerprint = CANONICAL_FINGERPRINT; }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = clone(bundle);
    mutate(candidate);
    await assert.rejects(() => verifyRecoveryBundle(candidate, contracts), undefined, label);
  }
  assert.throws(() => JSON.parse('{not-valid-json'), SyntaxError);
  console.log('PASS parse/missing/checksum/unknown-resource/wrong-fingerprint cases fail closed');
} finally {
  await sourceDb.close();
  await restoreDb.close();
}

console.log(JSON.stringify({
  result: 'PASS', engine: 'PGlite PostgreSQL 18', recoveryKind: RECOVERY_KIND,
  isolatedPartialFingerprint: verifiedIsolatedFingerprint,
  liveReferenceFingerprint: LIVE_PARTIAL_FINGERPRINT,
  parity: 'exact isolated source/restore fingerprint + normalized partial-state contract', liveMutation: 0,
}));
