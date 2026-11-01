import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4199';
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

const N_GROUPS = Number(process.env.BACKNAV_GROUPS || 1600), PER = 4;
const groups = [], variants = [], inventory = [];
for (let g = 0; g < N_GROUPS; g++) {
  const title = `合成返回測試商品 ${g} ` + '長標題'.repeat(8);
  groups.push({ id: `g-${g}`, title, normalized_title: title, closing_date: '2026-12-01', product_url: '', listing_type: '日本代購', show_in_purchase_list: true,
    purchase_date: '2026/10/01', priority: 'Medium', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' });
  for (let v = 0; v < PER; v++) {
    const code = `BN${g}-${v}`;
    variants.push({ id: `v-${g}-${v}`, product_group_id: `g-${g}`, myacg_item_code: code, product_title: title, variant_name: `款式 ${v}`, raw_variant_name: `款式 ${v}`,
      effective_myacg_quantity: 2, myacg_manual_adjustment: 0, waca_auto_quantity: 0, waca_manual_adjustment: 0, private_manual_adjustment: 0, sort_order: v, note: '合成'.repeat(10) });
    inventory.push({ inventory_key: `${code}::A`, myacg_item_code: code, product_title: title, raw_variant_name: `款式 ${v}`, listing_type: '日本代購', final_price: 1000,
      myacg_available_quantity: 1, myacg_sold_quantity: 2, myacg_listed_at: '2026-01-01', description: '說明'.repeat(60) });
  }
}
const fixture = { inventory, salesOrders: [], salesOrderItems: [], productGroups: groups, productCategories: [], productVariants: variants,
  purchaseBatches: [], purchaseBatchItems: [], privateOrders: [], privateOrderItems: [], bundleComponents: [], japanPackages: [], japanPackageItems: [], outboundShipments: [], outboundShipmentItems: [] };
const IMPORT_ID_UNUSED = IMPORT_ID;
// PERF_PREVIEW=1 measures the production build (vite build + preview) instead of the dev server.
const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const PREVIEW_DIR = process.env.PERF_PREVIEW ? `${process.env.TMPDIR || '/tmp'}/purchase-records-perf-dist` : '';
if (PREVIEW_DIR) {
  const { spawnSync } = await import('node:child_process');
  const built = spawnSync(process.execPath, [VITE_BIN, 'build', '--mode', 'experimental', '--outDir', PREVIEW_DIR, '--emptyOutDir'],
    { cwd: ROOT_PATH, env: { ...process.env, VITE_SANDBOX_ENV: 'test' }, stdio: 'pipe' });
  if (built.status !== 0) throw new Error(`build failed: ${String(built.stderr).slice(-800)}`);
}
const vite = spawn(process.execPath, [
  VITE_BIN, ...(PREVIEW_DIR ? ['preview', '--outDir', PREVIEW_DIR] : []),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4199', '--strictPort',
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

  const cdp = await context.newCDPSession(page);
  const idle = () => page.evaluate(() => new Promise(resolve => {
    // Main thread settled: two consecutive frames closer than 50 ms.
    let last = performance.now();
    const tick = () => { const now = performance.now(); if (now - last < 50) resolve(now); else { last = now; requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
  }));
  // Time from the action until the expected number of rows is in the DOM and the thread is idle.
  const timed = async (action, expectRows) => {
    const t0 = await page.evaluate(() => performance.now()); await action();
    await page.waitForFunction(n => document.querySelectorAll('tbody tr').length === n, expectRows, { timeout: 120000, polling: 16 });
    const t1 = await idle(); return Math.round(t1 - t0);
  };
  const rowCount = () => page.evaluate(() => document.querySelectorAll('tbody tr').length);
  const scrollEl = () => page.locator('.main-area');
  const result = {};

  // 1/2 cold load: first visible row and settled (interactive) time from navigation start.
  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.querySelector('tbody tr'), null, { timeout: 120000, polling: 50 });
  result.coldFirstRowMs = Math.round(await page.evaluate(() => performance.now()));
  result.coldSettledMs = Math.round(await idle());
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 1600, null, { timeout: 120000, polling: 16 });
  result.coldAllRowsMs = Math.round(await idle());
  // wait for the background fresh load to finish
  await page.waitForFunction(() => ![...document.querySelectorAll('[aria-live="polite"]')].some(el => el.textContent.includes('顯示的是上次載入的資料') && el.getAttribute('aria-hidden') !== 'true'), null, { timeout: 120000 });
  await idle();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 1600, null, { timeout: 120000 });
  result.rows = await rowCount();
  result.scroller = await scrollEl().evaluate(el => ({ h: el.scrollHeight, c: el.clientHeight, doc: document.scrollingElement.scrollHeight, tall: [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 500 && getComputedStyle(e).overflowY !== 'visible').map(e => e.className.toString().slice(0, 40)).slice(0, 5) }));

  // 3/5 detail -> back, with scroll position restore (real row click like the Owner).
  const back = [];
  for (let round = 0; round < 3; round++) {
    await scrollEl().evaluate(el => { el.scrollTop = 3000; });
    await sleep(200);
    const savedTop = await scrollEl().evaluate(el => el.scrollTop);
    const row = page.locator('tbody tr').nth(15);
    await row.locator('td').nth(1).click();
    await page.waitForURL(url => /\/purchase-records\/g-/u.test(url.pathname), { timeout: 60000 });
    await idle(); await sleep(300);
    const t0 = await page.evaluate(() => performance.now());
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/purchase-records' && document.querySelector('tbody tr'), null, { timeout: 120000, polling: 16 });
    const firstRow = await page.evaluate(() => performance.now());
    const settled = await idle();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 1600, null, { timeout: 120000, polling: 16 });
    const allRows = await idle(); await sleep(300);
    back.push({ firstRowMs: Math.round(firstRow - t0), settledMs: Math.round(settled - t0), allRowsMs: Math.round(allRows - t0), savedTop, restoredTop: await scrollEl().evaluate(el => el.scrollTop) });
  }
  result.back = back;

  // 4 search / filter / sort
  const search = page.locator('input[placeholder^="搜尋品項"]').first();
  result.searchMs = await timed(() => search.fill('合成返回測試商品 1234'), 1);
  result.searchRows = await rowCount();
  result.clearSearchMs = await timed(() => search.fill(''), result.rows);
  result.clearRows = await rowCount();
  result.filterMs = await timed(() => page.locator('label', { hasText: '只看需要採購' }).first().click(), result.rows);
  result.filterRows = await rowCount();
  await page.locator('label', { hasText: '只看需要採購' }).first().click();
  await page.waitForFunction(n => document.querySelectorAll('tbody tr').length === n, result.rows, { timeout: 120000 }); await idle();
  const sortSelect = page.locator('select').filter({ has: page.locator('option', { hasText: '開單中優先' }) }).first();
  const options = await sortSelect.locator('option').evaluateAll(list => list.map(o => o.value));
  result.sortMs = await timed(() => sortSelect.selectOption(options[1]), result.rows);
  result.sortRows = await rowCount();
  await sortSelect.selectOption(options[0]);
  await page.waitForFunction(n => document.querySelectorAll('tbody tr').length === n, result.rows, { timeout: 120000 }); await idle();

  // 7 memory + network
  await cdp.send('HeapProfiler.collectGarbage');
  result.heapMB = Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576);
  result.supabase = supabaseRequests.length;

  // 6 edit on level 2 then return: list shows the saved value.
  await page.locator('tbody tr').nth(0).locator('td').nth(1).click();
  await page.waitForURL(url => /\/purchase-records\/g-/u.test(url.pathname));
  const editedId = new URL(page.url()).pathname.split('/').pop();
  await page.evaluate(async id => {
    const groups = await window.dataProvider.getProductGroups();
    await window.dataProvider.saveProductGroups(groups.map(g => g.id === id ? { ...g, closing_date: '2026-11-15' } : g));
  }, editedId);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('tbody tr')?.textContent?.includes('結單 11/15'), null, { timeout: 120000 });
  result.editVisibleAfterReturn = true;
  console.log('PERF', JSON.stringify(result));
  assert.equal(result.searchRows, 1); assert.equal(result.clearRows, result.rows); assert.equal(result.sortRows, result.rows);
  for (const r of back) assert.ok(Math.abs(r.restoredTop - r.savedTop) <= 2, `scroll restored ${r.restoredTop} vs ${r.savedTop}`);
  assert.deepEqual(supabaseRequests, []); assert.deepEqual(unexpectedErrors, []);
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
