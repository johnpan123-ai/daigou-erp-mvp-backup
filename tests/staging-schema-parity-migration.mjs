import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertSchemaCompatible,
  buildSnapshotManifest,
  createSnapshotEnvelope,
} from '../tools/staging-refresh/manifest.mjs';
import { STAGING_PROJECT_REF } from '../tools/staging-refresh/policy.mjs';
import {
  STAGING_SCHEMA_PARITY_TABLES,
  applyStagingSchemaParityFixture,
  createLegacyStagingParityFixture,
  toRefreshToolingSchema,
} from '../tools/staging-refresh/stagingSchemaParityFixture.mjs';

const migrationPath = fileURLToPath(new URL(
  '../tools/staging-refresh/sql/staging_schema_parity_20260905.sql',
  import.meta.url,
));
const providerPath = fileURLToPath(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url));
const dbPath = fileURLToPath(new URL('../src/lib/db.ts', import.meta.url));
const migrationSql = readFileSync(migrationPath, 'utf8');
const providerSource = readFileSync(providerPath, 'utf8');
const dbSource = readFileSync(dbPath, 'utf8');

const legacy = createLegacyStagingParityFixture();
const legacyBefore = structuredClone(legacy);
const productionContract = structuredClone(legacy);
await applyStagingSchemaParityFixture(productionContract, {
  uuidFactory: index => `10000000-0000-4000-8000-00000000000${index + 1}`,
});

assert.throws(
  () => assertSchemaCompatible(
    toRefreshToolingSchema(productionContract),
    toRefreshToolingSchema(legacy),
    STAGING_SCHEMA_PARITY_TABLES,
  ),
  /SCHEMA_MISMATCH/,
);
assert.doesNotThrow(() => assertSchemaCompatible(
  toRefreshToolingSchema(productionContract),
  toRefreshToolingSchema(productionContract),
  STAGING_SCHEMA_PARITY_TABLES,
));

const paritySchema = toRefreshToolingSchema(productionContract);
const reorderedParitySchema = structuredClone(paritySchema);
reorderedParitySchema.columns.reverse();
reorderedParitySchema.constraints.reverse();
reorderedParitySchema.foreignKeys.reverse();
assert.doesNotThrow(() => assertSchemaCompatible(
  paritySchema,
  reorderedParitySchema,
  STAGING_SCHEMA_PARITY_TABLES,
));
const emptyParityData = Object.fromEntries(STAGING_SCHEMA_PARITY_TABLES.map(table => [table, []]));
const manifestFor = schema => buildSnapshotManifest(createSnapshotEnvelope({
  sourceProjectRef: STAGING_PROJECT_REF,
  schema,
  data: emptyParityData,
  piiMode: 'internal-preserve',
  snapshotId: '20000000-0000-4000-8000-000000000001',
  capturedAt: '2026-09-05T00:00:00.000Z',
}));
assert.equal(
  manifestFor(paritySchema).schemaFingerprint,
  manifestFor(reorderedParitySchema).schemaFingerprint,
);
const changedParitySchema = structuredClone(reorderedParitySchema);
changedParitySchema.columns.find(columnDefinition => (
  columnDefinition.tableName === 'product_groups'
  && columnDefinition.columnName === 'purchase_date'
)).dataType = 'text';
assert.throws(
  () => assertSchemaCompatible(paritySchema, changedParitySchema, STAGING_SCHEMA_PARITY_TABLES),
  /SCHEMA_MISMATCH:product_groups/,
);
assert.notEqual(
  manifestFor(paritySchema).schemaFingerprint,
  manifestFor(changedParitySchema).schemaFingerprint,
);

assert.equal(productionContract.schema.tables.inventory_items.primaryKey.join(','), 'id');
assert.deepEqual(productionContract.schema.tables.inventory_items.uniques, [
  { name: 'inventory_items_inventory_key_key', columns: ['inventory_key'] },
]);
assert.equal(
  productionContract.schema.tables.inventory_items.columns.id.defaultValue,
  'gen_random_uuid()',
);
assert.equal(
  productionContract.schema.tables.inventory_items.columns.catalog_last_seen_at.dataType,
  'timestamp with time zone',
);
assert.equal(
  productionContract.schema.tables.inventory_items.indexes.inventory_items_catalog_last_seen_at_idx.unique,
  false,
);
assert.deepEqual(
  productionContract.data.inventory_items.map(row => row.inventory_key),
  legacyBefore.data.inventory_items.map(row => row.inventory_key),
);
assert.equal(new Set(productionContract.data.inventory_items.map(row => row.id)).size, 2);

const changedInventoryIdentity = structuredClone(productionContract);
changedInventoryIdentity.data.inventory_items[0].id = '90000000-0000-4000-8000-000000000009';
const inventoryManifestFor = fixture => buildSnapshotManifest(createSnapshotEnvelope({
  sourceProjectRef: STAGING_PROJECT_REF,
  schema: toRefreshToolingSchema(fixture),
  data: fixture.data,
  piiMode: 'internal-preserve',
  snapshotId: '20000000-0000-4000-8000-000000000002',
  capturedAt: '2026-09-05T00:00:00.000Z',
}));
assert.notEqual(
  inventoryManifestFor(productionContract).tables.inventory_items.idSetHash,
  inventoryManifestFor(changedInventoryIdentity).tables.inventory_items.idSetHash,
);

assert.equal(productionContract.schema.tables.product_groups.columns.purchase_date.dataType, 'date');
assert.equal(productionContract.schema.tables.purchase_batches.columns.date.dataType, 'date');
assert.equal(productionContract.data.product_groups[0].purchase_date, '2026-09-05');
assert.equal(productionContract.data.product_groups[1].purchase_date, null);
assert.equal(productionContract.data.purchase_batches[0].date, '2026-09-04');
assert.equal(productionContract.data.purchase_batches[1].date, null);

for (const name of ['private_manual_adjustment', 'purchased_manual_adjustment']) {
  const definition = productionContract.schema.tables.product_variants.columns[name];
  assert.equal(definition.nullable, true);
  assert.equal(definition.defaultValue, null);
}
assert.equal(productionContract.data.product_variants[0].private_manual_adjustment, 0);
assert.equal(productionContract.data.product_variants[0].purchased_manual_adjustment, 7);

assert.equal(productionContract.schema.tables.sales_orders.columns.buyer_name.nullable, false);
assert.deepEqual(productionContract.schema.tables.sales_orders.columns.version, {
  dataType: 'integer', udtName: 'integer', nullable: false, defaultValue: '1', generated: 'NEVER', identityGeneration: null,
});
assert.equal(productionContract.schema.tables.sales_order_items.columns.price.nullable, true);
assert.equal(productionContract.schema.tables.sales_order_items.columns.amount.nullable, true);
assert.equal(productionContract.schema.tables.sales_order_items.columns.price.defaultValue, '0');
assert.equal(productionContract.schema.tables.sales_order_items.columns.amount.defaultValue, '0');
assert.equal(productionContract.data.sales_orders[0].version, 1);
assert.equal(productionContract.data.sales_order_items[0].version, 1);

assert.equal(
  productionContract.schema.foreignKeys.purchase_batches_product_group_id_fkey.onDelete,
  'CASCADE',
);
assert.equal(
  productionContract.schema.foreignKeys.private_orders_product_group_id_fkey.onDelete,
  'CASCADE',
);
assert.equal(
  productionContract.schema.tables.sales_orders.indexes.idx_sales_orders_order_number.unique,
  false,
);
assert.equal(
  productionContract.schema.tables.sales_orders.indexes.idx_sales_orders_deleted_at,
  undefined,
);
assert.equal(
  productionContract.schema.tables.sales_order_items.indexes.idx_sales_order_items_deleted_at,
  undefined,
);
assert.deepEqual(productionContract.schema.tables.sales_orders.uniques, [
  { name: 'sales_orders_order_number_key', columns: ['order_number'] },
]);

const projection = (fixture, table, excluded = []) => fixture.data[table].map(row => (
  Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.includes(key)))
));
assert.deepEqual(
  projection(productionContract, 'inventory_items', ['id', 'latest_catalog_import_id', 'catalog_last_seen_at']),
  projection(legacyBefore, 'inventory_items'),
);
assert.deepEqual(projection(productionContract, 'product_variants'), projection(legacyBefore, 'product_variants'));
assert.deepEqual(
  projection(productionContract, 'sales_orders', ['version']),
  projection(legacyBefore, 'sales_orders'),
);
assert.deepEqual(
  projection(productionContract, 'sales_order_items', ['version']),
  projection(legacyBefore, 'sales_order_items'),
);

for (const [table, field, unsafe] of [
  ['product_groups', 'purchase_date', '2026-02-30'],
  ['product_groups', 'purchase_date', '2026/09/05'],
  ['purchase_batches', 'date', ' 2026-09-05'],
]) {
  const fixture = createLegacyStagingParityFixture();
  fixture.data[table][0][field] = unsafe;
  const before = structuredClone(fixture);
  await assert.rejects(() => applyStagingSchemaParityFixture(fixture), /UNSAFE_DATE_CAST/);
  assert.deepEqual(fixture, before);
}

{
  const fixture = createLegacyStagingParityFixture();
  fixture.data.sales_orders[0].buyer_name = null;
  const before = structuredClone(fixture);
  await assert.rejects(
    () => applyStagingSchemaParityFixture(fixture),
    /sales_orders_buyer_name_has_null/,
  );
  assert.deepEqual(fixture, before);
}

for (let failAfterStep = 1; failAfterStep <= 6; failAfterStep += 1) {
  const fixture = createLegacyStagingParityFixture();
  const before = structuredClone(fixture);
  await assert.rejects(
    () => applyStagingSchemaParityFixture(fixture, { failAfterStep }),
    /INJECTED_SCHEMA_PARITY_FAILURE/,
  );
  assert.deepEqual(fixture, before);
}

{
  const alreadyCanonical = structuredClone(productionContract);
  const before = structuredClone(alreadyCanonical);
  await assert.rejects(
    () => applyStagingSchemaParityFixture(alreadyCanonical),
    /STAGING_PARITY_PREFLIGHT/,
  );
  assert.deepEqual(alreadyCanonical, before);
}

assert.match(migrationSql, /^-- STAGING ONLY:/);
assert.match(migrationSql, /BEGIN;[\s\S]*staging_parity_preflight[\s\S]*ALTER TABLE/);
assert.match(migrationSql, /UNSAFE_DATE_CAST:product_groups\.purchase_date/);
assert.match(migrationSql, /UNSAFE_DATE_CAST:purchase_batches\.date/);
assert.match(migrationSql, /ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid\(\)/);
assert.match(migrationSql, /ADD CONSTRAINT inventory_items_pkey PRIMARY KEY \(id\)/);
assert.match(migrationSql, /ADD CONSTRAINT inventory_items_inventory_key_key UNIQUE \(inventory_key\)/);
assert.match(migrationSql, /DROP CONSTRAINT purchase_batches_product_group_id_fkey[\s\S]*ON DELETE CASCADE/);
assert.match(migrationSql, /DROP CONSTRAINT private_orders_product_group_id_fkey[\s\S]*ON DELETE CASCADE/);
assert.match(migrationSql, /ALTER COLUMN private_manual_adjustment DROP NOT NULL/);
assert.match(migrationSql, /ALTER COLUMN purchased_manual_adjustment DROP DEFAULT/);
assert.match(migrationSql, /ADD COLUMN version integer NOT NULL DEFAULT 1/);
assert.match(migrationSql, /ALTER COLUMN price DROP NOT NULL/);
assert.match(migrationSql, /CREATE INDEX idx_sales_orders_order_number[\s\S]*\(order_number\)/);
assert.match(migrationSql, /staging_parity_postflight[\s\S]*COMMIT;\s*$/);
assert.doesNotMatch(migrationSql, /\bTRUNCATE\b|\bDROP\s+TABLE\b|\bUPDATE\s+public\./i);
assert.doesNotMatch(migrationSql, /catalog_import_(runs|changes|quantity_snapshots)|018|019/);

const alteredTables = [...migrationSql.matchAll(/ALTER TABLE public\.([a-z_]+)/g)].map(match => match[1]);
assert.deepEqual(
  [...new Set(alteredTables)].sort(),
  [...STAGING_SCHEMA_PARITY_TABLES].sort(),
);

const inventorySave = providerSource.slice(
  providerSource.indexOf('const upsertData = allInventory.map'),
  providerSource.indexOf('async getSalesOrders'),
);
assert.match(inventorySave, /onConflict: 'inventory_key'/);
assert.doesNotMatch(inventorySave, /\bid\s*:\s*item\./);
assert.match(providerSource, /purchase_date: g\.purchase_date \|\| null/);
assert.match(providerSource, /date: b\.date \|\| null/);
assert.match(providerSource, /private_manual_adjustment: v\.private_manual_adjustment \?\? null/);
assert.match(providerSource, /purchased_manual_adjustment: v\.purchased_manual_adjustment \?\? null/);
assert.match(dbSource, /private_manual_adjustment\?: number \| null/);
assert.match(dbSource, /purchased_manual_adjustment\?: number \| null/);

const salesOrderSave = providerSource.slice(
  providerSource.indexOf('async saveSalesOrders'),
  providerSource.indexOf('async getSalesOrderItems'),
);
const salesItemSave = providerSource.slice(
  providerSource.indexOf('async saveSalesOrderItems'),
  providerSource.indexOf('async pullSalesOrders'),
);
assert.doesNotMatch(salesOrderSave, /\bversion\s*:/);
assert.doesNotMatch(salesItemSave, /\bversion\s*:/);

console.log('PASS audited legacy Staging fixture migrates to the Production column/constraint contract');
console.log('PASS unsafe date casts and nullable buyer violations fail closed with zero fixture change');
console.log('PASS inventory_key remains unique while generated Staging fixture UUIDs become the primary key');
console.log('PASS existing Product/Variant identity and adjustment values are unchanged');
console.log('PASS FK delete actions and sales constraint/index parity match the live Production audit');
console.log('PASS injected failures at every migration phase roll the complete fixture back');
console.log('PASS the SQL is one transaction, checks pre/post state, and does not weaken Restore schema checks');
console.log('PASS schema fingerprints ignore catalog array order but still reject definition changes');
console.log('PASS NEXT remains compatible with date, nullable adjustment, inventory UUID and sales version contracts');
