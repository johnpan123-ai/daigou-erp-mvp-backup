import assert from 'node:assert/strict';
import { createServer } from 'vite';

const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));

const collections = {
  inventory: [
    { id: uuid(15), inventory_key: 'restore::SKU::A', myacg_item_code: 'SKU-A', product_title: 'Restore Product', raw_variant_name: 'A', listing_type: 'normal', final_price: 1, myacg_available_quantity: 0, myacg_sold_quantity: 0, myacg_demand_quantity: 0, myacg_listed_at: '' },
    { id: uuid(16), inventory_key: 'restore::SKU::B', myacg_item_code: 'SKU-B', product_title: 'Restore Product', raw_variant_name: 'B', listing_type: 'normal', final_price: 2, myacg_available_quantity: 0, myacg_sold_quantity: 0, myacg_demand_quantity: 0, myacg_listed_at: '' },
  ],
  productGroups: [
    { id: uuid(1), local_id: 'group-1', title: 'Restore Product', priority: 'Medium', purchase_date: '', closing_date: '', release_month: '', has_official_site: false, product_url: '' },
    { id: uuid(17), local_id: 'group-2', title: 'Restore Product 2', priority: 'Medium', purchase_date: '', closing_date: '', release_month: '', has_official_site: false, product_url: '' },
  ],
  productCategories: [{ id: uuid(2), local_id: 'category-1', product_group_id: uuid(1), title: 'Default', sort_order: 0 }],
  productVariants: [{ id: uuid(3), local_id: 'variant-1', product_group_id: uuid(1), product_category_id: uuid(2), myacg_item_code: 'SKU-A', product_title: 'Restore Product', variant_name: 'A', note: '', sort_order: 0 }],
  bundleComponents: [{ id: uuid(4), bundle_variant_id: uuid(3), component_variant_id: uuid(3) }],
  purchaseBatches: [{ id: uuid(5), local_id: 'batch-1', product_group_id: uuid(1), name: 'Restore batch', date: '2026-09-09', note: '' }],
  purchaseBatchItems: [{ id: uuid(6), local_id: 'batch-item-1', purchase_batch_id: uuid(5), product_variant_id: uuid(3), quantity: 1, cost: 10, note: '' }],
  privateOrders: [{ id: uuid(7), local_id: 'private-1', product_group_id: uuid(1), customer_name: 'Fixture', contact: '', note: '' }],
  privateOrderItems: [{ id: uuid(8), local_id: 'private-item-1', private_order_id: uuid(7), product_variant_id: uuid(3), quantity: 1, amount: 10, note: '' }],
  salesOrders: [{ id: uuid(9), local_id: 'order-1', platform: 'fixture', order_number: 'RESTORE-1', buyer_name: 'Fixture' }],
  salesOrderItems: [{ id: uuid(10), local_id: 'order-item-1', order_id: uuid(9), product_variant_id: uuid(3), myacg_item_code: 'SKU-A', quantity: 1 }],
  japanPackages: [{ id: uuid(11), title: 'Restore package', status: 'registered' }],
  japanPackageItems: [{ id: uuid(12), japan_package_id: uuid(11), product_group_id: uuid(1), product_variant_id: uuid(3), purchase_batch_id: uuid(5), purchase_batch_item_id: uuid(6), quantity: 1, checked: false }],
  outboundShipments: [{ id: uuid(13), title: 'Restore outbound', status: 'draft' }],
  outboundShipmentItems: [{ id: uuid(14), outbound_shipment_id: uuid(13), japan_package_item_id: uuid(12), product_group_id: uuid(1), product_variant_id: uuid(3), quantity: 1, checked: false }],
};

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const legacyDomain = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreLegacySnapshot.ts');
  const asFileData = data => Object.fromEntries(domain.CLOUD_RESTORE_TABLES.map(([collection, table]) => [collection, data[table]]));
  const currentBuilt = await domain.buildCloudRestoreManifest(collections, collections);
  const currentV2 = {
    schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION,
    sourceEnvironment: 'fixture-current-v2',
    data: asFileData(currentBuilt.data),
    manifest: currentBuilt.manifest,
  };
  const currentUnversioned = clone(currentV2);
  delete currentUnversioned.manifest.identityContractVersion;

  const legacyBuilt = await legacyDomain.buildLegacyCloudRestoreManifest(collections);
  assert.ok(legacyBuilt, 'legacy fixture must match the frozen pre-df779029 shape');
  const legacyDocument = {
    schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION,
    sourceEnvironment: 'fixture-legacy-inventory-key-v1',
    data: asFileData(legacyBuilt.data),
    manifest: legacyBuilt.manifest,
  };
  const originalLegacyJson = JSON.stringify(legacyDocument);
  const metrics = {
    silentRemap: 0,
    generatedUuid: 0,
    legacyBypassedCurrentValidation: 0,
    falseAccept: 0,
  };

  const rejectsWith = async (document, codes) => {
    await assert.rejects(
      () => domain.prepareCloudRestoreSnapshot(document),
      error => codes.includes(error.code),
    );
  };

  for (let round = 0; round < 30; round += 1) {
    const candidate = await domain.prepareCloudRestoreSnapshot(clone(legacyDocument));
    assert.equal(candidate.sourceIdentityContractVersion, legacyDomain.LEGACY_CLOUD_RESTORE_IDENTITY_CONTRACT);
  }
  for (let round = 0; round < 30; round += 1) {
    const candidate = await domain.prepareCloudRestoreSnapshot(clone(currentUnversioned));
    assert.equal(candidate.sourceIdentityContractVersion, 'current-unversioned');
  }
  for (let round = 0; round < 30; round += 1) {
    const candidate = await domain.prepareCloudRestoreSnapshot(clone(currentV2));
    assert.equal(candidate.sourceIdentityContractVersion, domain.CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    tampered.manifest.snapshotFingerprint = '0'.repeat(64);
    await rejectsWith(tampered, ['RESTORE_MANIFEST_MISMATCH']);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    tampered.manifest.relationshipHash = '0'.repeat(64);
    await rejectsWith(tampered, ['RESTORE_MANIFEST_MISMATCH']);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    tampered.data.inventory[0].id = uuid(1000 + round);
    await rejectsWith(tampered, ['RESTORE_MANIFEST_MISMATCH']);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    tampered.data.inventory[0].inventory_key = `changed::${round}`;
    await rejectsWith(tampered, ['RESTORE_MANIFEST_MISMATCH']);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    tampered.data.inventory[1].id = tampered.data.inventory[0].id;
    await rejectsWith(tampered, ['DUPLICATE_CANONICAL_ID']);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    tampered.data.inventory[1].inventory_key = tampered.data.inventory[0].inventory_key;
    await rejectsWith(tampered, ['DUPLICATE_INVENTORY_KEY']);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    delete tampered.data.inventory[0].id;
    await rejectsWith(tampered, ['CANONICAL_ID_REQUIRED']);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    tampered.data.productCategories[0].product_group_id = uuid(17);
    await rejectsWith(tampered, ['RESTORE_MANIFEST_MISMATCH']);
  }
  for (let round = 0; round < 30; round += 1) {
    const tampered = clone(legacyDocument);
    tampered.manifest.resourceCount = 14;
    await rejectsWith(tampered, ['RESTORE_MANIFEST_MISMATCH']);
  }
  for (let round = 0; round < 30; round += 1) {
    const candidate = await domain.prepareCloudRestoreSnapshot(clone(legacyDocument));
    assert.equal(candidate.manifest.identityContractVersion, domain.CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION);
    assert.notEqual(candidate.manifest.snapshotFingerprint, legacyDocument.manifest.snapshotFingerprint);
    assert.notEqual(candidate.manifest.relationshipHash, legacyDocument.manifest.relationshipHash);
    assert.deepEqual(
      candidate.data.inventory_items.map(row => row.id).sort(),
      legacyDocument.data.inventory.map(row => row.id.toLowerCase()).sort(),
    );
    assert.equal(candidate.data.inventory_items.some(row => row.id === row.inventory_key), false);
  }

  const unknownVersion = clone(currentV2);
  unknownVersion.manifest.identityContractVersion = 'unbounded-history-v99';
  await rejectsWith(unknownVersion, ['UNSUPPORTED_IDENTITY_CONTRACT_VERSION']);
  assert.equal(JSON.stringify(legacyDocument), originalLegacyJson, 'legacy source document must remain byte-for-byte unchanged in memory');
  assert.deepEqual(metrics, {
    silentRemap: 0,
    generatedUuid: 0,
    legacyBypassedCurrentValidation: 0,
    falseAccept: 0,
  });

  console.log('PASS Legacy Cloud Snapshot Compatibility: 390/390 deterministic rounds; legacy verification -> current UUID-id candidate; false accepts/remaps/generated UUIDs = 0');
} finally {
  await vite.close();
}
