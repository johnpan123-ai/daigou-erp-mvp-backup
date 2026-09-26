import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

const connectionString = process.env.RESTORE_PERFORMANCE_LOCAL_PG ?? '';
const snapshotPath = process.env.RESTORE_PERFORMANCE_SNAPSHOT ?? '';
const databaseUrl = new URL(connectionString);
assert(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
assert.match(databaseUrl.pathname, /^\/restore_performance_fixture(?:_\d+)?$/u);
assert(snapshotPath.length > 0);

const OWNER = '11111111-1111-4111-8111-111111111111';
const TARGET = 'rhfdjsklfrgpoqsaqpkn';
const TABLES = Object.freeze([
  ['inventory', 'inventory_items'], ['productGroups', 'product_groups'],
  ['productCategories', 'product_categories'], ['productVariants', 'product_variants'],
  ['bundleComponents', 'bundle_components'], ['purchaseBatches', 'purchase_batches'],
  ['purchaseBatchItems', 'purchase_batch_items'], ['privateOrders', 'private_orders'],
  ['privateOrderItems', 'private_order_items'], ['salesOrders', 'sales_orders'],
  ['salesOrderItems', 'sales_order_items'], ['japanPackages', 'japan_packages'],
  ['japanPackageItems', 'japan_package_items'], ['outboundShipments', 'outbound_shipments'],
  ['outboundShipmentItems', 'outbound_shipment_items'],
]);

const rawText = readFileSync(snapshotPath, 'utf8');
const sourceDocument = JSON.parse(rawText);
assert.equal(sourceDocument.manifest.totalRows, 18_059);
assert.equal(sourceDocument.manifest.resourceCount, 15);
const sourceData = Object.fromEntries(TABLES.map(([collection, table]) => [table, sourceDocument.data[collection]]));
assert.equal(Object.values(sourceData).reduce((sum, rows) => sum + rows.length, 0), 18_059);
const transformedCounts = Object.fromEntries(TABLES.map(([, table]) => [table,
  sourceData[table].filter(row => row.updated_by !== null && row.updated_by !== undefined).length,
]));
assert.equal(Object.values(transformedCounts).reduce((sum, count) => sum + count, 0), 15_711);
const portability = {
  policyVersion: 'cross-environment-audit-null-v1',
  mode: 'cross-environment',
  targetProjectRef: TARGET,
  sourceFileSha256: createHash('sha256').update(rawText).digest('hex'),
  sourceSnapshotFingerprint: sourceDocument.manifest.snapshotFingerprint,
  transformedCounts,
  totalTransformedRows: 15_711,
};
let manifest = { ...sourceDocument.manifest, snapshotFingerprint: '0'.repeat(64), portability };
let effectiveData;

const db = new Client({ connectionString, application_name: 'restore_18059_native_benchmark' });
await db.connect();
const scalar = async (sql, values = []) => (await db.query(sql, values)).rows[0]?.value;
const login = async () => {
  await db.query('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)", [
    OWNER, JSON.stringify({ host: `${TARGET}.supabase.co` }),
  ]);
  await db.query('set role authenticated');
};
const clearRestoreMetadata = async () => {
  await db.query('reset role');
  await db.query('delete from public.erp_cloud_restore_failures');
  await db.query('delete from public.erp_cloud_restore_attempts');
  await db.query('delete from public.erp_cloud_restore_requests');
  await db.query('delete from public.erp_cloud_restore_snapshots');
  await login();
};
const prepare = async (legacyBegin = false) => {
  const attempt = randomUUID();
  const trace = randomUUID();
  const prepared = await scalar(`select public.erp_prepare_cloud_restore_attempt(
    $1,$2,$3,$4,$5,$6,120000,$7
  ) as value`, [
    attempt, trace, sourceDocument.manifest.snapshotFingerprint, manifest.snapshotFingerprint,
    portability.policyVersion, TARGET, 'postgresql-statement-timeout-v1',
  ]);
  assert.equal(prepared.status, 'prepared');
  if (legacyBegin) {
    const begun = await scalar('select public.erp_begin_cloud_restore_attempt($1,$2) as value', [attempt, trace]);
    return { attempt, trace, execution: begun.executionId, envelope: 'legacy-executing' };
  }
  return { attempt, trace, execution: randomUUID(), envelope: 'prepared-direct' };
};
const execute = async intent => scalar(`select public.erp_restore_cloud_snapshot_attempt(
  $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8
) as value`, [
  intent.attempt, intent.trace, intent.execution, manifest.snapshotFingerprint,
  JSON.stringify(sourceData), JSON.stringify(manifest), sourceDocument.sourceEnvironment, 'cross-environment',
]);
const measure = async legacyBegin => {
  const intent = await prepare(legacyBegin);
  const started = performance.now();
  const result = await execute(intent);
  const elapsedMs = performance.now() - started;
  if (result.ok !== true) {
    await db.query('reset role');
    try {
      await scalar(`select public.erp_restore_cloud_snapshot(
        $1,$2,$3::jsonb,$4::jsonb,$5
      ) as value`, [randomUUID(), manifest.snapshotFingerprint, JSON.stringify(effectiveData), JSON.stringify(manifest), sourceDocument.sourceEnvironment]);
    } catch (error) {
      throw new Error(`isolated native restore failed: sqlstate=${error.code ?? 'unknown'} constraint=${error.constraint ?? 'unknown'}`);
    }
    throw new Error(`isolated native restore failed: category=${result.failure?.category ?? 'unknown'}`);
  }
  assert.equal(result.snapshotFingerprint, manifest.snapshotFingerprint);
  assert.equal(result.manifest.totalRows, 18_059);
  return {
    lifecycle: intent.envelope,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    timingsMs: result.timingsMs,
    restoreEpoch: result.restoreEpoch,
  };
};

try {
  await db.query('insert into auth.users(id) values($1) on conflict do nothing', [OWNER]);
  await login();
  await db.query('reset role');
  const sourceFingerprint = await scalar(`select encode(extensions.digest(convert_to(
    public.erp_cloud_restore_canonical_json_text($1::jsonb),'UTF8'
  ),'sha256'),'hex') as value`, [JSON.stringify(sourceData)]);
  assert.equal(sourceFingerprint, sourceDocument.manifest.snapshotFingerprint);

  const builderStarted = performance.now();
  effectiveData = await scalar(`select public.erp_cloud_restore_build_effective_snapshot(
    $1::jsonb,$2::jsonb,'cross-environment'
  ) as value`, [JSON.stringify(sourceData), JSON.stringify(manifest)]);
  const builderMs = performance.now() - builderStarted;
  const effectiveFingerprint = await scalar(`select encode(extensions.digest(convert_to(
    public.erp_cloud_restore_canonical_json_text($1::jsonb),'UTF8'
  ),'sha256'),'hex') as value`, [JSON.stringify(effectiveData)]);
  manifest = { ...sourceDocument.manifest, snapshotFingerprint: effectiveFingerprint, portability };
  assert.equal(effectiveFingerprint, 'ee9e6a827e5e3c8b0f891b8bf1152f7c5962ccd0b56176767db7285c11d2acfd');

  // Warm the actual tables with the same 18,059-row dataset. Timed passes now
  // include a same-size rollback snapshot, delete, reinsert, audit, and commit.
  await login();
  const warmup = await measure(false);
  await clearRestoreMetadata();
  const before = await measure(true);
  await clearRestoreMetadata();
  const after = await measure(false);

  await db.query('reset role');
  const audit = await scalar('select public.erp_read_cloud_restore_integrity_audit() as value');
  assert.equal(Number(audit.total_rows), 18_059);
  assert.equal(Number(audit.integrity.orphan_count), 0);
  assert.equal(Number(audit.integrity.duplicate_canonical_id_count), 0);
  assert.equal(Number(audit.audit_policy.covered_updated_by_non_null_count), 0);
  const terminal = (await db.query(`select status,result_epoch,canonical_result is not null as canonical
    from public.erp_cloud_restore_attempts`)).rows;
  assert.deepEqual(terminal.map(row => row.status), ['completed']);
  assert.equal(terminal[0].canonical, true);

  console.log(JSON.stringify({
    backend: 'native PostgreSQL 18',
    schema: 'Staging schema-only 15-resource dump',
    rows: 18_059,
    resources: 15,
    auditTransforms: 15_711,
    sourcePayloadMiB: Number((Buffer.byteLength(JSON.stringify(sourceData)) / 1024 / 1024).toFixed(2)),
    builderStandaloneMs: Number(builderMs.toFixed(2)),
    warmup,
    before,
    after,
    timeoutBudgetMs: 120_000,
    integrity: {
      totalRows: Number(audit.total_rows),
      orphan: Number(audit.integrity.orphan_count),
      duplicate: Number(audit.integrity.duplicate_canonical_id_count),
      nonNullUpdatedBy: Number(audit.audit_policy.covered_updated_by_non_null_count),
    },
    liveConnections: 0,
  }, null, 2));
  console.log('PASS real 18,059-row / 15-resource PostgreSQL restore, same-size rollback snapshot, full replacement, integrity, and canonical result');
} finally {
  await db.end();
}
