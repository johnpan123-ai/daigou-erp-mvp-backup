import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
// 4193 is reserved by the local Experimental dev command and is mapped to
// Experimental mode by the app bootstrap. Keep this atomic-import test on a
// neutral port so its explicit Test mode selection is authoritative.
const BASE_URL = 'http://127.0.0.1:4253';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VALID_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/p0-a-atomic-import-valid.json', import.meta.url));
const INVALID_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/p0-a-atomic-import-invalid-collection-8.json', import.meta.url));

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const validFixtureText = readFileSync(VALID_FIXTURE_PATH, 'utf8');
const validFixture = JSON.parse(validFixtureText);
const invalidFixtureText = readFileSync(INVALID_FIXTURE_PATH, 'utf8');
const baselineFixture = JSON.parse(validFixtureText.replaceAll('p0a-b', 'p0a-a').replaceAll('P0-A 新', 'P0-A 舊'));

const collectionMap = {
  inventory: 'erp_inventory',
  salesOrders: 'erp_sales_orders',
  salesOrderItems: 'erp_sales_order_items',
  productGroups: 'erp_product_groups',
  productCategories: 'erp_product_categories',
  productVariants: 'erp_product_variants',
  purchaseBatches: 'erp_purchase_batches',
  purchaseBatchItems: 'erp_purchase_batch_items',
  privateOrders: 'erp_private_orders',
  privateOrderItems: 'erp_private_order_items',
  japanPackages: 'erp_japan_packages',
  japanPackageItems: 'erp_japan_package_items',
  outboundShipments: 'erp_outbound_shipments',
  outboundShipmentItems: 'erp_outbound_shipment_items',
  bundleComponents: 'erp_bundle_components',
  importBatches: 'erp_import_batches',
};

const stableStringify = value => JSON.stringify(value, (_key, nestedValue) => {
  if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) return nestedValue;
  return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) => left.localeCompare(right)));
});

const expectedSnapshot = fixture => Object.fromEntries(
  Object.entries(collectionMap).map(([collection, storageKey]) => [storageKey, fixture[collection] ?? []]),
);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4253', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

const waitForProvider = page => page.waitForFunction(() => Boolean(window.dataProvider));

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
  if (message.type() === 'error' && !message.text().includes('Import failed')) unexpectedErrors.push(message.text());
});
page.on('pageerror', error => unexpectedErrors.push(error.message));

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('erp_provider_mode', 'local');
    localStorage.setItem('erp_search_term', 'p0-a-production-local-storage-sentinel');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);
  await page.evaluate(async () => {
    await window.dataProvider.clearData();
    await window.dataProvider.saveProductGroups([{ id: 'p0-a-production-idb-sentinel' }]);
  });

  const productionBefore = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      db: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      localStorage: environment.readPhysicalLocalStorageValue('erp_search_term'),
    };
  });

  productionSupabaseRequests.length = 0;
  await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'test'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  const baselineImported = await page.evaluate(text => window.dataProvider.importData(text), JSON.stringify(baselineFixture));
  assert.equal(baselineImported, true, 'Baseline A must import successfully');

  const testBeforeFailure = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1');
  });
  assert.equal(stableStringify(testBeforeFailure), stableStringify(expectedSnapshot(baselineFixture)));

  const invalidResult = await page.evaluate(text => window.dataProvider.importData(text), invalidFixtureText);
  assert.equal(invalidResult, false, 'Malformed collection #8 must be rejected before writing');
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  const testAfterInvalid = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1');
  });
  assert.equal(stableStringify(testAfterInvalid), stableStringify(testBeforeFailure), 'Validation failure must preserve all baseline data');

  const forcedFailure = await page.evaluate(async text => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function failCollectionEight(value, key) {
      if (key === 'erp_purchase_batch_items') throw new Error('P0-A forced collection 8 write failure');
      return originalPut.call(this, value, key);
    };
    try {
      return await window.dataProvider.importData(text);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
  }, validFixtureText);
  assert.equal(forcedFailure, false, 'Forced IndexedDB failure must reject the import');

  const testAfterForcedFailure = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1');
  });
  assert.equal(stableStringify(testAfterForcedFailure), stableStringify(testBeforeFailure), 'Transaction abort must preserve all baseline data');

  const success = await page.evaluate(text => window.dataProvider.importData(text), validFixtureText);
  assert.equal(success, true, 'Valid replacement B must import successfully');
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  const finalState = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      testDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1'),
      productionDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      productionLocalStorage: environment.readPhysicalLocalStorageValue('erp_search_term'),
    };
  });

  assert.equal(stableStringify(finalState.testDb), stableStringify(expectedSnapshot(validFixture)), 'F5 must retain exactly replacement B');
  assert.equal(stableStringify(finalState.productionDb), stableStringify(productionBefore.db));
  assert.equal(finalState.productionLocalStorage, productionBefore.localStorage);
  assert.deepEqual(productionSupabaseRequests, [], 'P0-A Test import must make zero Production Supabase requests');
  assert.deepEqual(unexpectedErrors, []);

  console.log('PASS malformed collection #8 is rejected before any write');
  console.log('PASS forced collection #8 put failure aborts the single transaction');
  console.log('PASS failed imports preserve baseline A after F5');
  console.log('PASS successful import replaces all 16 collections with B after F5');
  console.log('PASS Production IndexedDB/localStorage remain unchanged and Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
