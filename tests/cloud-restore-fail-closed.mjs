import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const TEST_PORT = process.env.CLOUD_RESTORE_TEST_PORT || '4195';
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VALID_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/p0-a-atomic-import-valid.json', import.meta.url));
const INVALID_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/p0-a-atomic-import-invalid-collection-8.json', import.meta.url));

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const validFixtureText = readFileSync(VALID_FIXTURE_PATH, 'utf8');
const validFixture = JSON.parse(validFixtureText);
const invalidFixture = JSON.parse(readFileSync(INVALID_FIXTURE_PATH, 'utf8'));
const baselineFixture = JSON.parse(validFixtureText.replaceAll('p0a-b', 'p0b-a').replaceAll('P0-A 新', 'P0-B 舊'));

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

const cloudProviderSource = readFileSync(
  fileURLToPath(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url)),
  'utf8',
);
const settingsSource = readFileSync(fileURLToPath(new URL('../src/pages/Settings.tsx', import.meta.url)), 'utf8');
const inventorySource = readFileSync(fileURLToPath(new URL('../src/pages/Inventory.tsx', import.meta.url)), 'utf8');

assert.match(
  cloudProviderSource,
  /async restoreBackup\(_backupData: any\): Promise<boolean> \{\s*throw new CloudRestoreDisabledError\(\);\s*\}/,
  'SupabaseProvider.restoreBackup must fail before any cloud read or write',
);
assert.match(settingsSource, /disabled=\{isCloudRestoreDisabledMode\(currentMode\)\}/);
assert.match(settingsSource, /Cloud Mode 暫停還原/);
assert.match(inventorySource, /disabled=\{isRollbackPending \|\| isImporting \|\| isCloudRestoreDisabled\}/);
assert.match(inventorySource, /Cloud Mode 暫停還原/);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', TEST_PORT, '--strictPort',
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
  if (request.url().includes('.supabase.co/')) {
    productionSupabaseRequests.push({ method: request.method(), url: request.url() });
  }
});
page.on('console', message => {
  const expectedImportFailure = message.text().includes('Import failed');
  if (message.type() === 'error' && !expectedImportFailure) unexpectedErrors.push(message.text());
});
page.on('pageerror', error => unexpectedErrors.push(error.message));

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('erp_provider_mode', 'local');
    localStorage.setItem('erp_search_term', 'p0-b-production-local-storage-sentinel');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  const localBaselineImported = await page.evaluate(data => window.dataProvider.importData(JSON.stringify(data)), baselineFixture);
  assert.equal(localBaselineImported, true, 'Local baseline A must import successfully');

  const localRestoreSucceeded = await page.evaluate(data => window.dataProvider.restoreBackup(data), validFixture);
  assert.equal(localRestoreSucceeded, true, 'Local restore B must remain available');
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  const localAfterSuccess = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-local-authoritative-v1');
  });
  assert.equal(stableStringify(localAfterSuccess), stableStringify(expectedSnapshot(validFixture)), 'Local restore B must survive F5');

  const localInvalidResult = await page.evaluate(data => window.dataProvider.restoreBackup(data), invalidFixture);
  assert.equal(localInvalidResult, false, 'Local malformed restore must fail');
  const localAfterInvalid = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-local-authoritative-v1');
  });
  assert.equal(stableStringify(localAfterInvalid), stableStringify(localAfterSuccess), 'Failed Local restore must roll back completely');

  const productionBeforeTest = {
    db: localAfterInvalid,
    localStorage: await page.evaluate(() => localStorage.getItem('erp_search_term')),
  };

  await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'test'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);
  productionSupabaseRequests.length = 0;

  const testBaselineImported = await page.evaluate(data => window.dataProvider.restoreBackup(data), baselineFixture);
  assert.equal(testBaselineImported, true, 'Test baseline A must restore successfully');

  const testBeforeCloudCall = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1');
  });

  const directCloudResult = await page.evaluate(async data => {
    const policy = await import('/src/providers/cloudRestorePolicy.ts');
    const provider = await import('/src/providers/cloud/supabaseProvider.ts');
    let error = null;
    try {
      await provider.supabaseProvider.restoreBackup(data);
    } catch (caught) {
      error = { name: caught?.name, message: caught?.message };
    }
    return {
      error,
      policy: {
        cloud: policy.isCloudRestoreDisabledMode('cloud'),
        fallback: policy.isCloudRestoreDisabledMode('fallback'),
        local: policy.isCloudRestoreDisabledMode('local'),
        test: policy.isCloudRestoreDisabledMode('test'),
      },
    };
  }, validFixture);

  assert.equal(directCloudResult.error?.name, 'CloudRestoreDisabledError');
  assert.match(directCloudResult.error?.message ?? '', /Cloud Mode 暫停直接 JSON 還原/);
  assert.deepEqual(directCloudResult.policy, { cloud: true, fallback: true, local: false, test: false });

  const testAfterCloudCall = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1');
  });
  assert.equal(stableStringify(testAfterCloudCall), stableStringify(testBeforeCloudCall), 'Direct Cloud restore rejection must not touch Test DB');
  assert.deepEqual(productionSupabaseRequests, [], 'Direct Cloud restore rejection must make zero Supabase requests');

  const testRestoreSucceeded = await page.evaluate(data => window.dataProvider.restoreBackup(data), validFixture);
  assert.equal(testRestoreSucceeded, true, 'Test restore B must remain available');
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  const testAfterSuccess = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1');
  });
  assert.equal(stableStringify(testAfterSuccess), stableStringify(expectedSnapshot(validFixture)), 'Test restore B must survive F5');

  const testInvalidResult = await page.evaluate(data => window.dataProvider.restoreBackup(data), invalidFixture);
  assert.equal(testInvalidResult, false, 'Test malformed restore must fail');
  const finalState = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      testDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1'),
      productionDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-local-authoritative-v1'),
      productionLocalStorage: environment.readPhysicalLocalStorageValue('erp_search_term'),
    };
  });

  assert.equal(stableStringify(finalState.testDb), stableStringify(testAfterSuccess), 'Failed Test restore must roll back completely');
  assert.equal(stableStringify(finalState.productionDb), stableStringify(productionBeforeTest.db));
  assert.equal(finalState.productionLocalStorage, productionBeforeTest.localStorage);
  assert.deepEqual(productionSupabaseRequests, [], 'P0-B Test operations must make zero Production Supabase requests');
  assert.deepEqual(unexpectedErrors, []);

  console.log('PASS Cloud Settings and Inventory restore controls are explicitly disabled in source');
  console.log('PASS direct SupabaseProvider.restoreBackup fails closed before any Supabase request');
  console.log('PASS Local restore succeeds; malformed Local restore rolls back');
  console.log('PASS Test restore succeeds; malformed Test restore rolls back');
  console.log('PASS Production IndexedDB/localStorage remain unchanged during Test restore checks');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
