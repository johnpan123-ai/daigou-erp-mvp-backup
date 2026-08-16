import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import XLSX from 'xlsx';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4194';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const fixture = {
  erp_outbound_shipments: [{ id: 'shipment-export', title: '採購成本匯出測試', status: 'draft', created_at: '2026-08-16T08:00:00.000Z' }],
  erp_outbound_shipment_items: [
    {
      id: 'outbound-a', outbound_shipment_id: 'shipment-export', japan_package_item_id: 'jpi-a',
      product_title: '同 SKU 商品', variant_name: '來源 A', sku: 'SAME-SKU', quantity: 2,
      checked: true, checked_at: '2026-08-16T08:01:00.000Z',
    },
    {
      id: 'outbound-b', outbound_shipment_id: 'shipment-export', japan_package_item_id: 'jpi-b',
      product_title: '同 SKU 商品', variant_name: '來源 B', sku: 'SAME-SKU', quantity: 3,
      checked: false,
    },
    {
      id: 'outbound-manual', outbound_shipment_id: 'shipment-export',
      product_title: '手動商品', variant_name: '無採購關聯', sku: 'MANUAL-SKU', quantity: 1,
      checked: false, note: '台幣單價：233',
    },
    {
      id: 'outbound-direct', outbound_shipment_id: 'shipment-export', japan_package_item_id: 'jpi-direct-fallback',
      purchase_batch_item_id: 'pbi-direct', product_title: '直接關聯商品', variant_name: '直接採購明細',
      sku: 'DIRECT-SKU', quantity: 1, checked: false,
    },
    {
      id: 'outbound-zero', outbound_shipment_id: 'shipment-export', japan_package_item_id: 'jpi-zero',
      product_title: '零成本資料', variant_name: '應視為未設定', sku: 'ZERO-SKU', quantity: 1,
      checked: false,
    },
  ],
  erp_japan_packages: [{ id: 'package-1', title: '測試包裹', status: 'confirmed' }],
  erp_japan_package_items: [
    { id: 'jpi-a', japan_package_id: 'package-1', purchase_batch_item_id: 'pbi-a', sku: 'SAME-SKU', quantity: 2, checked: true },
    { id: 'jpi-b', japan_package_id: 'package-1', purchase_batch_item_id: 'pbi-b', sku: 'SAME-SKU', quantity: 3, checked: true },
    { id: 'jpi-direct-fallback', japan_package_id: 'package-1', purchase_batch_item_id: 'pbi-fallback', sku: 'DIRECT-SKU', quantity: 1, checked: true },
    { id: 'jpi-zero', japan_package_id: 'package-1', purchase_batch_item_id: 'pbi-zero', sku: 'ZERO-SKU', quantity: 1, checked: true },
  ],
  erp_purchase_batch_items: [
    { id: 'pbi-a', purchase_batch_id: 'batch-a', product_variant_id: 'variant-a', quantity: 2, cost: 3850, note: '' },
    { id: 'pbi-b', purchase_batch_id: 'batch-b', product_variant_id: 'variant-a', quantity: 3, cost: 899, note: '' },
    { id: 'pbi-direct', purchase_batch_id: 'batch-direct', product_variant_id: 'variant-direct', quantity: 1, cost: 777, note: '' },
    { id: 'pbi-fallback', purchase_batch_id: 'batch-fallback', product_variant_id: 'variant-direct', quantity: 1, cost: 888, note: '' },
    { id: 'pbi-zero', purchase_batch_id: 'batch-zero', product_variant_id: 'variant-zero', quantity: 1, cost: 0, note: '' },
  ],
  erp_inventory: [
    { myacg_item_code: 'SAME-SKU', product_title: '同 SKU 商品', final_price: 300, myacg_sold_quantity: 5 },
    { myacg_item_code: 'DIRECT-SKU', product_title: '直接關聯商品', final_price: 400, myacg_sold_quantity: 1 },
  ],
  erp_product_groups: [],
  erp_product_categories: [],
  erp_product_variants: [],
  erp_private_order_items: [],
  erp_sales_order_items: [],
  erp_bundle_components: [],
};

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

async function seedTestDb(page) {
  await page.evaluate(async data => {
    localStorage.setItem('erp_provider_mode', 'test');
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db-test-v1', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        store.clear();
        for (const [key, value] of Object.entries(data)) store.put(value, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, fixture);
}

async function readOutboundItems(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db-test-v1', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const items = await new Promise((resolve, reject) => {
      const request = db.transaction('kv', 'readonly').objectStore('kv').get('erp_outbound_shipment_items');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? []);
    });
    db.close();
    return items;
  });
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
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
  await seedTestDb(page);
  const before = await readOutboundItems(page);
  await page.goto(`${BASE_URL}/outbound-shipments/shipment-export`, { waitUntil: 'networkidle' });

  assert.equal(await page.getByRole('button', { name: /匯出商品清單/ }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /匯出 XLS/ }).count(), 0);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /匯出商品清單/ }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  assert.ok(downloadPath, 'XLS export should produce a local download');

  const workbook = XLSX.readFile(downloadPath);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  assert.equal(rows.length, 5, 'UI export must preserve original outbound item rows');

  const sameSkuRows = rows.filter(row => row['子編號(商品編號)'] === 'SAME-SKU');
  assert.equal(sameSkuRows.length, 2, 'Same SKU from two batches must remain two export rows');
  assert.deepEqual(sameSkuRows.map(row => row['採購日幣單價']), [3850, 899]);
  assert.equal(typeof sameSkuRows[0]['採購日幣單價'], 'number');
  assert.equal(String(sameSkuRows[0]['採購日幣單價']).includes('¥'), false);

  const manualRow = rows.find(row => row['子編號(商品編號)'] === 'MANUAL-SKU');
  assert.equal(manualRow['價格'], 233, 'Existing manual TWD price export must remain unchanged');
  assert.equal(manualRow['採購日幣單價'], '', 'Item without an explicit purchase link must remain blank');

  const directRow = rows.find(row => row['子編號(商品編號)'] === 'DIRECT-SKU');
  assert.equal(directRow['採購日幣單價'], 777, 'Direct purchase_batch_item_id must take priority over package fallback');

  const zeroRow = rows.find(row => row['子編號(商品編號)'] === 'ZERO-SKU');
  assert.equal(zeroRow['採購日幣單價'], '', 'Linked cost 0 must be exported as a blank cell');
  assert.notEqual(zeroRow['採購日幣單價'], 0);
  assert.notEqual(zeroRow['採購日幣單價'], '0');
  assert.notEqual(zeroRow['採購日幣單價'], 'null');
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null });
  const costColumnIndex = matrix[0].indexOf('採購日幣單價');
  const zeroSheetRowIndex = matrix.findIndex(row => row[1] === 'ZERO-SKU');
  const zeroCostCell = workbook.Sheets[workbook.SheetNames[0]][XLSX.utils.encode_cell({ r: zeroSheetRowIndex, c: costColumnIndex })];
  assert.equal(zeroCostCell === undefined || zeroCostCell.v === '', true, 'Excel cell must not contain numeric/string zero or null');

  const after = await readOutboundItems(page);
  assert.deepEqual(after, before, 'Export must not modify outbound items or checked state');
  assert.deepEqual(productionSupabaseRequests, [], 'Export must not contact Production Supabase');
  assert.deepEqual(unexpectedErrors, []);

  console.log('PASS button label is 匯出商品清單 and existing export action remains');
  console.log('PASS purchase JPY unit cost follows explicit outbound -> Japan package item -> purchase batch item relation');
  console.log('PASS same SKU from different purchase batches preserves separate rows and costs');
  console.log('PASS unresolved/null/zero purchase cost stays blank and no fallback is used');
  console.log('PASS XLS cost cells are numeric and checked / checked_at data remains unchanged');
  console.log('PASS Production Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
