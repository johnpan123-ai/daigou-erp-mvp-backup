import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4189';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4189', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stableStringify = value => JSON.stringify(value, (_key, nestedValue) => {
  if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) return nestedValue;
  return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) => left.localeCompare(right)));
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

async function waitForProvider(page) {
  await page.waitForFunction(() => Boolean(window.dataProvider));
}

const fixture = {
  inventory: [{ inventory_key: 'TEST-SKU::SPEC', myacg_item_code: 'TEST-SKU', product_title: 'Inventory', raw_variant_name: 'Spec' }],
  salesOrders: [],
  salesOrderItems: [],
  productGroups: [{ id: 'group-1', title: 'Group 1' }],
  productCategories: [{ id: 'category-1', product_group_id: 'group-1', title: 'Category 1' }],
  productVariants: [{ id: 'variant-1', product_group_id: 'group-1', product_category_id: 'category-1', myacg_item_code: 'TEST-SKU' }],
  purchaseBatches: [
    { id: 'batch-1', product_group_id: 'group-1', name: 'Batch 1' },
    { id: 'batch-orphan', product_group_id: 'missing-history-group', name: 'Historical orphan' },
  ],
  purchaseBatchItems: [{ id: 'batch-item-1', purchase_batch_id: 'batch-1', product_variant_id: 'variant-1', quantity: 2 }],
  privateOrders: [{ id: 'private-order-1', product_group_id: 'group-1', customer_name: 'Local Test Customer' }],
  privateOrderItems: [{ id: 'private-item-1', private_order_id: 'private-order-1', product_variant_id: 'variant-1', quantity: 1 }],
  bundleComponents: [{ id: 'bundle-1', bundle_variant_id: 'variant-1', component_variant_id: 'missing-history-variant' }],
  japanPackages: [{ id: 'package-1', title: 'Package 1', status: 'registered' }],
  japanPackageItems: [{ id: 'package-item-1', japan_package_id: 'package-1', product_group_id: 'group-1', product_variant_id: 'variant-1', quantity: 2 }],
  outboundShipments: [{ id: 'shipment-1', title: 'Shipment 1', status: 'draft' }],
  outboundShipmentItems: [{ id: 'shipment-item-1', outbound_shipment_id: 'shipment-1', japan_package_item_id: 'package-item-1', quantity: 2 }],
};

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await context.newPage();
const productionSupabaseRequests = [];
const unexpectedErrors = [];

page.on('request', request => {
  if (request.url().includes('.supabase.co/')) productionSupabaseRequests.push(request.url());
});
page.on('console', message => {
  if (message.type() === 'error' && !message.text().includes('Test Sandbox blocked')) unexpectedErrors.push(message.text());
});
page.on('pageerror', error => unexpectedErrors.push(error.message));

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('erp_provider_mode', 'local');
    localStorage.setItem('erp_search_term', 'production-storage-sentinel');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);
  await page.evaluate(async () => {
    await window.dataProvider.clearData();
    await window.dataProvider.saveProductGroups([{ id: 'production-group', title: 'Production browser sentinel' }]);
  });

  const productionBefore = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      db: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      search: environment.readPhysicalLocalStorageValue('erp_search_term'),
    };
  });

  productionSupabaseRequests.length = 0;
  await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'test'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  const prepared = await page.evaluate(async data => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    await environment.clearTestSandboxData();
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db-test-v1', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      transaction.objectStore('kv').put([{ id: 'old-test-sentinel' }], 'erp_product_groups');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const importer = await import('/src/lib/testSnapshotImport.ts');
    const file = new File([JSON.stringify(data)], 'workbench-backup-test.json', { type: 'application/json' });
    const candidate = await importer.prepareTestSnapshotFile(file);
    return {
      candidate,
      summary: {
        shaLength: candidate.sha256.length,
        counts: candidate.counts,
        orphanCount: candidate.orphanWarnings.reduce((sum, warning) => sum + warning.count, 0),
      },
    };
  }, fixture);

  assert.equal(prepared.summary.shaLength, 64);
  assert.equal(prepared.summary.counts.productGroups, 1);
  assert.equal(prepared.summary.counts.purchaseBatches, 2);
  assert.equal(prepared.summary.orphanCount, 2, 'Historical orphans should warn but remain importable');

  const rollbackResult = await page.evaluate(async candidate => {
    const importer = await import('/src/lib/testSnapshotImport.ts');
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function forcedFailure(value, key) {
      if (key === 'erp_purchase_batch_items') throw new Error('forced atomic import failure');
      return originalPut.call(this, value, key);
    };
    let rejected = false;
    try {
      await importer.importTestSnapshot(candidate);
    } catch (error) {
      rejected = String(error).includes('forced atomic import failure') || String(error).includes('回滾');
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const snapshot = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1');
    return { rejected, groups: snapshot.erp_product_groups };
  }, prepared.candidate);

  assert.equal(rollbackResult.rejected, true, 'Forced transaction failure must reject');
  assert.deepEqual(rollbackResult.groups, [{ id: 'old-test-sentinel' }], 'Atomic rollback must preserve the previous Test DB');

  const importResult = await page.evaluate(async candidate => {
    const importer = await import('/src/lib/testSnapshotImport.ts');
    return importer.importTestSnapshot(candidate);
  }, prepared.candidate);

  assert.deepEqual(importResult.verifiedCounts, prepared.summary.counts);
  assert.equal(importResult.productionIndexedDbUnchanged, true);
  assert.equal(importResult.productionLocalStorageUnchanged, true);

  const after = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const importer = await import('/src/lib/testSnapshotImport.ts');
    return {
      productionDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      productionSearch: environment.readPhysicalLocalStorageValue('erp_search_term'),
      testDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1'),
      metadata: await importer.getTestSnapshotMetadata(),
    };
  });

  assert.equal(stableStringify(after.productionDb), stableStringify(productionBefore.db));
  assert.equal(after.productionSearch, productionBefore.search);
  assert.equal(after.testDb.erp_product_groups[0].id, 'group-1');
  assert.equal(after.testDb.erp_purchase_batches.length, 2);
  assert.equal(after.testDb.erp_test_snapshot_metadata.sourceFileName, 'workbench-backup-test.json');
  assert.equal(after.metadata.sourceSha256.length, 64);
  assert.deepEqual(productionSupabaseRequests, [], 'Snapshot import must make zero Production Supabase requests');

  const nonTestRejection = await page.evaluate(async data => {
    const importer = await import('/src/lib/testSnapshotImport.ts');
    localStorage.setItem('erp_provider_mode', 'local');
    try {
      await importer.prepareTestSnapshotFile(new File([JSON.stringify(data)], 'workbench-backup-test.json'));
      return false;
    } catch (error) {
      return String(error).includes('只能在 Test Sandbox');
    } finally {
      localStorage.setItem('erp_provider_mode', 'test');
    }
  }, fixture);
  assert.equal(nonTestRejection, true, 'Non-Test Mode must reject snapshot import');
  assert.deepEqual(unexpectedErrors, []);

  console.log('PASS workbench-backup JSON is validated before any write');
  console.log('PASS Test Snapshot uses one atomic transaction and rolls back on failure');
  console.log('PASS imported counts and collection checksums match after readback');
  console.log('PASS historical orphan references are warned and preserved');
  console.log('PASS Production IndexedDB and app localStorage remain unchanged');
  console.log('PASS Production Supabase requests = 0 and non-Test Mode is rejected');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
