import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const SQL_036 = readFileSync(new URL('../supabase/sql/036_cloud_restore_final_closure.sql', import.meta.url), 'utf8');
const SQL_037 = readFileSync(new URL('../supabase/sql/037_cloud_restore_row_shape_fix.sql', import.meta.url), 'utf8');
const PROVIDER = readFileSync(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
const SNAPSHOT_PATH = process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT
  || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-20-114903.json';
const EXPECTED_MAPPING = [
  ['inventory', 'inventory_items'],
  ['productGroups', 'product_groups'],
  ['productCategories', 'product_categories'],
  ['productVariants', 'product_variants'],
  ['bundleComponents', 'bundle_components'],
  ['purchaseBatches', 'purchase_batches'],
  ['purchaseBatchItems', 'purchase_batch_items'],
  ['privateOrders', 'private_orders'],
  ['privateOrderItems', 'private_order_items'],
  ['salesOrders', 'sales_orders'],
  ['salesOrderItems', 'sales_order_items'],
  ['japanPackages', 'japan_packages'],
  ['japanPackageItems', 'japan_package_items'],
  ['outboundShipments', 'outbound_shipments'],
  ['outboundShipmentItems', 'outbound_shipment_items'],
];

const isJsonObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const assertObjectRows = (data, names) => {
  for (const name of names) {
    assert(Array.isArray(data[name]), `${name} must remain an array`);
    data[name].forEach((row, index) => assert(isJsonObject(row), `${name}[${index}] must remain an object`));
  }
};

const serverRowShapeModel = rows => rows.map((row, index) => {
  if (!isJsonObject(row)) throw new Error(`CLOUD_RESTORE_PORTABILITY_ROW_INVALID:fixture:${index}`);
  return { ...row, updated_by: null };
});

const hasIdentifierQuotedStrposNeedle = sql => /strpos\([^,]+,\s*"/u.test(sql);
const broken037Predicate = `strpos(v_builder_definition, "whenjsonb_typeof(row_value)='object'thentrue") = 0`;
const assert037FailClosedGuards = sql => {
  assert.match(sql, /v_helper\.pronargs <> 1/u, 'signature drift must remain fail closed');
  assert.match(sql, /CLOUD_RESTORE_ROW_SHAPE_DEFINITION_BASE_MISMATCH/u, 'definition drift must remain fail closed');
  assert.match(sql, /has_function_privilege\('authenticated', v_helper_oid, 'EXECUTE'\)/u, 'ACL drift must remain fail closed');
  assert.match(sql, /CLOUD_RESTORE_ROW_SHAPE_OVERLOAD_COLLISION/u, 'overload drift must remain fail closed');
  assert.match(sql, /v_helper\.provolatile <> 'v'/u, 'postflight must require VOLATILE');
};

assert.equal((SQL_037.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL_037.match(/^commit;$/gimu) || []).length, 1);
assert.equal((SQL_037.match(/alter function public\.erp_cloud_restore_reject_invalid_portable_row\(text\) volatile;/gu) || []).length, 1);
assert.match(SQL_037, /v_helper\.provolatile <> 'i'/u, 'Preflight must pin the failing 036 IMMUTABLE state');
assert.match(SQL_037, /v_helper\.provolatile <> 'v'/u, 'Postflight must prove VOLATILE');
assert.equal(hasIdentifierQuotedStrposNeedle(broken037Predicate), true, 'Regression detector must catch the failed 037 syntax');
assert.equal(hasIdentifierQuotedStrposNeedle(SQL_037), false, 'strpos needles must be PostgreSQL string literals, not identifiers');
assert.equal((SQL_037.match(/\$needle\$whenjsonb_typeof\(row_value\)='object'thentrue\$needle\$/gu) || []).length, 2);
assert.equal((SQL_037.match(/\$needle\$jsonb_build_object\('updated_by',null\)\$needle\$/gu) || []).length, 1);
assert.doesNotThrow(() => assert037FailClosedGuards(SQL_037));
assert.throws(() => assert037FailClosedGuards(SQL_037.replaceAll('v_helper.pronargs <> 1', 'false')), /signature drift/u);
assert.throws(() => assert037FailClosedGuards(SQL_037.replace('CLOUD_RESTORE_ROW_SHAPE_DEFINITION_BASE_MISMATCH', 'REMOVED')), /definition drift/u);
assert.throws(() => assert037FailClosedGuards(SQL_037.replaceAll("has_function_privilege('authenticated', v_helper_oid, 'EXECUTE')", 'false')), /ACL drift/u);
assert.doesNotMatch(SQL_037, /create or replace function public\.erp_cloud_restore_build_effective_snapshot/iu);
assert.doesNotMatch(SQL_037, /create or replace function public\.erp_restore_cloud_snapshot/iu);
assert.match(SQL_037, /regexp_count\(v_builder_definition, 'jsonb_array_elements\\\(p_source_snapshot->v_table\\\)'\) <> 1/u);
assert.match(SQL_037, /regexp_count\(v_builder_definition, 'public\\\.erp_cloud_restore_reject_invalid_portable_row\\\(v_table\\\)'\) <> 1/u);
assert.match(SQL_037, /statement_timeout=120s/u);
assert.match(SQL_037, /has_function_privilege\('authenticated', v_legacy_oid, 'EXECUTE'\)/u);
assert.match(SQL_037, /not has_function_privilege\('authenticated', v_effective_oid, 'EXECUTE'\)/u);
assert.match(SQL_037, /v_server_fingerprint:=public\\\.erp_cloud_restore_idempotency_fingerprint/u);
assert.match(SQL_037, /deletefrompublic\./u);

const helper036 = SQL_036.slice(
  SQL_036.indexOf('create or replace function public.erp_cloud_restore_reject_invalid_portable_row('),
  SQL_036.indexOf('revoke all on function public.erp_cloud_restore_reject_invalid_portable_row('),
);
const builder036 = SQL_036.slice(
  SQL_036.indexOf('create or replace function public.erp_cloud_restore_build_effective_snapshot('),
  SQL_036.indexOf('revoke all on function public.erp_cloud_restore_build_effective_snapshot('),
);
assert.match(helper036, /immutable/u, '036 incorrectly allowed planner-time constant folding');
assert.match(helper036, /raise exception[\s\S]+CLOUD_RESTORE_PORTABILITY_ROW_INVALID/u);
assert.match(builder036, /jsonb_array_elements\(p_source_snapshot->v_table\)/u);
assert.doesNotMatch(builder036, /jsonb_array_elements_text|jsonb_each_text|row_value::text|row_value->>/u);
assert.match(builder036, /else public\.erp_cloud_restore_reject_invalid_portable_row\(v_table\)/u);

const restoreMethod = PROVIDER.slice(PROVIDER.indexOf('async restoreCloudSnapshot('), PROVIDER.indexOf('private async applyCloudFieldMutations'));
assert.match(restoreMethod, /p_source_snapshot: effective\.sourceData/u);
assert.doesNotMatch(restoreMethod, /JSON\.stringify\s*\(/u, 'RPC jsonb must receive a JS object, not a second JSON string');
assert.equal((restoreMethod.match(/supabase\.rpc\(CLOUD_RESTORE_RPC/gu) || []).length, 1);
assert.doesNotMatch(restoreMethod, /\bretry\b|\bwhile\s*\(|\bfor\s*\(/iu);

assert.throws(() => serverRowShapeModel([{ id: 'valid' }, 'bad-string']), /PORTABILITY_ROW_INVALID/u);
assert.throws(() => serverRowShapeModel([null]), /PORTABILITY_ROW_INVALID/u);
assert.throws(() => serverRowShapeModel([[]]), /PORTABILITY_ROW_INVALID/u);
assert.deepEqual(serverRowShapeModel([{ id: 'valid', updated_by: 'source-user' }]), [{ id: 'valid', updated_by: null }]);

const sourceBytes = readFileSync(SNAPSHOT_PATH);
const sourceHashBefore = createHash('sha256').update(sourceBytes).digest('hex');
const rawDocument = JSON.parse(sourceBytes.toString('utf8'));
assert.deepEqual(Object.keys(rawDocument.data), EXPECTED_MAPPING.map(([collection]) => collection));
assertObjectRows(rawDocument.data, EXPECTED_MAPPING.map(([collection]) => collection));
assert.equal(rawDocument.data.inventory.length, 5517);

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const portability = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
  assert.deepEqual(domain.CLOUD_RESTORE_TABLES.map(pair => [...pair]), EXPECTED_MAPPING);

  const source = await domain.prepareCloudRestoreSnapshot(sourceBytes.toString('utf8'), {
    fileName: 'cloud-erp-snapshot-2026-09-20-114903.json',
    sourceFileSha256: sourceHashBefore,
  });
  assert.equal(source.manifest.totalRows, 17658);
  assert.equal(source.data.inventory_items.length, 5517);
  assertObjectRows(source.data, EXPECTED_MAPPING.map(([, table]) => table));

  const portable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(source, 'rhfdjsklfrgpoqsaqpkn');
  const effective = await portability.assertCloudRestoreEffectiveCandidate(portable);
  assert.equal(effective.mode, 'cross-environment');
  assert.equal(effective.transformedValueCount, 15395);
  assert.equal(portable.manifest.snapshotFingerprint, '2539b3f7b64b3b4b65463a5fe76d0fff2e9edbde9cf7970fdcfc80a4bbd2787f');
  assertObjectRows(effective.sourceData, EXPECTED_MAPPING.map(([, table]) => table));
  assertObjectRows(effective.effectiveData, EXPECTED_MAPPING.map(([, table]) => table));

  const rpcArgs = {
    p_idempotency_key: 'fbe08650-22c7-4e8d-9852-c16658edffff',
    p_snapshot_fingerprint: portable.manifest.snapshotFingerprint,
    p_source_snapshot: effective.sourceData,
    p_manifest: portable.manifest,
    p_source_environment: portable.sourceEnvironment,
    p_restore_mode: effective.mode,
  };
  const postgrestWireModel = JSON.parse(JSON.stringify(rpcArgs));
  assert.equal(typeof postgrestWireModel.p_source_snapshot, 'object');
  assert.equal(typeof postgrestWireModel.p_source_snapshot.inventory_items[0], 'object');
  assert.equal(Array.isArray(postgrestWireModel.p_source_snapshot.inventory_items[0]), false);
  assert.equal(postgrestWireModel.p_source_snapshot.inventory_items.length, 5517);
  assertObjectRows(postgrestWireModel.p_source_snapshot, EXPECTED_MAPPING.map(([, table]) => table));
  assert.equal(serverRowShapeModel(postgrestWireModel.p_source_snapshot.inventory_items).length, 5517);

  for (const invalid of ['bad-string', null, []]) {
    const changed = structuredClone(rawDocument);
    changed.data.inventory[0] = invalid;
    await assert.rejects(
      domain.prepareCloudRestoreSnapshot(changed),
      error => error?.code === 'RESTORE_ROW_INVALID',
    );
  }
  const missingAlias = structuredClone(rawDocument);
  delete missingAlias.data.inventory;
  await assert.rejects(
    domain.prepareCloudRestoreSnapshot(missingAlias),
    error => error?.code === 'RESTORE_COLLECTION_REQUIRED',
  );
  const unknownAlias = structuredClone(rawDocument);
  unknownAlias.data.inventory_items = unknownAlias.data.inventory;
  await assert.rejects(
    domain.prepareCloudRestoreSnapshot(unknownAlias),
    error => error?.code === 'UNEXPECTED_RESOURCE',
  );

  assert.equal(createHash('sha256').update(readFileSync(SNAPSHOT_PATH)).digest('hex'), sourceHashBefore);
} finally {
  await vite.close();
}

console.log('PASS 037 changes only the fail-closed helper volatility and preserves the 036 builder/writer contract');
console.log('PASS actual 17,658-row snapshot keeps 5,517 inventory rows and all 15 resources as JSON objects through RPC serialization');
console.log('PASS invalid string/null/array rows, missing aliases, and duplicate/unknown aliases remain fail closed');
console.log('PENDING real PostgreSQL apply/postflight: no isolated PostgreSQL runtime is installed; Staging apply is forbidden in this turn');
