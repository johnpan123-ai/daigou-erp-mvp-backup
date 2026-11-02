import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4197';
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
const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4197', '--strictPort',
], {
  cwd: ROOT_PATH,
  env: { ...process.env, VITE_SANDBOX_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stopVite = async () => {
  if (vite.exitCode !== null || vite.signalCode !== null) return;
  const exited = new Promise((resolve, reject) => { vite.once('exit', resolve); vite.once('error', reject); });
  if (!vite.kill('SIGTERM')) throw new Error('Vite cleanup signal was not delivered');
  await exited;
};

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

  // Sample the page: any frame showing the full-page sync loader counts.
  const watch = () => page.evaluate(() => {
    window.__fullPageLoading = []; window.__firstRowAt = null; window.__emptyFrames = 0; const t0 = performance.now();
    const tick = () => { if (document.body.textContent.includes('正在同步雲端資料')) window.__fullPageLoading.push(Math.round(performance.now() - t0)); if (location.pathname === '/purchase-records') { if (document.querySelector('tbody tr, .mobile-card')) { if (window.__firstRowAt === null) window.__firstRowAt = Math.round(performance.now() - t0); } else window.__emptyFrames++; } window.__raf = requestAnimationFrame(tick); };
    cancelAnimationFrame(window.__raf); tick();
  });
  const firstRow = () => page.getByText('合成返回測試商品 0 ', { exact: false }).first();
  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'domcontentloaded' });
  await firstRow().waitFor({ timeout: 60000 });
  const rounds = [];
  for (let round = 0; round < Number(process.env.BACKNAV_ROUNDS || 3); round++) {
    await page.evaluate(() => { history.pushState({}, '', '/purchase-records/g-0'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForURL(url => /\/purchase-records\/g-0/u.test(url.pathname), { timeout: 30000 });
    await sleep(800);
    await watch();
    await page.goBack();
    if (process.env.BACKNAV_SHOTS && round === 1) { for (const ms of [300, 1500, 4000]) { await sleep(ms === 300 ? 300 : ms === 1500 ? 1200 : 2500); await page.screenshot({ path: `${process.env.BACKNAV_SHOTS}/back-${ms}.png` }); } }
    await page.waitForURL(url => url.pathname === '/purchase-records');
    await firstRow().waitFor({ timeout: 60000 });
    await sleep(1500);
    const [loadingFrames, firstRowMs, emptyFrames] = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return [window.__fullPageLoading, window.__firstRowAt, window.__emptyFrames]; });
    rounds.push({ round, firstRowMs, emptyFrames, loadingFrames: loadingFrames.length, loadingUntilMs: loadingFrames.at(-1) ?? 0 });
  }
  // The return preview never replaces the real load: a change made on level 2 shows after the reload.
  await page.evaluate(() => { history.pushState({}, '', '/purchase-records/g-0'); dispatchEvent(new PopStateEvent('popstate')); });
  await sleep(800);
  await page.evaluate(async () => {
    const groups = await window.dataProvider.getProductGroups();
    await window.dataProvider.saveProductGroups(groups.map(g => g.id === 'g-0' ? { ...g, closing_date: '2026-11-15' } : g));
  });
  await page.goBack();
  await page.waitForFunction(() => document.body.textContent.includes('結單 11/15') && ![...document.querySelectorAll('[aria-live="polite"]')].some(el => el.textContent.includes('顯示的是上次載入的資料') && el.getAttribute('aria-hidden') !== 'true'), null, { timeout: 60000 });
  console.log(JSON.stringify({ rounds, supabase: supabaseRequests.length, errors: unexpectedErrors.slice(0, 3) }));
  assert.deepEqual(rounds.map(r => r.loadingFrames), rounds.map(() => 0), 'returning to level 1 must not show the full-page sync loader');
  assert.deepEqual(rounds.map(r => r.emptyFrames), rounds.map(() => 0), 'the first painted level-1 frame already shows the list');
  assert.deepEqual(supabaseRequests, []);
  console.log('PASS back navigation keeps the list on screen');
} finally {
  await context.close();
  await browser.close();
  await stopVite();
}
