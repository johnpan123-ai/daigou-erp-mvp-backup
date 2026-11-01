import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4196';
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
  { id: 'group-mixed', title: '代理版 SEGA 景品 BanG Dream Yumemirize 八幡海鈴 睡衣派對 合成測試用超長商品名稱 第二行折行確認 附贈特典壓克力立牌與徽章套組', normalized_title: '代理版 SEGA 景品 BanG Dream Yumemirize 八幡海鈴 睡衣派對 合成測試用超長商品名稱 第二行折行確認 附贈特典壓克力立牌與徽章套組', closing_date: '2026-02-01', product_url: 'https://myacg.example/mixed', listing_type: '日本代購' },
  { id: 'group-zero', title: 'Zero Demand Product', normalized_title: 'Zero Demand Product', closing_date: '2026-03-01', product_url: 'https://waca.example/zero', listing_type: '日本代購' },
];
const variants = [
  { id: 'variant-private', product_group_id: 'group-private', myacg_item_code: 'SKU-PRIVATE', product_title: 'Private Demand Product', variant_name: 'A', effective_myacg_quantity: 200, myacg_manual_adjustment: 0, waca_auto_quantity: 100, waca_manual_adjustment: 0, private_manual_adjustment: 0 },
  { id: 'variant-mixed', product_group_id: 'group-mixed', myacg_item_code: 'SKU-MIXED', product_title: '代理版 SEGA 景品 BanG Dream Yumemirize 八幡海鈴 睡衣派對 合成測試用超長商品名稱 第二行折行確認 附贈特典壓克力立牌與徽章套組', variant_name: 'A', effective_myacg_quantity: 4, myacg_manual_adjustment: 0, waca_auto_quantity: 6, waca_manual_adjustment: 0, private_manual_adjustment: 0 },
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
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4196', '--strictPort',
], {
  cwd: ROOT_PATH,
  env: { ...process.env, VITE_SANDBOX_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
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

  const SHOTS = process.env.UNLISTED_TITLE_SHOTS || '';
  const geometry = () => page.locator('[data-testid="unlisted-title-row"]').evaluateAll(rows => rows.map(row => {
    const title = row.firstElementChild, actions = row.querySelector('[data-testid="unlisted-title-actions"]');
    const range = document.createRange(); range.selectNodeContents(title);
    const lines = [...range.getClientRects()]; const last = lines[lines.length - 1];
    const t = title.getBoundingClientRect(), a = actions.getBoundingClientRect(), r = row.getBoundingClientRect();
    const cell = row.closest('td, .mobile-card') .getBoundingClientRect();
    return { text: title.textContent.slice(0, 12), lines: new Set(lines.map(x => Math.round(x.top))).size,
      gap: Math.round(a.left - last.right), sameLine: a.top < last.bottom && a.bottom > last.top,
      rightSlack: Math.round(cell.right - a.right), buttons: actions.querySelectorAll('button, a').length,
      labels: [...actions.querySelectorAll('button, a')].map(x => x.getAttribute('aria-label')) };
  }));
  const result = {};
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 900 }]]) {
    await page.setViewportSize(viewport); await sleep(400);
    await page.locator('[data-testid="unlisted-title-row"]').first().waitFor();
    const rows = await geometry(); result[label] = rows;
    assert.equal(rows.length, 3, label);
    for (const row of rows) {
      assert.deepEqual(row.labels, ['複製商品名稱', '查看訂購紀錄'], `${label}: copy then external link`);
      assert.ok(row.gap >= 2 && row.gap <= 10, `${label}: buttons hug the end of the name (${row.gap}px)`);
      assert.ok(row.sameLine, `${label}: buttons on the name's last line`);
      if (row.lines === 1) assert.ok(row.rightSlack > 40, `${label}: not pushed to the right edge`);
    }
    if (label === 'mobile') assert.ok(rows.some(row => row.lines > 1), 'mobile: long title wraps');
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/unlisted-${label}.png` });
      const longRow = page.locator('[data-testid="unlisted-title-row"]').nth(1);
      await longRow.scrollIntoViewIfNeeded();
      await longRow.locator('xpath=ancestor::*[self::tr or contains(@class,"mobile-card")][1]').screenshot({ path: `${SHOTS}/unlisted-${label}-long.png` });
    }
  }
  // Copy still copies the name; link still opens purchase records.
  await page.setViewportSize({ width: 1440, height: 1000 }); await sleep(300);
  // Status badges row unchanged.
  assert.match(await page.locator('tbody').innerText(), /需求 498[\s\S]*已採購 50[\s\S]*尚缺 448/);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('[data-testid="unlisted-title-actions"]').first().getByLabel('複製商品名稱').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Private Demand Product');
  const after = await readCollections();
  assert.deepEqual(after, before); assert.deepEqual(await page.evaluate(() => window.__unlistedDataWrites), []);
  assert.deepEqual(supabaseRequests, []); assert.deepEqual(unexpectedErrors, []);
  await page.locator('[data-testid="unlisted-title-actions"]').first().getByLabel('查看訂購紀錄').click();
  await page.waitForURL(url => url.pathname.startsWith('/purchase-records'));
  console.log(JSON.stringify({ result: 'PASS', ...result }));
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
