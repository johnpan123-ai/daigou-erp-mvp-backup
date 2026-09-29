import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { fingerprintStructuralSnapshot } from '../tools/schema-reconciliation/schemaContract.mjs';
import { CANONICAL_RESTORE_RESOURCES, classifyRestoreFunctionState, CORE_RESTORE_RESOURCES,
  RESTORE_FUNCTION_STATES } from '../tools/schema-reconciliation/restoreFunctionState.mjs';

const EXPECTED_FINGERPRINT = '6775a09526b7c55b8dd96d0d1d83dba12954f5d1c8d6dde8503d647f133a963b';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const snapshotSql = await read('../tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql');
const inventorySql = await read('../tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql');
const closureSql = await read('../supabase/sql/045c_waca_cloud_atomic_restore_semantic_closure.sql');
assert.doesNotMatch(closureSql, /execute\s+replace\s*\(\s*(?:v_|pg_get_functiondef)/iu,
  '045c must install complete definitions instead of patching catalog source text');

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

const invariantFacts = Object.fromEntries([
  'proofFlow', 'prepareFlow', 'executeFlow', 'failurePersistence', 'reconciliation',
  'rollback', 'requestProofIds', 'signatureContract', 'securityMode', 'searchPath',
  'acl', 'transactionBoundary', 'smallExecuteEnvelope',
].map(key => [key, true]));
const facts = patch => ({ controlPlane: true, surfaceMetadata: true, invariants: invariantFacts,
  auditCoreAccepted: true, auditFullAccepted: false, snapshotKeys: CORE_RESTORE_RESOURCES,
  validator: false, recompute: false, importGuard: false, ...patch });
assert.equal(classifyRestoreFunctionState(facts({})), RESTORE_FUNCTION_STATES.PRE_045);
assert.equal(classifyRestoreFunctionState(facts({ auditCoreAccepted: false, auditFullAccepted: true,
  validator: true, recompute: true })), RESTORE_FUNCTION_STATES.ORIGINAL_045_PARTIAL);
assert.equal(classifyRestoreFunctionState(facts({ auditCoreAccepted: false, auditFullAccepted: true,
  snapshotKeys: CANONICAL_RESTORE_RESOURCES, validator: true, recompute: true })),
RESTORE_FUNCTION_STATES.REPAIR_045B_COMPATIBLE);
assert.equal(classifyRestoreFunctionState(facts({ auditCoreAccepted: false, auditFullAccepted: true,
  snapshotKeys: CANONICAL_RESTORE_RESOURCES, validator: true, recompute: true, importGuard: true })),
RESTORE_FUNCTION_STATES.CANONICAL);
assert.equal(classifyRestoreFunctionState(facts({ snapshotKeys: CORE_RESTORE_RESOURCES.slice(1) })),
RESTORE_FUNCTION_STATES.CONFLICT);
console.log('PASS machine-readable Restore state detector covers A/B/C/D and fails closed on E');

const historicalCanonicalDb = await createDatabase();
const liveLikeDb = await createDatabase();
const formattingDb = await createDatabase();
const driftDb = await createDatabase();
const ledgerFailureDb = await createDatabase();
try {
  await apply(historicalCanonicalDb, CANONICAL_FRESH_INSTALL_V3, 'historical-canonical');
  const historicalCanonical = await capture(historicalCanonicalDb);
  assert.equal(fingerprintStructuralSnapshot(historicalCanonical), EXPECTED_FINGERPRINT);

  const through044 = CANONICAL_FRESH_INSTALL_V3.slice(
    0, CANONICAL_FRESH_INSTALL_V3.indexOf('045c_waca_cloud_atomic_restore_semantic_closure.sql'),
  );
  await apply(formattingDb, through044, 'formatting-variant-through-044');
  const formattedDefinition = (await formattingDb.query(
    "select pg_get_functiondef('public.erp_cloud_restore_snapshot()'::regprocedure) definition",
  )).rows[0].definition.replace('select jsonb_build_object(',
    'select /* equivalent formatting variant */\n    jsonb_build_object(');
  await formattingDb.exec(formattedDefinition);
  await formattingDb.exec(closureSql);
  await apply(formattingDb, [
    '046_waca_myacg_parent_evidence.sql',
    '046b_waca_myacg_parent_compatibility_repair.sql',
    '047_erp_schema_migration_ledger.sql',
  ], 'formatting-variant-tail');
  assert.equal(fingerprintStructuralSnapshot(await capture(formattingDb)), EXPECTED_FINGERPRINT);
  console.log('PASS two formatting variants with identical semantics converge through 045c');

  await apply(driftDb, through044, 'semantic-drift-through-044');
  await driftDb.exec(`do $$declare s text;begin
    s:=pg_get_functiondef('public.erp_cloud_restore_audit_dataset(jsonb)'::regprocedure);
    execute replace(s,'jsonb_object_keys(p_data)) <> 15','jsonb_object_keys(p_data)) <> 14');
  end$$`);
  const driftBefore = await capture(driftDb);
  await assert.rejects(driftDb.exec(closureSql), /WACA_045C_UNKNOWN_SEMANTIC_STATE/u);
  await driftDb.exec('rollback');
  assert.equal(toBoolean((await driftDb.query(`select
    to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is null absent`)).rows[0].absent), true);
  assert.equal(fingerprintStructuralSnapshot(await capture(driftDb)), fingerprintStructuralSnapshot(driftBefore));
  console.log('PASS semantic-changing variant fails closed without partial 045c state');

  await apply(liveLikeDb, through044, 'post-018b-live-like');
  await liveLikeDb.exec(`
    grant maintain,references,trigger,truncate on table public.inventory_items to anon;
    grant delete,insert,maintain,references,select,trigger,truncate,update
      on table public.inventory_items to authenticated;
  `);
  assert.equal(toBoolean((await liveLikeDb.query(`select
    to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is null absent`)).rows[0].absent), true);
  await liveLikeDb.exec(closureSql);
  const restoreSignatures = [
    'public.erp_cloud_restore_snapshot()',
    'public.erp_cloud_restore_audit_dataset(jsonb)',
    'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
    'public.erp_cloud_restore_validate_waca_dataset(jsonb)',
    'public.erp_cloud_restore_recompute_waca_quantities()',
  ];
  const afterClosure = await capture(liveLikeDb);
  for (const signature of restoreSignatures) {
    assert.deepEqual(afterClosure.functions[signature], historicalCanonical.functions[signature], signature);
  }
  await apply(liveLikeDb, [
    '046b_waca_myacg_parent_compatibility_repair.sql',
    '047_erp_schema_migration_ledger.sql',
  ], 'remaining-delta');
  assert.equal(fingerprintStructuralSnapshot(await capture(liveLikeDb)), EXPECTED_FINGERPRINT);
  await liveLikeDb.exec(closureSql);
  assert.equal(fingerprintStructuralSnapshot(await capture(liveLikeDb)), EXPECTED_FINGERPRINT);
  console.log('PASS post-018b live-like fixture -> 045c -> canonical fingerprint; replay is no-op');

  await apply(ledgerFailureDb, through044, 'ledger-failure-through-044');
  await ledgerFailureDb.exec(`
    grant maintain,references,trigger,truncate on table public.inventory_items to anon;
    grant delete,insert,maintain,references,select,trigger,truncate,update
      on table public.inventory_items to authenticated;
  `);
  await ledgerFailureDb.exec(closureSql);
  await apply(ledgerFailureDb, ['046b_waca_myacg_parent_compatibility_repair.sql'],
    'ledger-failure-through-046b');
  await ledgerFailureDb.exec('create table public.erp_schema_migration_ledger(id text)');
  await assert.rejects(
    apply(ledgerFailureDb, ['047_erp_schema_migration_ledger.sql'], 'ledger-failure-injection'),
  );
  await ledgerFailureDb.exec('rollback');
  const ledgerColumns = (await ledgerFailureDb.query(`select column_name from information_schema.columns
    where table_schema='public' and table_name='erp_schema_migration_ledger' order by ordinal_position`))
    .rows.map(row => row.column_name);
  assert.deepEqual(ledgerColumns, ['id']);
  assert.equal(toBoolean((await ledgerFailureDb.query(`select
    to_regprocedure('public.erp_schema_migration_ledger_record(text,text,text,text,jsonb)') is null absent`))
    .rows[0].absent), true);
  console.log('PASS 047 conflict injection rolls back without partial ledger contract');
} finally {
  await historicalCanonicalDb.close();
  await liveLikeDb.close();
  await formattingDb.close();
  await driftDb.close();
  await ledgerFailureDb.close();
}

function toBoolean(value) { return value === true || value === 't'; }

console.log(JSON.stringify({ result: 'PASS', engine: 'PGlite PostgreSQL 18',
  canonicalFingerprint: EXPECTED_FINGERPRINT, liveMutation: 0 }));
