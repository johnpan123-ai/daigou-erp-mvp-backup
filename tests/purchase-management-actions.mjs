import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4194';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const batchTabPath = fileURLToPath(new URL('../src/components/PurchaseBatchTab.tsx', import.meta.url));
const purchaseManagementPath = fileURLToPath(new URL('../src/pages/PurchaseManagement.tsx', import.meta.url));
assert.equal(
  execFileSync('git', ['hash-object', batchTabPath], { encoding: 'utf8' }).trim(),
  '1f8ca359d662a3c2bfe56e8e5815ec5e87be6b3d',
  'PurchaseBatchTab, including the Production per-batch copy UI and formatter, must remain unchanged',
);

const purchaseManagementSource = readFileSync(purchaseManagementPath, 'utf8');
const batchCopyStart = purchaseManagementSource.indexOf('  const handleCopyBatchLedger = async');
const batchCopyEnd = purchaseManagementSource.indexOf('  const handleCopyBatchName = async', batchCopyStart);
const groupCopyStart = purchaseManagementSource.indexOf('  const handleCopyAllGroupPurchasedLedger = async');
const groupCopyEnd = purchaseManagementSource.indexOf('\n  const ', groupCopyStart + 10);
assert.notEqual(batchCopyStart, -1);
assert.notEqual(batchCopyEnd, -1);
assert.notEqual(groupCopyStart, -1);
assert.notEqual(groupCopyEnd, -1);
assert.equal(
  createHash('sha256').update(purchaseManagementSource.slice(batchCopyStart, batchCopyEnd)).digest('hex'),
  'ad12cd50300a9447f8bc735af0c1876bb21c96fd36c6f6347bbb3035b7b6b711',
  'Mobile per-batch clipboard formatter must remain byte-for-byte identical to Production',
);
assert.equal(
  createHash('sha256').update(purchaseManagementSource.slice(groupCopyStart, groupCopyEnd)).digest('hex'),
  'c49cd3d71c5e800a54cc4023a31579f2bb2a5c2e4005fd2d0298a3366a8ec524',
  'Existing group clipboard formatter must remain byte-for-byte identical to Production',
);
assert.match(purchaseManagementSource, /onClick=\{handleCopyAllGroupPurchasedLedger\}[\s\S]*?複製已採購帳目/);

const now = '2026-08-23T00:00:00.000Z';
const fixture = {
  inventory: [],
  salesOrders: [],
  salesOrderItems: [],
  productGroups: [{
    id: 'g-holo',
    title: '測試商品',
    normalized_title: '測試商品',
    listing_type: '日本代購',
    show_in_purchase_list: true,
    created_at: now,
    updated_at: now,
    version: 1,
  }],
  productCategories: [{
    id: 'c-holo',
    product_group_id: 'g-holo',
    title: '單品',
    sort_order: 0,
    created_at: now,
    updated_at: now,
    version: 1,
  }],
  productVariants: [{
    id: 'v-holo',
    product_group_id: 'g-holo',
    product_category_id: 'c-holo',
    product_title: '測試商品',
    variant_name: '限定版',
    raw_variant_name: '限定版',
    myacg_item_code: 'SKU-001',
    source: 'catalog',
    default_jpy_cost: 1000,
    default_twd_cost: null,
    sort_order: 0,
    myacg_auto_quantity: 0,
    myacg_manual_adjustment: 0,
    waca_auto_quantity: 0,
    waca_manual_adjustment: 0,
    private_manual_adjustment: 0,
    purchased_manual_adjustment: 0,
    created_at: now,
    updated_at: now,
    version: 1,
  }],
  purchaseBatches: [{
    id: 'b-holo',
    product_group_id: 'g-holo',
    name: '第1批下單',
    date: '2026-08-16',
    currency: 'JPY',
    note: '',
    created_at: now,
    updated_at: now,
    version: 1,
  }],
  purchaseBatchItems: [{
    id: 'bi-holo',
    purchase_batch_id: 'b-holo',
    product_variant_id: 'v-holo',
    quantity: 2,
    cost: 1000,
    note: '',
  }],
  privateOrders: [],
  privateOrderItems: [],
  bundleComponents: [],
  japanPackages: [],
  japanPackageItems: [],
  outboundShipments: [],
  outboundShipmentItems: [],
};

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

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4194', '--strictPort',
], {
  cwd: ROOT_PATH,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    VITE_SUPABASE_URL: 'https://purchase-ui-candidate.invalid.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'test-anon-key',
  },
});

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

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({
  locale: 'zh-TW',
  timezoneId: 'Asia/Taipei',
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const supabaseRequests = [];
const unexpectedErrors = [];

page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});
page.on('console', message => {
  if (message.type() === 'error') unexpectedErrors.push(message.text());
});
page.on('pageerror', error => unexpectedErrors.push(error.message));

async function readFixtureState() {
  return page.evaluate(async keys => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction('kv', 'readonly');
      const store = transaction.objectStore('kv');
      const result = {};
      await Promise.all(Object.entries(keys).map(([field, key]) => new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => { result[field] = request.result ?? []; resolve(); };
        request.onerror = () => reject(request.error);
      })));
      return result;
    } finally {
      db.close();
    }
  }, storageKeys);
}

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ data, keys }) => {
    localStorage.clear();
    localStorage.setItem('erp_provider_mode', 'local');
    localStorage.setItem('purchase_management_edit_mode', 'true');

    await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db', 1);
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
  try {
    await page.getByRole('button', { name: '新增採購批次' }).waitFor({ timeout: 5000 });
  } catch (error) {
    throw new Error(`Purchase detail did not become ready at ${page.url()}:\n${await page.locator('body').innerText()}\nConsole: ${unexpectedErrors.join(' | ')}\n${error.message}`);
  }
  const beforeState = await readFixtureState();

  assert.equal(await page.getByRole('button', { name: '新增採購批次' }).count(), 1, 'Purchase batch must remain a direct primary action');
  assert.equal(await page.getByRole('button', { name: '私下登記' }).count(), 0, 'Private registration must not remain a direct toolbar action');
  assert.equal(await page.getByRole('button', { name: '新增規格' }).count(), 0, 'Add variant must not remain a direct toolbar action');
  assert.equal(await page.getByRole('button', { name: '複製已採購帳目' }).count(), 1, 'Existing group ledger copy action must remain visible');
  const otherActions = page.getByRole('button', { name: '其他操作' });
  await otherActions.click();
  assert.equal(await otherActions.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByRole('menuitem', { name: '私下登記' }).count(), 1);
  assert.equal(await page.getByRole('menuitem', { name: '新增規格' }).count(), 1, 'Existing local write permission remains unchanged');

  await page.getByRole('menuitem', { name: '私下登記' }).click();
  await page.getByRole('heading', { name: '新增私下登記' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '新增採購批次' }).count(), 0, 'Private action must not open the purchase-batch modal');
  assert.equal(await page.getByText('記錄個別買家的私人需求，不會建立採購批次。', { exact: true }).count(), 1);
  await page.getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '新增採購批次' }).click();
  await page.getByRole('heading', { name: '新增採購批次' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '新增私下登記' }).count(), 0, 'Purchase-batch action must not open the private-registration modal');
  assert.equal(await page.getByText('建立正式採購批次，記錄本次採購數量與成本。', { exact: true }).count(), 1);
  await page.getByRole('button', { name: '取消' }).click();

  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('heading', { name: '新增私下登記' }).count(), 0, 'Private modal must not persist after F5');
  assert.equal(await page.getByRole('heading', { name: '新增採購批次' }).count(), 0, 'Purchase batch modal must not persist after F5');

  await page.getByText('採購批次紀錄', { exact: true }).click();
  const copyBatchLedger = page.getByRole('button', { name: '複製本批次帳目', exact: true });
  assert.equal(await copyBatchLedger.count(), 1, 'Each purchase batch must retain its ledger copy action');
  const copyDialog = page.waitForEvent('dialog');
  await copyBatchLedger.click();
  const dialog = await copyDialog;
  assert.match(dialog.message(), /已複製本批次帳目/);
  await dialog.accept();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    '測試商品-限定版\t2\t\t1000',
    'Per-batch clipboard output must remain exactly compatible with Production',
  );

  const afterState = await readFixtureState();
  assert.deepEqual(afterState, beforeState, 'Open/cancel/copy/F5 interactions must not modify business data');
  assert.deepEqual(supabaseRequests, [], 'Local fixture must not call Production Supabase');
  assert.deepEqual(unexpectedErrors, [], 'Browser console must not contain unexpected errors');

  console.log('PASS purchase batch remains primary while private registration and add variant move to Other Actions');
  console.log('PASS private and purchase-batch modals are visually and textually distinct');
  console.log('PASS Production group and per-batch clipboard handlers/UI remain byte-for-byte unchanged');
  console.log('PASS Production per-batch clipboard output remains exactly unchanged');
  console.log('PASS cancel, clipboard, and F5 produce zero business-data changes');
  console.log('PASS Production Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill();
}
