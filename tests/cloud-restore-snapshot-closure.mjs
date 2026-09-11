import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const ROOT = new URL('../', import.meta.url);
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const empty = () => ({
  inventory_items: [], product_groups: [], product_categories: [], product_variants: [], bundle_components: [],
  purchase_batches: [], purchase_batch_items: [], private_orders: [], private_order_items: [], sales_orders: [],
  sales_order_items: [], japan_packages: [], japan_package_items: [], outbound_shipments: [], outbound_shipment_items: [],
});

const rawFixture = () => {
  const data = empty();
  data.inventory_items.push({ id: uuid(16), inventory_key: 'closure::fixture::sku', myacg_item_code: 'SKU', product_title: 'Fixture', raw_variant_name: 'A', listing_type: 'normal', final_price: 1, myacg_available_quantity: 0, myacg_sold_quantity: 0, myacg_demand_quantity: 0, myacg_listed_at: '' });
  data.product_groups.push(
    { id: uuid(1), local_id: 'group-1', title: 'Active Group', priority: 'Medium' },
    { id: uuid(2), local_id: 'group-2', title: 'Soft Group', priority: 'Medium', deleted_at: '2026-01-01T00:00:00Z' },
  );
  data.product_categories.push({ id: uuid(3), local_id: 'category-1', product_group_id: uuid(1), title: 'Category', sort_order: 0 });
  data.product_variants.push(
    { id: uuid(4), local_id: 'variant-1', product_group_id: uuid(1), product_category_id: uuid(3), myacg_item_code: 'SKU', product_title: 'Fixture', variant_name: 'A', note: '' },
    { id: uuid(5), local_id: 'variant-2', product_group_id: uuid(2), product_category_id: null, myacg_item_code: 'SKU', product_title: 'Fixture', variant_name: 'B', note: '', deleted_at: '2026-01-01T00:00:00Z' },
    { id: uuid(6), local_id: 'variant-3', product_group_id: uuid(1), product_category_id: null, myacg_item_code: 'SKU', product_title: 'Fixture', variant_name: 'C', note: '' },
  );
  data.bundle_components.push({ id: uuid(7), bundle_variant_id: uuid(4), component_variant_id: uuid(5) });
  data.purchase_batches.push({ id: uuid(8), local_id: 'batch-1', product_group_id: uuid(2), name: 'Batch', currency: 'JPY', deleted_at: '2026-01-01T00:00:00Z' });
  data.purchase_batch_items.push({ id: uuid(9), local_id: 'batch-item-1', purchase_batch_id: uuid(8), product_variant_id: uuid(5), quantity: 1, cost: 10 });
  data.private_orders.push({ id: uuid(10), local_id: 'private-1', product_group_id: uuid(2), customer_name: 'Fixture', status: 'pending' });
  data.private_order_items.push({ id: uuid(11), local_id: 'private-item-1', private_order_id: uuid(10), product_variant_id: uuid(5), quantity: 1, amount: 10 });
  data.japan_packages.push({ id: uuid(12), title: 'Package', status: 'registered' });
  data.japan_package_items.push({ id: uuid(13), japan_package_id: uuid(12), product_group_id: uuid(2), product_variant_id: uuid(5), purchase_batch_id: uuid(8), purchase_batch_item_id: uuid(9), quantity: 1, checked: false });
  data.outbound_shipments.push({ id: uuid(14), title: 'Shipment', status: 'draft' });
  data.outbound_shipment_items.push({ id: uuid(15), outbound_shipment_id: uuid(14), japan_package_item_id: uuid(13), product_group_id: uuid(2), product_variant_id: uuid(5), quantity: 1, checked: false });
  return data;
};

const asCollections = tableData => Object.fromEntries([
  ['inventory', 'inventory_items'], ['productGroups', 'product_groups'], ['productCategories', 'product_categories'],
  ['productVariants', 'product_variants'], ['bundleComponents', 'bundle_components'], ['purchaseBatches', 'purchase_batches'],
  ['purchaseBatchItems', 'purchase_batch_items'], ['privateOrders', 'private_orders'], ['privateOrderItems', 'private_order_items'],
  ['salesOrders', 'sales_orders'], ['salesOrderItems', 'sales_order_items'], ['japanPackages', 'japan_packages'],
  ['japanPackageItems', 'japan_package_items'], ['outboundShipments', 'outbound_shipments'], ['outboundShipmentItems', 'outbound_shipment_items'],
].map(([collection, table]) => [collection, tableData[table].map(row => ({ ...row }))]));

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const domain = await server.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const raw = rawFixture();
  const seed = asCollections(raw);
  // A restore export using the raw source retains every canonical variant, including
  // rows that the UI dedupe projection would normally collapse.
  const full = await domain.buildCloudRestoreManifest(raw, raw);
  assert.equal(full.data.product_variants.length, 3);
  assert.equal(full.manifest.orphanCount, 0);
  assert.equal(full.manifest.duplicateCanonicalIdCount, 0);
  assert.equal(full.manifest.optionalMetadataMissingReferenceCount, 0);
  assert.equal(full.data.product_groups.find(row => row.id === uuid(2)).deleted_at, '2026-01-01T00:00:00Z');
  assert.equal(full.data.product_variants.find(row => row.id === uuid(5)).deleted_at, '2026-01-01T00:00:00Z');

  // Closure restores soft-deleted parents omitted from an active/UI seed.
  const reduced = clone(seed);
  reduced.productGroups = reduced.productGroups.filter(row => row.id === uuid(1));
  reduced.productVariants = reduced.productVariants.filter(row => row.id === uuid(4));
  reduced.purchaseBatches = [];
  reduced.privateOrders = [];
  reduced.purchaseBatchItems = [seed.purchaseBatchItems[0]];
  reduced.privateOrderItems = [seed.privateOrderItems[0]];
  const closed = await domain.buildCloudRestoreManifest(reduced, raw);
  assert.equal(closed.manifest.orphanCount, 0);
  assert.ok(closed.data.product_groups.some(row => row.id === uuid(2)));
  assert.ok(closed.data.product_variants.some(row => row.id === uuid(5)));
  assert.ok(closed.data.purchase_batches.some(row => row.id === uuid(8)));
  assert.ok(closed.data.private_orders.some(row => row.id === uuid(10)));
  assert.equal(closed.data.product_groups.find(row => row.id === uuid(2)).deleted_at, '2026-01-01T00:00:00Z');

  const optionalMissing = clone(seed);
  optionalMissing.japanPackageItems[0].product_variant_id = uuid(999);
  const optional = await domain.buildCloudRestoreManifest(optionalMissing, optionalMissing);
  assert.equal(optional.manifest.orphanCount, 0);
  assert.equal(optional.manifest.optionalMetadataMissingReferenceCount, 1);
  const optionalDoc = { schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION, data: optionalMissing, manifest: optional.manifest };
  await domain.prepareCloudRestoreSnapshot(optionalDoc);

  const requiredMissing = clone(seed);
  requiredMissing.purchaseBatchItems[0].purchase_batch_id = uuid(998);
  const required = await domain.buildCloudRestoreManifest(requiredMissing, requiredMissing);
  assert.equal(required.manifest.orphanCount, 1);
  await assert.rejects(
    () => domain.prepareCloudRestoreSnapshot({ schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION, data: requiredMissing, manifest: required.manifest }),
    error => error.code === 'ORPHAN_RELATION',
  );

  const duplicateRaw = clone(raw);
  duplicateRaw.product_variants.push(clone(duplicateRaw.product_variants[0]));
  await assert.rejects(() => domain.buildCloudRestoreManifest(duplicateRaw, duplicateRaw), error => error.code === 'DUPLICATE_CANONICAL_ID');

  const expectedFingerprint = full.manifest.snapshotFingerprint;
  for (let round = 0; round < 30; round += 1) {
    const result = await domain.buildCloudRestoreManifest(asCollections(raw), raw);
    assert.equal(result.manifest.snapshotFingerprint, expectedFingerprint);
    assert.equal(result.manifest.orphanCount, 0);
    assert.equal(result.data.product_variants.length, 3);
  }
  for (let round = 0; round < 30; round += 1) {
    const result = await domain.buildCloudRestoreManifest(reduced, raw);
    assert.equal(result.manifest.orphanCount, 0);
    assert.equal(result.data.product_groups.filter(row => row.deleted_at).length, 1);
    assert.ok(result.data.product_variants.some(row => row.id === uuid(5)));
  }
  for (let round = 0; round < 30; round += 1) {
    const result = await domain.buildCloudRestoreManifest(raw, raw);
    assert.equal(result.data.product_variants.length, 3);
    assert.equal(result.manifest.duplicateVariantIdCount, 0);
  }
  for (let round = 0; round < 30; round += 1) {
    const result = await domain.buildCloudRestoreManifest(reduced, raw);
    const doc = { schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION, data: asCollections(result.data), manifest: result.manifest };
    const prepared = await domain.prepareCloudRestoreSnapshot(doc);
    assert.equal(prepared.manifest.orphanCount, result.manifest.orphanCount);
    assert.equal(prepared.manifest.optionalMetadataMissingReferenceCount, result.manifest.optionalMetadataMissingReferenceCount);
  }
  for (let round = 0; round < 30; round += 1) {
    const fixture = clone(seed);
    fixture.japanPackageItems[0].product_variant_id = uuid(900 + round);
    const result = await domain.buildCloudRestoreManifest(fixture, fixture);
    assert.equal(result.manifest.orphanCount, 0);
    assert.equal(result.manifest.optionalMetadataMissingReferenceCount, 1);
    await domain.prepareCloudRestoreSnapshot({
      schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION,
      data: fixture,
      manifest: result.manifest,
    });
  }
  for (let round = 0; round < 30; round += 1) {
    const first = await domain.buildCloudRestoreManifest(raw, raw);
    const second = await domain.buildCloudRestoreManifest(raw, raw);
    assert.equal(first.manifest.snapshotFingerprint, second.manifest.snapshotFingerprint);
    assert.equal(first.manifest.relationshipHash, second.manifest.relationshipHash);
  }
  const sql = readFileSync(new URL('../supabase/sql/024_cloud_restore_snapshot_export.sql', import.meta.url), 'utf8');
  assert.equal((sql.match(/^begin;$/gimu) || []).length, 1);
  assert.equal((sql.match(/^commit;$/gimu) || []).length, 1);
  assert.match(sql, /create or replace function public\.erp_export_cloud_restore_snapshot\(\)/u);
  assert.match(sql, /security definer[\s\S]+set search_path = pg_catalog, public, extensions/u);
  assert.match(sql, /public\.is_owner\(v_actor\)/u);
  assert.match(sql, /grant execute on function public\.erp_export_cloud_restore_snapshot\(\) to authenticated/u);
  assert.doesNotMatch(sql, /service_role|twzpqyesbtnfxdkorluf|insert\s+into|update\s+.+\s+set|delete\s+from/iu);
} finally {
  await server.close();
}

console.log('PASS Cloud Restore snapshot closure, raw export contract, relation parity, and 180-round deterministic regression');
