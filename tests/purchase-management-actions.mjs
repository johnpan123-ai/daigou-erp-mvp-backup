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

  assert.equal(await page.getByRole('button', { name: '新增採購批次' }).count(), 1, 'Purchase batch must remain a direct primary action');
  assert.equal(await page.getByRole('button', { name: '私下登記' }).count(), 0, 'Private registration must not remain a direct toolbar action');
  assert.equal(await page.getByRole('button', { name: '新增規格' }).count(), 0, 'Add variant must not remain a direct toolbar action');
  assert.equal(await page.getByText('複製已採購帳目', { exact: true }).count(), 0, 'Legacy clipboard action must be hidden from the UI');

  const otherActions = page.getByRole('button', { name: '其他操作' });
  await otherActions.click();
  assert.equal(await otherActions.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByRole('menuitem', { name: '私下登記' }).count(), 1);
  assert.equal(await page.getByRole('menuitem', { name: '新增規格' }).count(), 0, 'Test Sandbox must preserve its existing cloud-write permission gate');

  await page.getByRole('menuitem', { name: '私下登記' }).click();
  await page.getByRole('heading', { name: '新增私下登記' }).waitFor();
  assert.equal(await page.getByText('記錄個別買家的私人需求，不會建立採購批次。', { exact: true }).count(), 1);

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '新增採購批次' }).click();
  await page.getByRole('heading', { name: '新增採購批次' }).waitFor();
  assert.equal(await page.getByText('建立正式採購批次，記錄本次採購數量與成本。', { exact: true }).count(), 1);

  await page.getByRole('button', { name: '取消' }).click();
  await page.getByText('採購批次紀錄', { exact: true }).click();
  const copyBatchLedger = page.getByRole('button', { name: '複製本批次帳目', exact: true });
  assert.equal(await copyBatchLedger.count(), 1, 'Each purchase batch must retain its ledger copy action');
  const copyDialog = page.waitForEvent('dialog');
  await copyBatchLedger.click();
  const dialog = await copyDialog;
  assert.match(dialog.message(), /已複製本批次帳目/);
  await dialog.accept();
  const copiedBatchLedger = await page.evaluate(() => navigator.clipboard.readText());
  assert.notEqual(copiedBatchLedger, '', 'Batch ledger copy output must remain available');
  assert.doesNotMatch(copiedBatchLedger, /【|批下單|採購日期|────|\n\n/, 'Per-batch ledger must not contain batch metadata, separators, or blank rows');
  assert.ok(copiedBatchLedger.split('\n').every(row => row.split('\t').length === 2), 'Per-batch ledger rows must contain only product name and quantity');

  assert.deepEqual(supabaseRequests, [], 'Test Mode must not call Production Supabase');
  assert.deepEqual(unexpectedErrors, [], 'Browser Console must not contain unexpected errors');
  console.log('PASS Purchase Management keeps purchase batch primary and moves secondary actions into a menu');
  console.log('PASS private and purchase-batch modals have distinct titles and descriptions');
  console.log('PASS legacy purchased-ledger copy UI is hidden while Sandbox Supabase requests remain 0');
} finally {
  await browser.close();
  vite.kill();
}
