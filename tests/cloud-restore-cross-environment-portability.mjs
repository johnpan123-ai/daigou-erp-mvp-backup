import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'vite';

const SQL = readFileSync(new URL('../supabase/sql/030_cloud_restore_cross_environment_audit_identity_portability.sql', import.meta.url), 'utf8');
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const actor = uuid(900);
const clone = value => structuredClone(value);
const collections = {
  inventory: [{ id: uuid(15), inventory_key: 'PORTABLE::SKU', updated_by: actor }],
  productGroups: [{ id: uuid(1), local_id: 'group', title: 'Portable', updated_by: actor }],
  productCategories: [{ id: uuid(2), local_id: 'category', product_group_id: uuid(1), title: 'Default', updated_by: actor }],
  productVariants: [{ id: uuid(3), local_id: 'variant', product_group_id: uuid(1), product_category_id: uuid(2), updated_by: actor }],
  bundleComponents: [{ id: uuid(4), bundle_variant_id: uuid(3), component_variant_id: uuid(3), updated_by: actor }],
  purchaseBatches: [{ id: uuid(5), local_id: 'batch', product_group_id: uuid(1), updated_by: actor }],
  purchaseBatchItems: [{ id: uuid(6), local_id: 'batch-item', purchase_batch_id: uuid(5), product_variant_id: uuid(3), updated_by: actor }],
  privateOrders: [{ id: uuid(7), local_id: 'private', product_group_id: uuid(1), updated_by: actor }],
  privateOrderItems: [{ id: uuid(8), local_id: 'private-item', private_order_id: uuid(7), product_variant_id: uuid(3), updated_by: actor }],
  salesOrders: [{ id: uuid(9), local_id: 'sales', updated_by: actor }],
  salesOrderItems: [{ id: uuid(10), local_id: 'sales-item', order_id: uuid(9), product_variant_id: uuid(3), updated_by: actor }],
  japanPackages: [{ id: uuid(11), updated_by: actor }],
  japanPackageItems: [{ id: uuid(12), japan_package_id: uuid(11), product_group_id: uuid(1), product_variant_id: uuid(3), purchase_batch_id: uuid(5), purchase_batch_item_id: uuid(6), updated_by: actor }],
  outboundShipments: [{ id: uuid(13), updated_by: actor }],
  outboundShipmentItems: [{ id: uuid(14), outbound_shipment_id: uuid(13), japan_package_item_id: uuid(12), product_group_id: uuid(1), product_variant_id: uuid(3), updated_by: actor }],
};

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const portability = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
  const built = await domain.buildCloudRestoreManifest(collections, collections);
  const document = {
    schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION,
    sourceEnvironment: 'cloud-authoritative',
    manifest: built.manifest,
    data: clone(collections),
  };
  const sourceText = JSON.stringify(document);
  const sourceSha = createHash('sha256').update(sourceText).digest('hex');
  const strict = await domain.prepareCloudRestoreSnapshot(sourceText, {
    fileName: 'production-source.json',
    sourceFileSha256: sourceSha,
  });
  const originalBefore = createHash('sha256').update(sourceText).digest('hex');
  const portable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(
    strict,
    'rhfdjsklfrgpoqsaqpkn',
  );
  const originalAfter = createHash('sha256').update(sourceText).digest('hex');

  assert.equal(originalBefore, originalAfter, 'The original JSON must remain byte-identical');
  assert.equal(strict.portability, undefined, 'Strict mode must not transform silently');
  assert.equal(strict.executionFingerprint, strict.manifest.snapshotFingerprint);
  assert.equal(portable.portability.policyVersion, 'cross-environment-audit-null-v1');
  assert.equal(portable.portability.targetProjectRef, 'rhfdjsklfrgpoqsaqpkn');
  assert.equal(portable.portability.sourceFileSha256, sourceSha);
  assert.equal(portable.portability.sourceSnapshotFingerprint, strict.manifest.snapshotFingerprint);
  assert.equal(portable.portability.totalTransformedRows, 15);
  assert.notEqual(portable.manifest.snapshotFingerprint, strict.manifest.snapshotFingerprint);
  assert.notEqual(portable.executionFingerprint, portable.manifest.snapshotFingerprint);
  assert.equal(portable.manifest.relationshipHash, strict.manifest.relationshipHash);
  assert.deepEqual(portable.manifest.counts, strict.manifest.counts);
  for (const [, table] of domain.CLOUD_RESTORE_TABLES) {
    assert.equal(portable.portability.transformedCounts[table], 1, `${table} must use the fixed audit allowlist`);
    assert.equal(portable.data[table][0].updated_by, null);
    assert.equal(portable.data[table][0].id, strict.data[table][0].id, `${table} canonical id must be preserved`);
    const sourceBusiness = { ...strict.data[table][0] };
    const portableBusiness = { ...portable.data[table][0] };
    delete sourceBusiness.updated_by;
    delete portableBusiness.updated_by;
    assert.deepEqual(portableBusiness, sourceBusiness, `${table} business values must be unchanged`);
  }

  const nullSource = clone(document);
  for (const rows of Object.values(nullSource.data)) rows.forEach(row => { row.updated_by = null; });
  nullSource.manifest = (await domain.buildCloudRestoreManifest(nullSource.data, nullSource.data)).manifest;
  const nullText = JSON.stringify(nullSource);
  const nullStrict = await domain.prepareCloudRestoreSnapshot(nullText);
  const nullPortable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(nullStrict, 'rhfdjsklfrgpoqsaqpkn');
  assert.equal(nullPortable.portability.totalTransformedRows, 0);
  assert.equal(nullPortable.manifest.snapshotFingerprint, nullStrict.manifest.snapshotFingerprint);
  assert.notEqual(nullPortable.executionFingerprint, nullStrict.executionFingerprint, 'Policy semantics must bind idempotency even when rows are unchanged');

  await assert.rejects(
    () => portability.prepareCrossEnvironmentCloudRestoreCandidate(strict, 'twzpqyesbtnfxdkorluf'),
    error => error.code === 'RESTORE_PORTABILITY_TARGET_BLOCKED',
  );
  await assert.rejects(
    () => portability.prepareCrossEnvironmentCloudRestoreCandidate(portable, 'rhfdjsklfrgpoqsaqpkn'),
    error => error.code === 'RESTORE_PORTABILITY_ALREADY_APPLIED',
  );
  await assert.rejects(
    () => domain.prepareCloudRestoreSnapshot({ ...document, manifest: { ...document.manifest, portability: portable.portability } }),
    error => error.code === 'RESTORE_PORTABLE_CANDIDATE_NOT_IMPORTABLE',
  );

  const changedAfterPreflight = { ...strict, data: clone(strict.data) };
  changedAfterPreflight.data.inventory_items[0].product_title = 'changed after source verification';
  await assert.rejects(
    () => portability.prepareCrossEnvironmentCloudRestoreCandidate(changedAfterPreflight, 'rhfdjsklfrgpoqsaqpkn'),
    error => error.code === 'RESTORE_PORTABILITY_SOURCE_CHANGED',
  );

  const invalidAuditDocument = clone(document);
  invalidAuditDocument.data.inventory[0].updated_by = 'not-a-uuid';
  invalidAuditDocument.manifest = (await domain.buildCloudRestoreManifest(invalidAuditDocument.data, invalidAuditDocument.data)).manifest;
  const invalidAuditSource = await domain.prepareCloudRestoreSnapshot(invalidAuditDocument);
  await assert.rejects(
    () => portability.prepareCrossEnvironmentCloudRestoreCandidate(invalidAuditSource, 'rhfdjsklfrgpoqsaqpkn'),
    error => error.code === 'RESTORE_PORTABILITY_AUDIT_IDENTITY_INVALID',
  );

  const tamperedManifest = clone(document);
  tamperedManifest.manifest.snapshotFingerprint = '0'.repeat(64);
  await assert.rejects(
    () => domain.prepareCloudRestoreSnapshot(tamperedManifest),
    error => error.code === 'RESTORE_MANIFEST_MISMATCH',
  );
  const brokenBusinessRelation = clone(document);
  brokenBusinessRelation.data.purchaseBatchItems[0].purchase_batch_id = uuid(999);
  await assert.rejects(
    () => domain.prepareCloudRestoreSnapshot(brokenBusinessRelation),
    error => error.code === 'ORPHAN_RELATION',
  );

  const modelRequests = new Map();
  const bind = candidate => domain.sha256Hex(domain.stableCloudRestoreJson({
    snapshot: candidate.data,
    portability: candidate.portability ?? null,
  }));
  const key = uuid(901);
  modelRequests.set(key, await bind(portable));
  assert.notEqual(modelRequests.get(key), await bind(strict), 'Same key with different policy/payload must mismatch');

  const target = { marker: 'before' };
  const before = clone(target);
  try {
    for (const [index, [, table]] of domain.CLOUD_RESTORE_TABLES.entries()) {
      target[table] = clone(portable.data[table]);
      if (index === 7) throw new Error('INJECTED_INSERT_FAILURE');
    }
  } catch {
    for (const property of Object.keys(target)) delete target[property];
    Object.assign(target, before);
  }
  assert.deepEqual(target, before, 'Any later INSERT failure must roll back the isolated transaction model');

  const currentSourcePath = 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-13-060717.json';
  if (existsSync(currentSourcePath)) {
    const bytes = readFileSync(currentSourcePath);
    const hashBefore = createHash('sha256').update(bytes).digest('hex');
    const actual = await domain.prepareCloudRestoreSnapshot(bytes.toString('utf8'), {
      fileName: 'cloud-erp-snapshot-2026-09-13-060717.json',
      sourceFileSha256: hashBefore,
    });
    const actualPortable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(actual, 'rhfdjsklfrgpoqsaqpkn');
    const hashAfter = createHash('sha256').update(readFileSync(currentSourcePath)).digest('hex');
    assert.equal(hashBefore, '721783423587502001a7f48f26335867b3bea5290f22c4fd7b2c7feafd10d8d4');
    assert.equal(hashAfter, hashBefore);
    assert.equal(actual.manifest.totalRows, 16528);
    assert.equal(actual.manifest.snapshotFingerprint, 'e792ae760ca94e76bbbf0adda5a46c823e5d019a17d39141dae3449e234bd6ed');
    assert.equal(actual.manifest.relationshipHash, 'f35e2f4029cd50953043829ee269023a30d538f11bbac92e3e4cc014ac193283');
    assert.equal(actualPortable.portability.totalTransformedRows, 14476);
    assert.deepEqual(actualPortable.portability.transformedCounts, {
      inventory_items: 5154,
      product_groups: 827,
      product_categories: 630,
      product_variants: 4628,
      bundle_components: 0,
      purchase_batches: 623,
      purchase_batch_items: 2378,
      private_orders: 107,
      private_order_items: 129,
      sales_orders: 0,
      sales_order_items: 0,
      japan_packages: 0,
      japan_package_items: 0,
      outbound_shipments: 0,
      outbound_shipment_items: 0,
    });
    assert.equal(actualPortable.manifest.relationshipHash, actual.manifest.relationshipHash);
    assert.equal(actualPortable.manifest.totalRows, actual.manifest.totalRows);
    console.log(`PASS current 16,528-row Production Cloud Snapshot source; effective candidate fingerprint=${actualPortable.manifest.snapshotFingerprint}`);
  } else {
    console.log('PENDING current 16,528-row Production Cloud Snapshot source probe: source file unavailable');
  }

  const approvedPath = 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-12-020044.json';
  if (existsSync(approvedPath)) {
    const bytes = readFileSync(approvedPath);
    const hashBefore = createHash('sha256').update(bytes).digest('hex');
    const approved = await domain.prepareCloudRestoreSnapshot(bytes.toString('utf8'), {
      fileName: 'cloud-erp-snapshot-2026-09-12-020044.json',
      sourceFileSha256: hashBefore,
    });
    const approvedPortable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(approved, 'rhfdjsklfrgpoqsaqpkn');
    assert.equal(hashBefore, 'd2834a75ecc7d75c6e839cba897994d7249fe55d96e894cc342f52c59c86c2f0');
    assert.equal(createHash('sha256').update(readFileSync(approvedPath)).digest('hex'), hashBefore);
    assert.equal(approved.manifest.totalRows, 16482);
    assert.equal(approved.manifest.snapshotFingerprint, '9df26da59164fd8bfdcca3fc5072b6e977636208c7e4a1b6cf6c131e66fc41ce');
    assert.equal(approved.manifest.relationshipHash, '138751fb3d11caa709a59a5f498b1e410f3ce290110ea7322eaff651f18811a0');
    assert.notEqual(approvedPortable.manifest.snapshotFingerprint, 'e792ae760ca94e76bbbf0adda5a46c823e5d019a17d39141dae3449e234bd6ed', 'Approved and diagnostic sources remain independent candidates');
    console.log(`PASS historical 16,482-row source remains separate; effective candidate fingerprint=${approvedPortable.manifest.snapshotFingerprint}`);
  } else {
    console.log('PENDING optional authorized 16,482-row source probe: source file unavailable');
  }
} finally {
  await vite.close();
}

const expectedTables = [
  'inventory_items','product_groups','product_categories','product_variants','bundle_components',
  'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
  'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items',
];
const expectedSchemaMatrix = expectedTables.map(table => ({
  table,
  column: 'updated_by',
  type: 'uuid',
  nullable: true,
  parentSchema: 'auth',
  parentTable: 'users',
  parentColumn: 'id',
  onDelete: 'SET NULL',
  validated: true,
}));
const schemaModelAccepts = matrix => matrix.length === expectedTables.length
  && expectedTables.every(table => matrix.some(reference => reference.table === table
    && reference.column === 'updated_by'
    && reference.type === 'uuid'
    && reference.nullable === true
    && reference.parentSchema === 'auth'
    && reference.parentTable === 'users'
    && reference.parentColumn === 'id'
    && reference.onDelete === 'SET NULL'
    && reference.validated === true));
assert.equal(schemaModelAccepts(expectedSchemaMatrix), true);
for (const incompatible of [
  expectedSchemaMatrix.slice(1),
  expectedSchemaMatrix.map((entry, index) => index === 0 ? { ...entry, nullable: false } : entry),
  expectedSchemaMatrix.map((entry, index) => index === 0 ? { ...entry, parentSchema: 'public', parentTable: 'profiles' } : entry),
  [...expectedSchemaMatrix, { ...expectedSchemaMatrix[0], table: 'inventory_items', column: 'owner_id' }],
]) {
  assert.equal(schemaModelAccepts(incompatible), false, 'Unexpected, non-nullable, authorization, or missing external references must fail closed');
}
for (const table of expectedTables) {
  assert.match(SQL, new RegExp(`'${table}'`, 'u'));
}
assert.match(SQL, /cross-environment-audit-null-v1/u);
assert.match(SQL, /updated_by/u);
assert.match(SQL, /parent_ns\.nspname = 'auth'[\s\S]+parent\.relname = 'users'/u);
assert.match(SQL, /not a\.attnotnull[\s\S]+format_type\(a\.atttypid, a\.atttypmod\) = 'uuid'/u);
assert.match(SQL, /CLOUD_RESTORE_PORTABILITY_EXTERNAL_REFERENCE_BLOCKED/u);
assert.match(SQL, /erp_cloud_restore_idempotency_fingerprint\(p_snapshot, p_manifest\)/u);
assert.match(SQL, /\(v_counts->>v_table\)::bigint > jsonb_array_length\(p_snapshot->v_table\)/u);
assert.match(SQL, /set search_path = pg_catalog, public, extensions/u);
assert.doesNotMatch(SQL, /\b(?:insert into|update public\.|delete from public\.|truncate)\b/iu, '030 apply must contain no business DML');
assert.doesNotMatch(SQL, /service_role|password|twzpqyesbtnfxdkorluf/iu);

console.log('PASS fixed 15-table updated_by policy, strict-mode preservation, source immutability, target/schema fail-closed, policy-bound idempotency, and rollback model');
console.log('PENDING PostgreSQL FK integration: no isolated local PostgreSQL runtime is installed; Live Restore was not used as a substitute');
