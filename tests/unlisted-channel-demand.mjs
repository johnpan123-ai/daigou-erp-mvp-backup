import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4195';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const IMPORT_ID = 'unlisted-channel-demand-fixture';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const storageKeys = {
  inventory: 'erp_inventory', salesOrders: 'erp_sales_orders', salesOrderItems: 'erp_sales_order_items',
  productGroups: 'erp_product_groups', productCategories: 'erp_product_categories', productVariants: 'erp_product_variants',
  purchaseBatches: 'erp_purchase_batches', purchaseBatchItems: 'erp_purchase_batch_items',
  privateOrders: 'erp_private_orders', privateOrderItems: 'erp_private_order_items',
  bundleComponents: 'erp_bundle_components', japanPackages: 'erp_japan_packages', japanPackageItems: 'erp_japan_package_items',
  outboundShipments: 'erp_outbound_shipments', outboundShipmentItems: 'erp_outbound_shipment_items',
};

const groups = [
  { id: 'group-private', title: 'Private Demand Product', normalized_title: 'Private Demand Product', closing_date: '2026-01-01', product_url: 'https://myacg.example/private', listing_type: '日本代購' },
  { id: 'group-mixed', title: 'Mixed Demand Product', normalized_title: 'Mixed Demand Product', closing_date: '2026-02-01', product_url: 'https://myacg.example/mixed', listing_type: '日本代購' },
  { id: 'group-zero', title: 'Zero Demand Product', normalized_title: 'Zero Demand Product', closing_date: '2026-03-01', product_url: 'https://waca.example/zero', listing_type: '日本代購' },
];
const variants = [
  { id: 'variant-private', product_group_id: 'group-private', myacg_item_code: 'SKU-PRIVATE', product_title: 'Private Demand Product', variant_name: 'A', effective_myacg_quantity: 200, myacg_manual_adjustment: 0, waca_auto_quantity: 100, waca_manual_adjustment: 0, private_manual_adjustment: 0 },
  { id: 'variant-mixed', product_group_id: 'group-mixed', myacg_item_code: 'SKU-MIXED', product_title: 'Mixed Demand Product', variant_name: 'A', effective_myacg_quantity: 4, myacg_manual_adjustment: 0, waca_auto_quantity: 6, waca_manual_adjustment: 0, private_manual_adjustment: 0 },
  { id: 'variant-zero', product_group_id: 'group-zero', myacg_item_code: 'SKU-ZERO', product_title: 'Zero Demand Product', variant_name: 'A', effective_myacg_quantity: 0, myacg_manual_adjustment: 0, waca_auto_quantity: 0, waca_manual_adjustment: 0, private_manual_adjustment: 0 },
];
const fixture = {
  inventory: variants.map(variant => ({
    inventory_key: `${variant.myacg_item_code}::A`, myacg_item_code: variant.myacg_item_code,
    product_title: variant.product_title, raw_variant_name: 'A', listing_type: '日本代購', final_price: 1000,
    myacg_available_quantity: 0, myacg_sold_quantity: 0, myacg_listed_at: '2026-01-01',
    latest_catalog_import_id: IMPORT_ID, catalog_last_seen_at: '2026-08-24T00:00:00.000Z',
  })),
  salesOrders: [], salesOrderItems: [], productGroups: groups, productCategories: [], productVariants: variants,
  purchaseBatches: [
    { id: 'batch-private', product_group_id: 'group-private', batch_name: 'Private Batch' },
    { id: 'batch-mixed', product_group_id: 'group-mixed', batch_name: 'Mixed Batch' },
  ],
  purchaseBatchItems: [
    { id: 'batch-item-private', purchase_batch_id: 'batch-private', product_variant_id: 'variant-private', quantity: 50 },
    { id: 'batch-item-mixed', purchase_batch_id: 'batch-mixed', product_variant_id: 'variant-mixed', quantity: 3 },
  ],
  privateOrders: [{ id: 'private-order', product_group_id: 'group-private', customer_name: 'Fixture' }],
  privateOrderItems: [
    { id: 'private-item-1', private_order_id: 'private-order', product_variant_id: 'variant-private', quantity: 99 },
    { id: 'private-item-2', private_order_id: 'private-order', product_variant_id: 'variant-private', quantity: 99 },
  ],
  bundleComponents: [], japanPackages: [], japanPackageItems: [], outboundShipments: [], outboundShipmentItems: [],
};

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4195', '--strictPort',
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
      // Vite is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1440, height: 1000 } });
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

const readCollections = () => page.evaluate(async keys => new Promise((resolve, reject) => {
  const request = indexedDB.open('daigou-erp-db-test-v1', 1);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('kv', 'readonly');
    const store = tx.objectStore('kv');
    const result = {};
    let remaining = Object.entries(keys).length;
    for (const [field, key] of Object.entries(keys)) {
      const get = store.get(key);
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        result[field] = get.result ?? [];
        remaining -= 1;
        if (remaining === 0) { db.close(); resolve(result); }
      };
    }
  };
}), storageKeys);

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ data, keys, importId }) => {
    localStorage.clear();
    localStorage.setItem('erp_provider_mode', 'test');
    localStorage.setItem('erp_unlisted_processed_local', JSON.stringify({
      catalog_import_id: importId, processed_group_ids: [], processed_at_map: {},
    }));
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
        for (const [field, key] of Object.entries(keys)) store.put(data[field] ?? [], key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { data: fixture, keys: storageKeys, importId: IMPORT_ID });
  await page.reload({ waitUntil: 'networkidle' });

  await page.evaluate(() => {
    window.__unlistedDataWrites = [];
    const provider = window.dataProvider;
    const prototype = Object.getPrototypeOf(provider);
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (!/^(save|update|create|delete|clear|restore|import)/i.test(name) || typeof provider[name] !== 'function') continue;
      const original = provider[name].bind(provider);
      provider[name] = async (...args) => {
        window.__unlistedDataWrites.push(name);
        return original(...args);
      };
    }
  });

  const before = await readCollections();
  await page.getByRole('link', { name: '待下架商品' }).click();
  await page.waitForURL(`${BASE_URL}/unlisted-items`);
  try {
    await page.locator('[data-unlisted-channel-demand]').first().waitFor({ state: 'visible' });
  } catch (error) {
    console.error(JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), unexpectedErrors }, null, 2));
    throw error;
  }

  const rows = await page.locator('[data-unlisted-channel-demand]').evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute('data-unlisted-channel-demand'),
    myacg: element.querySelector('[data-channel-demand="myacg"]')?.textContent?.trim(),
    waca: element.querySelector('[data-channel-demand="waca"]')?.textContent?.trim(),
    privateOrder: element.querySelector('[data-channel-demand="private-order"]')?.textContent?.trim(),
  })));
  assert.deepEqual(rows, [
    { id: 'group-private', myacg: '買動漫 200', waca: 'WACA 100', privateOrder: '私下登記 198' },
    { id: 'group-mixed', myacg: '買動漫 4', waca: 'WACA 6', privateOrder: '私下登記 0' },
    { id: 'group-zero', myacg: '買動漫 0', waca: 'WACA 0', privateOrder: '私下登記 0' },
  ]);
  console.log('PASS unlisted rows display accepted MyACG/WACA/private-order quantities, including explicit zeroes');

  const summaryText = await page.locator('tbody').innerText();
  assert.match(summaryText, /Private Demand Product[\s\S]*需求 498[\s\S]*已採購 50[\s\S]*尚缺 448/);
  assert.match(summaryText, /Mixed Demand Product[\s\S]*需求 10[\s\S]*已採購 3[\s\S]*尚缺 7/);
  assert.match(summaryText, /Zero Demand Product[\s\S]*需求 0[\s\S]*已採購 0/);
  console.log('PASS existing total demand, purchased, and gap summaries remain unchanged; 200 + 100 + 198 = 498');

  const after = await readCollections();
  assert.deepEqual(after, before);
  assert.deepEqual(await page.evaluate(() => window.__unlistedDataWrites), []);
  assert.deepEqual(supabaseRequests, []);
  assert.deepEqual(unexpectedErrors, []);
  console.log('PASS item count/order/identity and all stored collections remain unchanged; data writes = 0');

  const variantIds = new Set(after.productVariants.map(variant => variant.id));
  const groupIds = new Set(after.productGroups.map(group => group.id));
  const orderIds = new Set(after.privateOrders.map(order => order.id));
  assert.equal(after.productVariants.filter(variant => !groupIds.has(variant.product_group_id)).length, 0);
  assert.equal(after.privateOrderItems.filter(item => !variantIds.has(item.product_variant_id) || !orderIds.has(item.private_order_id)).length, 0);
  assert.equal(after.productVariants.filter(variant => variant.catalog_missing === true).length, 0);
  console.log('PASS Bundle/Variant identity unchanged, orphan new delta = 0, Unknown Product new risk = 0');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
