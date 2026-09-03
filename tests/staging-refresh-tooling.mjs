import assert from 'node:assert/strict';
import {
  LOGICAL_RELATIONSHIPS,
  PRODUCTION_PROJECT_REF,
  REQUIRED_TABLES,
  STAGING_PROJECT_REF,
  assertConnectionTargetsProject,
  assertNoSecrets,
  assertRefreshDirection,
} from '../tools/staging-refresh/policy.mjs';
import {
  applyAuthAttributionPolicy,
  assertSchemaCompatible,
  buildSnapshotManifest,
  compareManifests,
  createSnapshotEnvelope,
  validateSnapshotEnvelope,
} from '../tools/staging-refresh/manifest.mjs';
import { buildSnapshotSql, buildTransactionalRestoreSql } from '../tools/staging-refresh/postgres.mjs';
import { replaceFixtureAtomically } from '../tools/staging-refresh/fixtureTransaction.mjs';

const ids = {
  group: '10000000-0000-4000-8000-000000000001',
  category: '10000000-0000-4000-8000-000000000002',
  variant: '10000000-0000-4000-8000-000000000003',
  batch: '10000000-0000-4000-8000-000000000004',
  batchItem: '10000000-0000-4000-8000-000000000005',
  privateOrder: '10000000-0000-4000-8000-000000000006',
  privateItem: '10000000-0000-4000-8000-000000000007',
  salesOrder: '10000000-0000-4000-8000-000000000008',
  salesItem: '10000000-0000-4000-8000-000000000009',
  package: '10000000-0000-4000-8000-00000000000a',
  packageItem: '10000000-0000-4000-8000-00000000000b',
  bundle: '10000000-0000-4000-8000-00000000000c',
  outbound: '10000000-0000-4000-8000-00000000000d',
  outboundItem: '10000000-0000-4000-8000-00000000000e',
  actor: '10000000-0000-4000-8000-00000000000f',
};

const data = Object.fromEntries(REQUIRED_TABLES.map(table => [table, []]));
Object.assign(data, {
  inventory_items: [{ myacg_item_code: 'SKU-1', product_title: '商品', updated_by: ids.actor }],
  product_groups: [{ id: ids.group, local_id: 'group-local', title: '商品群組', updated_by: ids.actor }],
  product_categories: [{ id: ids.category, product_group_id: ids.group, title: '分類' }],
  product_variants: [{ id: ids.variant, local_id: 'variant-local', product_group_id: ids.group, product_category_id: ids.category, myacg_item_code: 'SKU-1', raw_variant_name: '通常版' }],
  purchase_batches: [{ id: ids.batch, product_group_id: ids.group }],
  purchase_batch_items: [{ id: ids.batchItem, purchase_batch_id: ids.batch, product_variant_id: ids.variant }],
  private_orders: [{ id: ids.privateOrder, product_group_id: ids.group, customer_name: '內部測試客戶' }],
  private_order_items: [{ id: ids.privateItem, private_order_id: ids.privateOrder, product_variant_id: ids.variant }],
  sales_orders: [{ id: ids.salesOrder, buyer_name: '內部測試買家' }],
  sales_order_items: [{ id: ids.salesItem, order_id: ids.salesOrder, product_variant_id: ids.variant }],
  japan_packages: [{ id: ids.package, tracking_number: 'TRACKING-FIXTURE' }],
  japan_package_items: [{ id: ids.packageItem, japan_package_id: ids.package, product_group_id: ids.group, product_variant_id: ids.variant, purchase_batch_id: ids.batch, purchase_batch_item_id: ids.batchItem }],
  bundle_components: [
    { id: ids.bundle, bundle_variant_id: ids.variant, component_variant_id: ids.variant },
    { id: 'historical-orphan', bundle_variant_id: ids.variant, component_variant_id: 'missing-historical-variant' },
  ],
  outbound_shipments: [{ id: ids.outbound }],
  outbound_shipment_items: [{ id: ids.outboundItem, outbound_shipment_id: ids.outbound, japan_package_item_id: ids.packageItem, product_group_id: ids.group, product_variant_id: ids.variant }],
});

const schema = {
  publicTables: [...REQUIRED_TABLES, 'profiles'],
  columns: Object.entries(data).flatMap(([tableName, rows]) => {
    const keys = new Set(['id', ...Object.keys(rows[0] || {})]);
    return [...keys].map(columnName => ({
      tableName,
      columnName,
      dataType: columnName.endsWith('_id') || columnName === 'id' ? 'uuid' : 'text',
      udtName: columnName.endsWith('_id') || columnName === 'id' ? 'uuid' : 'text',
      nullable: columnName === 'updated_by' || columnName === 'product_category_id',
      defaultValue: null,
    }));
  }),
  foreignKeys: [
    ...LOGICAL_RELATIONSHIPS.map(([childTable, childColumn, parentTable, parentColumn], index) => ({
      constraintName: `fixture_fk_${index}`,
      childTable, childColumn, parentSchema: 'public', parentTable, parentColumn,
    })),
    { constraintName: 'fixture_updated_by', childTable: 'product_groups', childColumn: 'updated_by', parentSchema: 'auth', parentTable: 'users', parentColumn: 'id' },
    { constraintName: 'fixture_inventory_updated_by', childTable: 'inventory_items', childColumn: 'updated_by', parentSchema: 'auth', parentTable: 'users', parentColumn: 'id' },
  ],
};

assert.deepEqual(assertRefreshDirection(PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF), {
  source: PRODUCTION_PROJECT_REF,
  target: STAGING_PROJECT_REF,
});
assert.throws(() => assertRefreshDirection(PRODUCTION_PROJECT_REF, PRODUCTION_PROJECT_REF), /Source 與 Target|Production/);
assert.throws(
  () => assertRefreshDirection(STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF),
  error => error?.code === 'SOURCE_NOT_PRODUCTION',
);
assert.doesNotThrow(() => assertConnectionTargetsProject(
  `postgresql://postgres.${STAGING_PROJECT_REF}:fixture@pooler.example.test/postgres`,
  STAGING_PROJECT_REF,
  'fixture',
));
assert.throws(() => assertConnectionTargetsProject(
  `postgresql://postgres.${PRODUCTION_PROJECT_REF}:fixture@pooler.example.test/postgres`,
  STAGING_PROJECT_REF,
  'fixture',
), /無法證明/);

const snapshot = createSnapshotEnvelope({
  sourceProjectRef: PRODUCTION_PROJECT_REF,
  schema,
  data,
  piiMode: 'internal-preserve',
  snapshotId: '20000000-0000-4000-8000-000000000001',
  capturedAt: '2026-09-03T00:00:00.000Z',
});
assert.equal(validateSnapshotEnvelope(snapshot).snapshotHash, snapshot.snapshotHash);
const manifest = buildSnapshotManifest(snapshot);
assert.equal(manifest.anomalies.unknownProduct.count, 0);
assert.equal(manifest.anomalies.duplicateVariantId.count, 0);
assert.equal(manifest.relationships['bundle_components.component_variant_id->product_variants.id'].orphanCount, 1);
assert.equal(manifest.productVariantIdentityHash.length, 64);

const restoredData = structuredClone(data);
const restoredSnapshot = createSnapshotEnvelope({
  sourceProjectRef: STAGING_PROJECT_REF,
  schema,
  data: restoredData,
  piiMode: 'internal-preserve',
  snapshotId: snapshot.snapshotId,
  capturedAt: snapshot.capturedAt,
});
assert.equal(compareManifests(manifest, buildSnapshotManifest(restoredSnapshot)).accepted, true);

restoredData.bundle_components.push({ id: 'new-orphan', bundle_variant_id: ids.variant, component_variant_id: 'new-missing' });
const badSnapshot = createSnapshotEnvelope({
  sourceProjectRef: STAGING_PROJECT_REF,
  schema,
  data: restoredData,
  piiMode: 'internal-preserve',
  snapshotId: snapshot.snapshotId,
  capturedAt: snapshot.capturedAt,
});
const badComparison = compareManifests(manifest, buildSnapshotManifest(badSnapshot));
assert.equal(badComparison.accepted, false);
assert.equal(badComparison.newAnomalyDelta, 'NON_ZERO');

const nullAttributed = applyAuthAttributionPolicy(snapshot, schema, { mode: 'null' });
assert.equal(nullAttributed.data.product_groups[0].updated_by, null);
assert.equal(nullAttributed.data.inventory_items[0].updated_by, null);
assert.equal(nullAttributed.data.product_variants[0].id, ids.variant);
const actorAttributed = applyAuthAttributionPolicy(snapshot, schema, { mode: 'staging-actor', actorId: ids.actor });
assert.equal(actorAttributed.data.product_groups[0].updated_by, ids.actor);
assert.throws(() => applyAuthAttributionPolicy(snapshot, schema, { mode: 'preserve' }), /AUTH_ATTRIBUTION_POLICY_REQUIRED/);

assert.doesNotThrow(() => assertSchemaCompatible(schema, structuredClone(schema), REQUIRED_TABLES));
const changedSchema = structuredClone(schema);
changedSchema.columns.find(column => column.tableName === 'product_variants' && column.columnName === 'id').dataType = 'text';
assert.throws(() => assertSchemaCompatible(schema, changedSchema, REQUIRED_TABLES), /SCHEMA_MISMATCH:product_variants/);
const changedForeignKeySchema = structuredClone(schema);
changedForeignKeySchema.foreignKeys = changedForeignKeySchema.foreignKeys.filter(reference => reference.constraintName !== 'fixture_fk_1');
assert.throws(() => assertSchemaCompatible(schema, changedForeignKeySchema, REQUIRED_TABLES), /SCHEMA_MISMATCH:foreign_keys/);

assert.doesNotThrow(() => assertNoSecrets(data));
assert.throws(() => assertNoSecrets({ access_token: 'forbidden' }), /敏感欄位/);
const restoreSql = buildTransactionalRestoreSql(snapshot);
assert.match(restoreSql, /^BEGIN ISOLATION LEVEL SERIALIZABLE;/);
assert.match(restoreSql, /CREATE TEMP TABLE/);
assert.match(restoreSql, /STAGING_READBACK_MISMATCH/);
assert.match(restoreSql, /COMMIT;$/);
assert.doesNotMatch(restoreSql, new RegExp(PRODUCTION_PROJECT_REF));
const snapshotSql = buildSnapshotSql(REQUIRED_TABLES);
assert.match(snapshotSql, /REPEATABLE READ READ ONLY DEFERRABLE/);
assert.doesNotMatch(snapshotSql, /INSERT|UPDATE|DELETE|TRUNCATE/i);

const target = { product_groups: [{ id: 'old-target' }], product_variants: [] };
await assert.rejects(
  replaceFixtureAtomically(target, snapshot, { failAfterTable: 3 }),
  /INJECTED_RESTORE_FAILURE/,
);
assert.deepEqual(target, { product_groups: [{ id: 'old-target' }], product_variants: [] });
const cleanTarget = {};
assert.equal((await replaceFixtureAtomically(cleanTarget, snapshot)).accepted, true);
assert.equal((await replaceFixtureAtomically(cleanTarget, snapshot)).accepted, true);
assert.equal(cleanTarget.product_variants.length, 1);
assert.equal(cleanTarget.product_variants[0].id, ids.variant);

console.log('PASS source/target project-ref direction is fail closed; Production target has no override');
console.log('PASS snapshot is read-only, deterministic, secret-free and preserves UUID identity');
console.log('PASS manifest compares counts, ID/row/relationship/identity hashes and anomaly ID sets');
console.log('PASS historical orphan baseline is preserved while new anomaly delta is rejected');
console.log('PASS schema mismatch and unresolved Auth attribution are rejected');
console.log('PASS transactional restore contract rolls back injected failure and retry creates no duplicate');
