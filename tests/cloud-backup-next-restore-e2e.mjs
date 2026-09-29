import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const origin = process.env.CLOUD_NEXT_E2E_ORIGIN || 'http://127.0.0.1:4394';
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const actorId = uuid(900);
const fixturePath = join(tmpdir(), `cloud-backup-next-source-exact-${process.pid}.json`);
const localFixture = JSON.parse(readFileSync('tests/fixtures/core-regression.json', 'utf8'));

const moduleServer = await createServer({
  configFile: false,
  cacheDir: join(tmpdir(), `cloud-backup-next-module-${process.pid}`),
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  appType: 'custom',
});

let sourceExactDocument;
let sourceExactPreview;
let realPreview = null;
try {
  const restore = await moduleServer.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const bridge = await moduleServer.ssrLoadModule('/src/providers/cloud/cloudBackupToNext.ts');
  const seed = Object.fromEntries(restore.CLOUD_RESTORE_TABLES.map(([collection]) => [collection, []]));
  const withAudit = row => ({ ...row, updated_by: actorId, created_at: '2026-09-29T00:00:00.000Z', updated_at: '2026-09-29T00:00:00.000Z' });

  seed.inventory.push(withAudit({
    id: uuid(1), inventory_key: 'cloud::next::sku-1', myacg_item_code: 'SKU-CLOUD-1',
    product_title: 'Cloud → NEXT 商品', raw_variant_name: '通常版', listing_type: '預購',
    final_price: 100, myacg_available_quantity: 0, myacg_sold_quantity: 3,
    myacg_listed_at: '2026-09-29T00:00:00.000Z',
  }));
  seed.productGroups.push(withAudit({
    id: uuid(10), local_id: 'cloud-group-local', title: 'Cloud → NEXT 商品', priority: 'Medium',
    purchase_date: '2026-09-29', closing_date: '', release_month: '', has_official_site: false,
    product_url: '', show_in_purchase_list: true,
  }));
  seed.productCategories.push(withAudit({
    id: uuid(11), local_id: 'cloud-category-local', product_group_id: uuid(10), title: '一般', sort_order: 0,
  }));
  seed.productVariants.push(withAudit({
    id: uuid(12), local_id: 'cloud-variant-local', product_group_id: uuid(10), product_category_id: uuid(11),
    myacg_item_code: 'SKU-CLOUD-1', product_title: 'Cloud → NEXT 商品', variant_name: '通常版',
    myacg_auto_quantity: 3, effective_myacg_quantity: 3, myacg_manual_adjustment: 0,
    waca_auto_quantity: 11, waca_manual_adjustment: 2, note: '', sort_order: 0,
  }));
  seed.bundleComponents.push(withAudit({ id: uuid(13), bundle_variant_id: uuid(12), component_variant_id: uuid(12) }));
  seed.purchaseBatches.push(withAudit({
    id: uuid(20), local_id: 'cloud-batch-local', product_group_id: uuid(10), name: 'Cloud Batch',
    date: '2026-09-29', note: '', currency: 'JPY',
  }));
  seed.purchaseBatchItems.push(withAudit({
    id: uuid(21), local_id: 'cloud-batch-item-local', purchase_batch_id: uuid(20),
    product_variant_id: uuid(12), quantity: 4, cost: 100, note: '',
  }));
  seed.privateOrders.push(withAudit({
    id: uuid(30), local_id: 'cloud-private-local', product_group_id: uuid(10), customer_name: '測試',
    contact: '', note: '', status: 'pending',
  }));
  seed.privateOrderItems.push(withAudit({
    id: uuid(31), local_id: 'cloud-private-item-local', private_order_id: uuid(30),
    product_variant_id: uuid(12), quantity: 1, amount: 100, note: '',
  }));
  seed.salesOrders.push(withAudit({
    id: uuid(40), local_id: 'CLOUD-ORDER-1', platform: 'myacg', order_number: 'CLOUD-ORDER-1', buyer_name: '測試',
  }));
  seed.salesOrderItems.push(withAudit({
    id: uuid(41), local_id: 'cloud-order-item-local', order_id: uuid(40), product_variant_id: uuid(12),
    myacg_item_code: 'SKU-CLOUD-1', product_name: 'Cloud → NEXT 商品', variant_name: '通常版',
    quantity: 3, price: 100, amount: 300, order_status: '完成',
  }));
  seed.importBatches.push(withAudit({
    id: uuid(42), local_id: 'cloud-import-local', platform: 'myacg', file_name: 'cloud-source.xls',
    imported_at: '2026-09-29T00:00:00.000Z', total_rows: 1, valid_rows: 1,
    skipped_cancelled_rows: 0, new_order_items: 1, skipped_duplicate_items: 0,
    created_groups_count: 1, completed_group_skus_count: 1, catalog_missing_count: 0,
    note: '', details: { source: 'cloud' },
  }));
  seed.japanPackages.push(withAudit({ id: uuid(50), title: 'Cloud Package', status: 'registered', note: '' }));
  seed.japanPackageItems.push(withAudit({
    id: uuid(51), japan_package_id: uuid(50), product_group_id: uuid(10), product_variant_id: uuid(12),
    purchase_batch_id: uuid(20), purchase_batch_item_id: uuid(21), product_title: 'Cloud → NEXT 商品',
    variant_name: '通常版', sku: 'SKU-CLOUD-1', quantity: 1, checked: false,
  }));
  seed.outboundShipments.push(withAudit({ id: uuid(60), title: 'Cloud Shipment', status: 'draft', note: '' }));
  seed.outboundShipmentItems.push(withAudit({
    id: uuid(61), outbound_shipment_id: uuid(60), japan_package_item_id: uuid(51),
    product_group_id: uuid(10), product_variant_id: uuid(12), product_title: 'Cloud → NEXT 商品',
    variant_name: '通常版', sku: 'SKU-CLOUD-1', quantity: 1, checked: false,
  }));
  seed.dashboardCategoryImages.push(withAudit({
    id: uuid(70), category_key: 'hololive', image_url: 'https://example.invalid/legacy.png',
    storage_path: 'dashboard/legacy.png', local_id: 'legacy-dashboard-image',
  }));

  const feature = JSON.stringify(['G-CLOUD-1', 'Cloud → NEXT 商品', '通常版', '']);
  const orderKey = 'WACA::CLOUD-1';
  seed.wacaOrders.push(withAudit({
    id: uuid(80), order_key: orderKey, status: '完成付款',
    payload: { key: orderKey, orderNumber: 'CLOUD-1', status: '完成付款', purchasedAt: '2026-09-29' },
  }));
  seed.wacaItems.push(withAudit({
    id: uuid(81), item_key: `${orderKey}::${feature}`, order_id: uuid(80), feature,
    product_variant_id: uuid(12), quantity: 11,
    payload: { key: `${orderKey}::${feature}`, orderKey, feature, productCode: 'G-CLOUD-1',
      productTitle: 'Cloud → NEXT 商品', spec1: '通常版', spec2: '', specCode: '', quantity: 11,
      subtotal: 1100, productVariantId: uuid(12), match: 'DIRECT_G', diagnostic: null },
  }));
  seed.wacaMappings.push(withAudit({
    id: uuid(82), feature, product_variant_id: uuid(12),
    payload: { feature, myacgMainId: 'GP-CLOUD-1', myacgVariantId: 'G-CLOUD-1',
      productVariantId: uuid(12), method: 'AUTO', confirmedAt: '2026-09-29', masterStatus: 'ACTIVE' },
  }));
  seed.myacgMasterLinks.push(withAudit({
    id: uuid(83), child_code: 'G-CLOUD-1', main_code: 'GP-CLOUD-1', product_variant_id: uuid(12),
    payload: { childCode: 'G-CLOUD-1', mainCode: 'GP-CLOUD-1', productVariantId: uuid(12),
      source: 'MYACG_IMPORT', observedAt: '2026-09-29' },
  }));
  seed.wacaImportBatches.push(withAudit({
    id: uuid(84), batch_key: 'cloud-waca-batch-1',
    payload: { id: 'cloud-waca-batch-1', fileName: 'waca-cloud.xlsx', importedAt: '2026-09-29T00:00:00.000Z',
      rows: 1, inserted: 1, updated: 0, unchanged: 0,
      result: { rows: 1, inserted: 1, updated: 0, unchanged: 0, conflicts: 0 }, conflictRows: [] },
  }));
  seed.wacaCutoverAudit.push(withAudit({
    id: uuid(85), product_variant_id: uuid(12),
    payload: { productVariantId: uuid(12), sku: 'SKU-CLOUD-1', productTitle: 'Cloud → NEXT 商品',
      variantTitle: '通常版', legacyWacaQuantity: 8, legacyAutoQuantity: 8,
      unverifiedPreCutoverManualQuantity: 0, newOrderDerivedQuantity: 11, difference: 3,
      cutoverAt: '2026-09-29T00:00:00.000Z' },
  }));
  seed.wacaCutoverState.push(withAudit({
    id: '00000000-0000-4000-8000-000000000001', revision: 4, mode: 'ORDER_DRIVEN_ACTIVE',
    payload: { mode: 'ORDER_DRIVEN_ACTIVE', updatedAt: '2026-09-29T00:00:00.000Z', sourceBackupFormatVersion: 2 },
  }));

  // A closed, unrelated tombstone proves the NEXT projection does not expose
  // historical Cloud-only rows while still reporting the transform.
  seed.productGroups.push(withAudit({
    id: uuid(90), local_id: 'deleted-group-local', title: 'Deleted Cloud Group', priority: 'Medium',
    purchase_date: '', closing_date: '', release_month: '', has_official_site: false,
    product_url: '', show_in_purchase_list: false, deleted_at: '2026-09-29T00:00:00.000Z',
  }));
  seed.productCategories.push(withAudit({
    id: uuid(91), local_id: 'deleted-category-local', product_group_id: uuid(90), title: 'Deleted',
    sort_order: 0, deleted_at: '2026-09-29T00:00:00.000Z',
  }));
  seed.productVariants.push(withAudit({
    id: uuid(92), local_id: 'deleted-variant-local', product_group_id: uuid(90), product_category_id: uuid(91),
    myacg_item_code: 'SKU-DELETED', product_title: 'Deleted', variant_name: 'Deleted', waca_auto_quantity: 0,
    waca_manual_adjustment: 0, note: '', sort_order: 0, deleted_at: '2026-09-29T00:00:00.000Z',
  }));

  const built = await restore.buildCloudRestoreManifest(seed, seed);
  const deadlineSidecar = {
    deadlineVerifiedMappings: [{ id: 'deadline-map-1', erpProductGroupId: 'cloud-group-local',
      sourceIdentityKey: 'source-1', mapping: { source: 'cloud' } }],
    deadlineApplyBatches: [{ id: 'deadline-batch-1', idempotencyKey: 'deadline-key-1',
      resolutionBatchId: 'resolution-1', itemIds: ['deadline-item-1'], audit: { source: 'cloud' } }],
    deadlineApplyItems: [{ id: 'deadline-item-1', applyBatchId: 'deadline-batch-1',
      resolutionResultId: 'result-1', itemOrder: 0, audit: { source: 'cloud' } }],
  };
  sourceExactDocument = {
    schemaVersion: restore.CLOUD_RESTORE_SCHEMA_VERSION,
    sourceEnvironment: 'cloud-authoritative',
    manifest: built.manifest,
    data: Object.fromEntries(restore.CLOUD_RESTORE_TABLES.map(([collection, table]) => [collection, built.data[table]])),
    deadlineSidecar,
    requestCorrelation: { id: uuid(999), proof: 'cloud-only-metadata' },
  };
  writeFileSync(fixturePath, JSON.stringify(sourceExactDocument, null, 2));
  sourceExactPreview = await bridge.prepareCloudBackupForNextRestore(JSON.stringify(sourceExactDocument), { fileName: 'source-exact.json' });
  assert.equal(sourceExactPreview.summary.targetResourceCount, 24);
  assert.equal(sourceExactPreview.summary.blockingOrphanCount, 0);
  assert.equal(sourceExactPreview.summary.wacaOrderCount, 1);
  assert.equal(sourceExactPreview.summary.wacaItemCount, 1);
  assert.equal(sourceExactPreview.summary.deadlineDurableCount, 3);
  assert.equal(sourceExactPreview.summary.softDeletedSkippedCount, 3);
  assert.equal(sourceExactPreview.summary.auditIdentityClearedCount > 0, true);
  assert.equal(sourceExactPreview.workbenchData.productGroups.some(row => row.id === 'deleted-group-local'), false);
  assert.equal(sourceExactPreview.workbenchData.productVariants[0].id, 'cloud-variant-local');
  assert.equal(sourceExactPreview.workbenchData.productVariants[0].database_id, uuid(12));
  assert.equal(sourceExactPreview.workbenchData.wacaItems[0].productVariantId, 'cloud-variant-local');
  assert.equal(sourceExactPreview.workbenchData.wacaCutoverState[0].mode, 'ORDER_DRIVEN_ACTIVE');

  if (process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT) {
    const realRaw = readFileSync(process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT, 'utf8');
    realPreview = await bridge.prepareCloudBackupForNextRestore(realRaw, { fileName: 'real-cloud-backup.json' });
    assert.equal(realPreview.summary.targetResourceCount, 24);
    assert.equal(realPreview.summary.blockingOrphanCount, 0);
    assert.equal(realPreview.summary.legacyWacaBackup, true);
  }
} finally {
  await moduleServer.close();
}

const managesVite = !process.env.CLOUD_NEXT_E2E_ORIGIN;
const vite = managesVite ? spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', '--mode', 'next', '--host', '127.0.0.1', '--port', '4394', '--strictPort', '--configLoader', 'runner',
], {
  env: { ...process.env, VITE_DEPLOYMENT_ENV: 'next',
    VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'isolated-no-network' },
  stdio: ['ignore', 'pipe', 'pipe'],
}) : null;
let viteOutput = '';
vite?.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite?.stderr.on('data', chunk => { viteOutput += String(chunk); });

let browser;
try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (attempt === 79 || vite?.exitCode !== null && vite?.exitCode !== undefined) throw new Error(viteOutput);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({
    executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  const cloudRequests = [];
  const pageErrors = [];
  await page.route('**/*.supabase.co/**', route => {
    cloudRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));
  assert.equal(await page.evaluate(value => window.dataProvider.importData(JSON.stringify(value)), localFixture), true);

  await page.getByTestId('settings-restore-file-input').setInputFiles(fixturePath);
  await page.getByTestId('cloud-restore-preview').waitFor();
  assert.equal(await page.getByTestId('cloud-restore-resource-count').textContent(), '24');
  assert.equal(await page.getByTestId('cloud-restore-orphan-count').textContent(), '0');
  page.once('dialog', dialog => dialog.accept());
  await page.getByTestId('cloud-restore-confirm').click();
  await page.getByTestId('cloud-restore-success').waitFor();

  const readState = () => page.evaluate(async () => {
    const provider = window.dataProvider;
    const [inventory, groups, categories, variants, purchaseBatches, purchaseItems,
      privateOrders, privateItems, salesOrders, salesItems, packages, packageItems,
      shipments, shipmentItems, bundles, imports, waca] = await Promise.all([
      provider.getInventory(), provider.getProductGroups(), provider.getProductCategories(),
      provider.getProductVariants({ raw: true }), provider.getPurchaseBatches(), provider.getPurchaseBatchItems(),
      provider.getPrivateOrders(), provider.getPrivateOrderItems(), provider.getSalesOrders(), provider.getSalesOrderItems(),
      provider.getJapanPackages(), provider.getJapanPackageItems(), provider.getOutboundShipments(),
      provider.getOutboundShipmentItems(), provider.getBundleComponents(), provider.getImportBatches(),
      provider.getNextWacaSnapshot(),
    ]);
    const { readDeadlineDurableBackup } = await import('/src/lib/closingDateSidecarBackup.ts');
    const { getActiveSandboxConfig } = await import('/src/lib/testSandboxEnvironment.ts');
    const deadline = await readDeadlineDurableBackup('next');
    return {
      counts: [inventory, groups, categories, variants, purchaseBatches, purchaseItems,
        privateOrders, privateItems, salesOrders, salesItems, packages, packageItems,
        shipments, shipmentItems, bundles, imports].map(rows => rows.length),
      variant: variants.find(row => row.id === 'cloud-variant-local'),
      waca: { orders: waca.orders.length, items: waca.items.length, mappings: waca.mappings.length,
        batches: waca.batches.length, links: waca.masterLinks.length, audit: waca.cutoverAudit.length,
        state: waca.cutoverState?.mode },
      deadline: Object.fromEntries(Object.entries(deadline).map(([key, rows]) => [key, rows.length])),
      sandbox: getActiveSandboxConfig(),
      databases: (await indexedDB.databases()).map(entry => entry.name),
    };
  });

  const state = await readState();
  assert.deepEqual(state.counts, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(state.variant.database_id, uuid(12));
  assert.equal(state.variant.waca_auto_quantity, 11);
  assert.equal(state.variant.waca_manual_adjustment, 2);
  assert.deepEqual(state.waca, { orders: 1, items: 1, mappings: 1, batches: 1, links: 1, audit: 1, state: 'ORDER_DRIVEN_ACTIVE' });
  assert.deepEqual(state.deadline, { deadlineVerifiedMappings: 1, deadlineApplyBatches: 1, deadlineApplyItems: 1 });
  assert.equal(state.sandbox.dbName, 'daigou-erp-db-next-v1');
  assert.equal(state.sandbox.storagePrefix, '__hippo_next_sandbox__::');
  assert.equal(state.databases.includes('daigou-erp-db-next-v1'), true);
  const settingsText = await page.locator('.settings-data-grid').textContent();
  assert.match(settingsText, /商品主檔 \(InventoryItem\).*1 筆/su);
  assert.match(settingsText, /商品 SKU \(ProductVariant\).*1 筆/su);

  const beforeFailures = await page.evaluate(async () => {
    const { readPhysicalIndexedDbSnapshot } = await import('/src/lib/testSandboxEnvironment.ts');
    const { readDeadlineDurableBackup } = await import('/src/lib/closingDateSidecarBackup.ts');
    return { main: await readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1'),
      deadline: await readDeadlineDurableBackup('next') };
  });
  const unknown = structuredClone(sourceExactDocument);
  unknown.data.futureDurableResource = [{ id: 'future-1' }];
  const unknownResult = await page.evaluate(async document => {
    try { await window.dataProvider.importData(JSON.stringify(document)); return 'accepted'; }
    catch (error) { return error.code || error.message; }
  }, unknown);
  assert.equal(unknownResult, 'UNEXPECTED_RESOURCE');

  const brokenRelation = structuredClone(sourceExactDocument);
  brokenRelation.data.wacaItems[0].order_id = uuid(777);
  const relationResult = await page.evaluate(async document => {
    try { await window.dataProvider.importData(JSON.stringify(document)); return 'accepted'; }
    catch (error) { return error.code || error.message; }
  }, brokenRelation);
  assert.equal(relationResult, 'ORPHAN_RELATION');

  const forcedFailure = await page.evaluate(async document => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function failCoreWrite(value, key) {
      if (key === 'erp_purchase_batch_items') throw new Error('forced Cloud → NEXT mid-restore failure');
      return originalPut.call(this, value, key);
    };
    try { return await window.dataProvider.importData(JSON.stringify(document)); }
    finally { IDBObjectStore.prototype.put = originalPut; }
  }, sourceExactDocument);
  assert.equal(forcedFailure, false);
  const afterFailures = await page.evaluate(async () => {
    const { readPhysicalIndexedDbSnapshot } = await import('/src/lib/testSandboxEnvironment.ts');
    const { readDeadlineDurableBackup } = await import('/src/lib/closingDateSidecarBackup.ts');
    return { main: await readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1'),
      deadline: await readDeadlineDurableBackup('next') };
  });
  assert.deepEqual(afterFailures, beforeFailures, 'validation and mid-restore failures must preserve main + Deadline data');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));
  assert.deepEqual(await readState(), state, 'F5 must read back the same Cloud → NEXT state');

  if (process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT) {
    await page.getByTestId('settings-restore-file-input').setInputFiles(process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT);
    await page.getByTestId('cloud-restore-preview').waitFor();
    assert.equal(await page.getByTestId('cloud-restore-resource-count').textContent(), '24');
    page.once('dialog', dialog => dialog.accept());
    await page.getByTestId('cloud-restore-confirm').click();
    await page.getByTestId('cloud-restore-success').waitFor();
    const realSamePage = await page.evaluate(async () => ({
      groups: (await window.dataProvider.getProductGroups()).length,
      variants: (await window.dataProvider.getProductVariants({ raw: true })).length,
      state: (await window.dataProvider.getNextWacaSnapshot()).cutoverState?.mode,
    }));
    assert.equal(realSamePage.groups, realPreview.summary.restoredCounts.productGroups);
    assert.equal(realSamePage.variants, realPreview.summary.restoredCounts.productVariants);
    assert.equal(realSamePage.state, 'ORDER_REBASELINE_REQUIRED');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.dataProvider));
    const realAfterF5 = await page.evaluate(async () => ({
      groups: (await window.dataProvider.getProductGroups()).length,
      variants: (await window.dataProvider.getProductVariants({ raw: true })).length,
      state: (await window.dataProvider.getNextWacaSnapshot()).cutoverState?.mode,
    }));
    assert.deepEqual(realAfterF5, realSamePage);
  }

  assert.deepEqual(cloudRequests, [], 'NEXT restore must perform zero Supabase requests');
  assert.deepEqual(pageErrors, []);
  console.log('PASS source-exact 24-resource Cloud Backup → NEXT Settings UI preview/confirm/restore');
  console.log('PASS WACA 11 reconciliation, mappings/master links/history/cutover, Deadline durable restore');
  console.log('PASS canonical database ids preserved, local ids/FKs transformed, actor/sync metadata cleared');
  console.log('PASS unknown resource + relationship rejection and forced mid-restore main/sidecar rollback');
  console.log('PASS same-page counts, F5 read-back, NEXT database/storage identity, Cloud requests 0');
  if (realPreview) console.log(`PASS real Cloud file UI restore: ${realPreview.summary.sourceTotalRows} source rows`);
} finally {
  await browser?.close();
  vite?.kill('SIGTERM');
  try { unlinkSync(fixturePath); } catch { /* already removed */ }
}
