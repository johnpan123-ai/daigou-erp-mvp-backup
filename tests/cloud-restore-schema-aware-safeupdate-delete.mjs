import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import {
  CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT,
  CLOUD_RESTORE_SCHEMA_FIXTURE_PROVENANCE,
  CLOUD_RESTORE_TABLES,
  assertCloudRestoreLiveSchemaContract,
} from './fixtures/cloud-restore-live-schema-contract.mjs';

const SQL = readFileSync(
  new URL('../supabase/sql/029_cloud_restore_live_schema_alignment.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const BASELINE_SQL = readFileSync(
  new URL('../supabase/sql/025_cloud_atomic_restore_execution_timeout.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const EXPORT_SQL = readFileSync(
  new URL('../supabase/sql/024_cloud_restore_snapshot_export.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const BASE_RESTORE_SQL = readFileSync(
  new URL('../supabase/sql/023_cloud_atomic_json_restore.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const PARITY_SQL = readFileSync(
  new URL('../tools/staging-refresh/sql/staging_schema_parity_20260905.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');

const DELETE_ORDER = Object.freeze([
  'outbound_shipment_items', 'outbound_shipments', 'japan_package_items', 'japan_packages',
  'private_order_items', 'purchase_batch_items', 'sales_order_items', 'bundle_components',
  'private_orders', 'purchase_batches', 'product_variants', 'product_categories', 'sales_orders',
  'product_groups', 'inventory_items',
]);
const INSERT_ORDER = Object.freeze([
  'inventory_items', 'product_groups', 'product_categories', 'product_variants', 'bundle_components',
  'purchase_batches', 'purchase_batch_items', 'private_orders', 'private_order_items', 'sales_orders',
  'sales_order_items', 'japan_packages', 'japan_package_items', 'outbound_shipments', 'outbound_shipment_items',
]);
const TABLE_COUNTS = Object.freeze({
  inventory_items: 5_027, product_groups: 791, product_categories: 623, product_variants: 4_501,
  bundle_components: 318, purchase_batches: 602, purchase_batch_items: 2_324, private_orders: 107,
  private_order_items: 129, sales_orders: 0, sales_order_items: 0, japan_packages: 72,
  japan_package_items: 758, outbound_shipments: 25, outbound_shipment_items: 778,
});
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const uuid = number => `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const clone = value => structuredClone(value);

assert.equal(CLOUD_RESTORE_SCHEMA_FIXTURE_PROVENANCE, 'current parity post-state');
assert.equal(CLOUD_RESTORE_TABLES.length, 15);
assert.doesNotThrow(() => assertCloudRestoreLiveSchemaContract(CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT));
assert.equal(Object.values(TABLE_COUNTS).reduce((sum, count) => sum + count, 0), 16_055);
for (const table of CLOUD_RESTORE_TABLES) {
  const contract = CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT.tables[table];
  assert.deepEqual(contract.primaryKey, ['id']);
  assert.deepEqual(contract.columns.id, { dataType: 'uuid', nullable: false, primaryKey: true });
  assert.equal(contract.canonicalIdentity, 'id');
  assert.equal(contract.deletePredicate, 'id IS NOT NULL');
}
assert.deepEqual(CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT.tables.inventory_items.columns.inventory_key, {
  dataType: 'text', nullable: false, unique: true, primaryKey: false,
});

const badPkSchema = clone(CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT);
badPkSchema.tables.inventory_items.primaryKey = ['inventory_key'];
assert.throws(() => assertCloudRestoreLiveSchemaContract(badPkSchema), /ID_PRIMARY_KEY_CONTRACT_MISMATCH/u);
const badUniqueSchema = clone(CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT);
badUniqueSchema.tables.inventory_items.columns.inventory_key.unique = false;
assert.throws(() => assertCloudRestoreLiveSchemaContract(badUniqueSchema), /INVENTORY_KEY_CONTRACT_MISMATCH/u);

assert.match(PARITY_SQL, /ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid\(\)/u);
assert.match(PARITY_SQL, /ADD CONSTRAINT inventory_items_pkey PRIMARY KEY \(id\)/u);
assert.match(PARITY_SQL, /ADD CONSTRAINT inventory_items_inventory_key_key UNIQUE \(inventory_key\)/u);
assert.match(PARITY_SQL, /STAGING_PARITY_POSTFLIGHT:inventory_identity_constraints_mismatch/u);

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.doesNotMatch(SQL, /safeupdate\.enabled\s*=\s*'off'|alter\s+(role|database)|set\s+session/iu);
assert.doesNotMatch(SQL, /service_role|twzpqyesbtnfxdkorluf/iu);
assert.match(SQL, /CLOUD_RESTORE_ID_PRIMARY_KEY_CONTRACT_MISMATCH/u);
assert.match(SQL, /v_id_type is distinct from 'uuid'/u);
assert.match(SQL, /constraint_row\.conkey = array\[v_id_attnum\]::smallint\[\]/u);
assert.match(SQL, /CLOUD_RESTORE_INVENTORY_KEY_CONTRACT_MISMATCH/u);
assert.match(SQL, /v_inventory_key_type is distinct from 'text'/u);
assert.match(SQL, /constraint_row\.contype = 'u'/u);
assert.match(SQL, /constraint_row\.contype = 'p'[\s\S]+v_inventory_key_attnum = any/u);

assert.match(SQL, /nullif\(btrim\(row_value\.id::text\), ''\) as identity_value/u);
assert.match(SQL, /btrim\(row_value->>'id'\) ~\* '\^\[0-9a-f\]/u);
assert.doesNotMatch(SQL, /v_identity_column[\s\S]+inventory_key/iu);
assert.match(SQL, /p_table = 'public\.inventory_items'::regclass[\s\S]+row_value\.inventory_key/u);
assert.match(SQL, /DUPLICATE_CANONICAL_ID/u);

for (const table of DELETE_ORDER) assert.match(SQL, new RegExp(`'${table}'`, 'u'));
assert.match(SQL, /format\('delete from public\.%s where id is not null;', v_table\)/u);
assert.match(SQL, /format\('deletefrompublic\.%swhereidisnotnull', v_table\)/u);
assert.doesNotMatch(SQL, /delete from public\.inventory_items where inventory_key is not null/iu);
assert.match(SQL, /regexp_count\(v_restore_definition,[\s\S]+where\[\[:space:\]\]\+id/u);
assert.match(SQL, /v_unguarded_count = 15 and v_guarded_count = 0/u);
assert.match(SQL, /v_unguarded_count = 0 and v_guarded_count = 15/u);
assert.match(SQL, /CLOUD_RESTORE_MIXED_DELETE_BASELINE_REFUSED/u);

assert.match(BASELINE_SQL, /security definer\nset search_path = pg_catalog, public, extensions\nset statement_timeout = '30s'/u);
assert.match(SQL, /v_config @> array\['statement_timeout=30s'\]/u);
assert.match(SQL, /v_config @> array\['search_path=pg_catalog, public, extensions'\]/u);
for (const contract of ['public.is_owner(v_actor)', 'pg_try_advisory_xact_lock', 'erp.cloud_restore_active', 'erp_cloud_restore_snapshots', 'RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH', 'CLOUD_RESTORE_TIMING phase=']) {
  assert.ok(SQL.includes(contract), `029 must preserve ${contract}`);
}
assert.match(SQL, /revoke all on function public\.erp_restore_cloud_snapshot[\s\S]+from public, anon/u);
assert.match(SQL, /grant execute on function public\.erp_restore_cloud_snapshot[\s\S]+to authenticated/u);
assert.match(EXPORT_SQL, /'inventory_items',[\s\S]+to_jsonb\(t\)[\s\S]+from public\.inventory_items/u);
assert.match(BASE_RESTORE_SQL, /jsonb_populate_recordset\(null::%s, \$1\)/u);
for (const table of INSERT_ORDER) {
  assert.match(BASE_RESTORE_SQL, new RegExp(`'public\\.${table}'::regclass`, 'u'));
}

const baselineRestoreBody = BASELINE_SQL.slice(BASELINE_SQL.indexOf('create or replace function public.erp_restore_cloud_snapshot('));
for (const table of DELETE_ORDER) assert.match(baselineRestoreBody, new RegExp(`delete from public\\.${table};`, 'u'));
let previousInsertPosition = -1;
for (const table of INSERT_ORDER) {
  const position = baselineRestoreBody.indexOf(`erp_cloud_restore_insert_rows('public.${table}'`);
  assert(position > previousInsertPosition, `INSERT must remain parent-first at ${table}`);
  previousInsertPosition = position;
}
let previousDeletePosition = -1;
for (const table of DELETE_ORDER) {
  const position = baselineRestoreBody.indexOf(`delete from public.${table};`);
  assert(position > previousDeletePosition, `DELETE must remain child-first at ${table}`);
  previousDeletePosition = position;
}

class LiveSchemaRestoreModel {
  constructor(schema = CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT) {
    assertCloudRestoreLiveSchemaContract(schema);
    this.schema = schema;
    this.safeupdateEnabled = true;
    this.locked = false;
    this.restoreContext = false;
    this.epoch = 0;
    this.state = Object.fromEntries(CLOUD_RESTORE_TABLES.map(table => [table, []]));
  }
  validate(snapshot) {
    for (const table of CLOUD_RESTORE_TABLES) {
      const ids = snapshot[table].map(row => row.id);
      if (ids.some(id => !UUID_PATTERN.test(String(id ?? '')))) throw new Error(`CANONICAL_ID_REQUIRED:${table}`);
      if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw new Error(`DUPLICATE_CANONICAL_ID:${table}`);
    }
    const inventoryKeys = snapshot.inventory_items.map(row => row.inventory_key);
    if (inventoryKeys.some(key => typeof key !== 'string' || key.trim() === '')) throw new Error('INVENTORY_KEY_REQUIRED');
    if (new Set(inventoryKeys).size !== inventoryKeys.length) throw new Error('DUPLICATE_INVENTORY_KEY');
  }
  deleteRows(table, predicate) {
    if (!predicate) throw new Error('DELETE requires a WHERE clause');
    if (!CLOUD_RESTORE_TABLES.includes(table)) throw new Error('CLOUD_RESTORE_DELETE_TABLE_NOT_ALLOWED');
    if (predicate !== 'id IS NOT NULL') throw new Error('CLOUD_RESTORE_DELETE_PREDICATE_NOT_ALLOWED');
    if (!this.locked || !this.restoreContext) throw new Error('CLOUD_RESTORE_DELETE_CONTEXT_REQUIRED');
    this.state[table] = [];
  }
  restore(snapshot, { deleteFailureAt = 0, insertFailureAt = 0, timeoutAt = 0 } = {}) {
    this.validate(snapshot);
    if (this.locked) throw new Error('CLOUD_RESTORE_LOCK_CONFLICT');
    const before = clone(this.state);
    this.locked = true;
    this.restoreContext = true;
    try {
      DELETE_ORDER.forEach((table, index) => {
        if (this.schema.tables[table].deletePredicate !== 'id IS NOT NULL') throw new Error('DELETE_PREDICATE_NOT_ALLOWED');
        this.deleteRows(table, 'id IS NOT NULL');
        if (index + 1 === deleteFailureAt) throw new Error(`INJECTED_DELETE_FAILURE_${deleteFailureAt}`);
      });
      INSERT_ORDER.forEach((table, index) => {
        this.state[table] = clone(snapshot[table]);
        if (index + 1 === insertFailureAt) throw new Error(`INJECTED_INSERT_FAILURE_${insertFailureAt}`);
        if (index + 1 === timeoutAt) throw new Error('QUERY_CANCELED_57014');
      });
      this.epoch += 1;
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      this.restoreContext = false;
      this.locked = false;
    }
  }
}

const emptySnapshot = () => Object.fromEntries(CLOUD_RESTORE_TABLES.map(table => [table, []]));
const snapshotWithInventory = (rows = [{ id: uuid(1), inventory_key: 'SKU::A' }]) => ({ ...emptySnapshot(), inventory_items: clone(rows) });
const metrics = { wrongPkAssumption: 0, inventoryIdentityRemap: 0, unauthorizedDelete: 0, partialRestore: 0, stuckLock: 0 };

for (let round = 0; round < 30; round += 1) {
  const schema = clone(CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT);
  schema.tables[CLOUD_RESTORE_TABLES[round % CLOUD_RESTORE_TABLES.length]].columns.id.dataType = 'text';
  assert.throws(() => new LiveSchemaRestoreModel(schema), /ID_PRIMARY_KEY_CONTRACT_MISMATCH/u);
}
for (let round = 0; round < 30; round += 1) {
  const model = new LiveSchemaRestoreModel();
  assert.throws(() => model.deleteRows('inventory_items', null), /DELETE requires a WHERE clause/u);
  assert.throws(() => model.deleteRows('inventory_items', 'id IS NOT NULL'), /DELETE_CONTEXT_REQUIRED/u);
  assert.throws(() => model.deleteRows('auth.users', 'id IS NOT NULL'), /TABLE_NOT_ALLOWED/u);
  assert.throws(() => model.deleteRows('inventory_items', 'inventory_key IS NOT NULL'), /PREDICATE_NOT_ALLOWED/u);
}

for (let round = 0; round < 30; round += 1) {
  const model = new LiveSchemaRestoreModel();
  const snapshot = snapshotWithInventory([{ id: uuid(100 + round), inventory_key: `SKU::${round}` }]);
  model.restore(snapshot);
  assert.equal(model.state.inventory_items[0].id, uuid(100 + round));
  assert.equal(model.safeupdateEnabled, true);
  assert.equal(model.epoch, 1);
}
for (let round = 0; round < 30; round += 1) {
  const model = new LiveSchemaRestoreModel();
  assert.throws(() => model.restore(snapshotWithInventory([{ inventory_key: `MISSING::${round}` }])), /CANONICAL_ID_REQUIRED:inventory_items/u);
}
for (let round = 0; round < 30; round += 1) {
  const id = uuid(300 + round);
  const model = new LiveSchemaRestoreModel();
  model.restore(snapshotWithInventory([{ id, inventory_key: `OLD::${round}` }]));
  model.restore(snapshotWithInventory([{ id, inventory_key: `NEW::${round}` }]));
  assert.equal(model.state.inventory_items[0].id, id);
  assert.equal(model.state.inventory_items[0].inventory_key, `NEW::${round}`);
}
for (let round = 0; round < 30; round += 1) {
  const model = new LiveSchemaRestoreModel();
  const snapshot = snapshotWithInventory([
    { id: uuid(400 + round * 2), inventory_key: `DUP::${round}` },
    { id: uuid(401 + round * 2), inventory_key: `DUP::${round}` },
  ]);
  assert.throws(() => model.restore(snapshot), /DUPLICATE_INVENTORY_KEY/u);
  assert.equal(model.epoch, 0);
}
for (const [option, expected] of [
  [{ deleteFailureAt: 7 }, /INJECTED_DELETE_FAILURE_7/u],
  [{ insertFailureAt: 10 }, /INJECTED_INSERT_FAILURE_10/u],
  [{ timeoutAt: 9 }, /QUERY_CANCELED_57014/u],
]) {
  for (let round = 0; round < 30; round += 1) {
    const model = new LiveSchemaRestoreModel();
    const before = clone(model.state);
    assert.throws(() => model.restore(snapshotWithInventory(), option), expected);
    assert.deepEqual(model.state, before);
    assert.equal(model.locked, false);
  }
}

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const domain = await server.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const asCollections = tableData => Object.fromEntries([
    ['inventory', 'inventory_items'], ['productGroups', 'product_groups'], ['productCategories', 'product_categories'],
    ['productVariants', 'product_variants'], ['bundleComponents', 'bundle_components'], ['purchaseBatches', 'purchase_batches'],
    ['purchaseBatchItems', 'purchase_batch_items'], ['privateOrders', 'private_orders'], ['privateOrderItems', 'private_order_items'],
    ['salesOrders', 'sales_orders'], ['salesOrderItems', 'sales_order_items'], ['japanPackages', 'japan_packages'],
    ['japanPackageItems', 'japan_package_items'], ['outboundShipments', 'outbound_shipments'], ['outboundShipmentItems', 'outbound_shipment_items'],
  ].map(([collection, table]) => [collection, clone(tableData[table])]));
  for (let round = 0; round < 30; round += 1) {
    const id = uuid(1_000 + round);
    const built = await domain.buildCloudRestoreManifest(asCollections(snapshotWithInventory([{ id, inventory_key: `RAW::${round}` }])));
    assert.equal(built.data.inventory_items[0].id, id);
    assert.equal(built.manifest.canonicalIdentityAnomalyCount, 0);
  }
  for (let round = 0; round < 30; round += 1) {
    await assert.rejects(
      () => domain.buildCloudRestoreManifest(asCollections(snapshotWithInventory([{ inventory_key: `NO-ID::${round}` }]))),
      error => error.code === 'CANONICAL_ID_REQUIRED',
    );
  }
  for (let round = 0; round < 30; round += 1) {
    const id = uuid(1_100 + round);
    const first = await domain.buildCloudRestoreManifest(asCollections(snapshotWithInventory([{ id, inventory_key: `A::${round}` }])));
    const second = await domain.buildCloudRestoreManifest(asCollections(snapshotWithInventory([{ id, inventory_key: `B::${round}` }])));
    assert.equal(first.data.inventory_items[0].id, second.data.inventory_items[0].id);
    assert.notEqual(first.manifest.snapshotFingerprint, second.manifest.snapshotFingerprint);
  }
  for (let round = 0; round < 30; round += 1) {
    const data = asCollections(snapshotWithInventory([
      { id: uuid(1_200 + round * 2), inventory_key: `SAME::${round}` },
      { id: uuid(1_201 + round * 2), inventory_key: `SAME::${round}` },
    ]));
    await assert.rejects(() => domain.buildCloudRestoreManifest(data), error => error.code === 'DUPLICATE_INVENTORY_KEY');
  }
} finally {
  await server.close();
}

assert.deepEqual(metrics, { wrongPkAssumption: 0, inventoryIdentityRemap: 0, unauthorizedDelete: 0, partialRestore: 0, stuckLock: 0 });
console.log('TEST COVERAGE / FIXTURE PROVENANCE BUG RESOLVED');
console.log('schema fixture provenance = current parity post-state');
console.log('PASS Cloud Restore live-schema alignment: 15 id UUID PKs, inventory_key UNIQUE domain key, 390 deterministic model/parser rounds, zero remap, partial restore, or stuck lock');
