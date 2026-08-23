import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4194';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/core-regression.json', import.meta.url)), 'utf8'));

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4194', '--strictPort',
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

const storageKeys = {
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
  bundleComponents: 'erp_bundle_components',
  japanPackages: 'erp_japan_packages',
  japanPackageItems: 'erp_japan_package_items',
  outboundShipments: 'erp_outbound_shipments',
  outboundShipmentItems: 'erp_outbound_shipment_items',
};

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({
  locale: 'zh-TW',
  timezoneId: 'Asia/Taipei',
  permissions: ['clipboard-read', 'clipboard-write']
});
const page = await context.newPage();
const supabaseRequests = [];
const unexpectedErrors = [];

const readStoredCollections = async () => page.evaluate(async keys => {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open('daigou-erp-db-test-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('kv', 'readonly');
      const store = transaction.objectStore('kv');
      const result = {};
      let remaining = Object.entries(keys).length;

      for (const [field, key] of Object.entries(keys)) {
        const getRequest = store.get(key);
        getRequest.onerror = () => reject(getRequest.error);
        getRequest.onsuccess = () => {
          result[field] = getRequest.result ?? [];
          remaining -= 1;
          if (remaining === 0) {
            db.close();
            resolve(result);
          }
        };
      }
    };
  });
}, storageKeys);

const restoreStoredVariants = async variants => page.evaluate(async ({ key, variants }) => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('daigou-erp-db-test-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('kv', 'readwrite');
      transaction.objectStore('kv').put(variants, key);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}, { key: storageKeys.productVariants, variants });

page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});
page.on('console', message => {
  if (message.type() === 'error' && !message.text().includes('Test Sandbox blocked')) unexpectedErrors.push(message.text());
});
page.on('pageerror', error => unexpectedErrors.push(error.message));

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ data, keys }) => {
    localStorage.clear();
    localStorage.setItem('erp_provider_mode', 'test');
    localStorage.setItem('__hippo_test_sandbox__::purchase_management_edit_mode', 'true');

    await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db-test-v1', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('kv', 'readwrite');
        const store = transaction.objectStore('kv');
        store.clear();
        for (const [field, key] of Object.entries(keys)) store.put(data[field] ?? [], key);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      };
    });
  }, { data: fixture, keys: storageKeys });

  await page.reload({ waitUntil: 'networkidle' });
  await page.goto(`${BASE_URL}/purchase-records/g-holo`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '新增採購批次' }).waitFor();
  const baselineCollections = await readStoredCollections();

  assert.equal(await page.getByRole('button', { name: '新增採購批次' }).count(), 1, 'Purchase batch must remain a direct primary action');
  assert.equal(await page.getByRole('button', { name: '私下登記' }).count(), 0, 'Private registration must not remain a direct toolbar action');
  assert.equal(await page.getByRole('button', { name: '新增規格' }).count(), 0, 'Add variant must not remain a direct toolbar action');

  const otherActions = page.getByRole('button', { name: '其他操作' });
  await otherActions.click();
  assert.equal(await otherActions.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByRole('menuitem', { name: '私下登記' }).count(), 1);
  assert.equal(await page.getByRole('menuitem', { name: '新增規格' }).count(), 1, 'Test Sandbox must allow writes to its isolated DB without granting Cloud write permission');

  await otherActions.click();
  assert.equal(await otherActions.getAttribute('aria-expanded'), 'false', 'Other actions menu must close when its trigger is pressed again');
  await otherActions.click();
  await page.getByRole('heading', { level: 1 }).click();
  assert.equal(await otherActions.getAttribute('aria-expanded'), 'false', 'Other actions menu must close on an outside click');
  await otherActions.click();

  await page.getByRole('menuitem', { name: '私下登記' }).click();
  await page.getByRole('heading', { name: '新增私下登記' }).waitFor();
  assert.deepEqual(await readStoredCollections(), baselineCollections, 'Opening private registration must not write data');

  await page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(await readStoredCollections(), baselineCollections, 'Reload after dismissing private registration must not write data');
  await page.getByRole('button', { name: '新增採購批次' }).click();
  await page.getByRole('heading', { name: '新增採購批次' }).waitFor();

  await page.getByRole('button', { name: '取消' }).click();
  assert.deepEqual(await readStoredCollections(), baselineCollections, 'Cancelling a purchase batch must not write data');

  await otherActions.click();
  await page.getByRole('menuitem', { name: '新增規格' }).click();
  await page.getByText('已成功手動新增規格', { exact: true }).waitFor();
  const afterAddVariant = await readStoredCollections();
  assert.equal(afterAddVariant.productVariants.length, baselineCollections.productVariants.length + 1, 'Add variant entry must invoke the existing isolated-DB save path');
  assert.deepEqual(
    { ...afterAddVariant, productVariants: baselineCollections.productVariants },
    baselineCollections,
    'Add variant entry must not modify unrelated collections'
  );
  await restoreStoredVariants(baselineCollections.productVariants);
  await page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(await readStoredCollections(), baselineCollections, 'The isolated fixture must be restored after exercising add variant');

  await page.getByText('採購批次紀錄', { exact: true }).click();
  const copyBatchLedger = page.getByRole('button', { name: '複製本批次帳目', exact: true });
  assert.equal(await copyBatchLedger.count(), 1, 'Each purchase batch must retain its ledger copy action');
  const copyDialog = new Promise((resolve, reject) => {
    page.once('dialog', async dialog => {
      try {
        assert.match(dialog.message(), /已複製本批次帳目/);
        await dialog.accept();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  await copyBatchLedger.click();
  await copyDialog;
  const copiedBatchLedger = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copiedBatchLedger, 'hololive active-General-A\t1', 'Per-batch clipboard output must remain byte-for-byte identical to the baseline formatter');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/purchase-records/g-holo`, { waitUntil: 'networkidle' });
  const mobileOtherActions = page.getByRole('button', { name: '其他操作' });
  assert.equal(await page.getByRole('button', { name: '新增採購批次' }).count(), 1, 'Mobile must retain the primary purchase-batch action');
  assert.equal(await mobileOtherActions.count(), 1, 'Mobile must retain the secondary actions menu');
  await mobileOtherActions.click();
  assert.equal(await page.getByRole('menuitem', { name: '私下登記' }).count(), 1);
  assert.equal(await page.getByRole('menuitem', { name: '新增規格' }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile action layout must not create horizontal scrolling');

  await page.evaluate(() => localStorage.setItem('__hippo_test_sandbox__::purchase_management_edit_mode', 'false'));
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('button', { name: '新增採購批次' }).isDisabled(), true, 'Locked mode must preserve the existing write permission boundary');
  assert.equal(await page.getByRole('button', { name: '其他操作' }).isDisabled(), true, 'Locked mode must disable secondary write actions');
  assert.deepEqual(await readStoredCollections(), baselineCollections, 'Responsive and permission checks must not modify data');

  assert.deepEqual(supabaseRequests, [], 'Test Mode must not call Production Supabase');
  assert.deepEqual(unexpectedErrors, [], 'Browser Console must not contain unexpected errors');
  console.log('PASS Purchase Management keeps purchase batch primary and moves secondary actions into a menu');
  console.log('PASS menu toggle/outside-close, desktop/mobile, and locked-mode behavior');
  console.log('PASS private/batch cancel and reload produce 0 data changes');
  console.log('PASS per-batch ledger action and clipboard bytes remain unchanged');
  console.log('PASS Experimental/Test Supabase requests remain 0');
} finally {
  await browser.close();
  vite.kill();
}
