import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4200';
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

const N_GROUPS = Number(process.env.BACKNAV_GROUPS || 900), PER = 4;
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
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4200', '--strictPort',
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

  const idle = () => page.evaluate(() => new Promise(resolve => {
    let last = performance.now();
    const tick = () => { const now = performance.now(); if (now - last < 50) resolve(now); else { last = now; requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
  }));
  const N = groups.length;
  const allRows = () => page.waitForFunction(n => document.querySelectorAll('tbody tr, .mobile-product-card').length >= n, N, { timeout: 60000 }).catch(async e => { console.log('DBGCOUNT', await page.evaluate(() => [document.querySelectorAll('tbody tr').length, document.querySelectorAll('.mobile-card').length, document.querySelectorAll('.mobile-card-list').length, location.pathname])); throw e; });
  // The element that actually scrolls the list at this viewport (table wrapper on desktop, page on mobile).
  const scroller = () => page.evaluate(() => {
    const table = document.querySelector('[data-purchase-records-scroll="main"]');
    if (table && table.scrollHeight > table.clientHeight + 200) return '[data-purchase-records-scroll="main"]';
    return '.main-area';
  });
  const centerRowText = sel => page.evaluate(sel => {
    const el = document.querySelector(sel), r = el.getBoundingClientRect();
    const row = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 80))?.closest('tr, .mobile-product-card');
    return row?.textContent?.match(/合成返回測試商品 \d+/u)?.[0] ?? null;
  }, sel);
  const openVisibleRow = async (sel = '.main-area') => {
    const box = await page.evaluate(sel => {
      const s = document.querySelector(sel).getBoundingClientRect();
      const r = document.elementFromPoint(s.left + s.width / 2, Math.min(s.top + s.height / 2, innerHeight - 80))?.closest('tr, .mobile-product-card');
      const cell = r?.querySelector('td:nth-child(2)') || null || r; const b = cell.getBoundingClientRect();
      return { x: b.left + 8, y: b.top + 8 };
    }, sel);
    await page.mouse.click(box.x, box.y);
    await page.waitForURL(url => /\/purchase-records\/g-/u.test(url.pathname), { timeout: 60000 });
    await idle(); await sleep(300);
  };
  const out = {};
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 900 }]]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'domcontentloaded' });
    await allRows(); await idle();
    const sel = await scroller();
    const search = page.locator('input[placeholder^="搜尋品項"]').first();
    const sortSelect = page.locator('select:visible').filter({ has: page.locator('option', { hasText: '開單中優先' }) }).first();
    const sortValue = (await sortSelect.locator('option').evaluateAll(list => list.map(o => o.value)))[1];
    await sortSelect.selectOption(sortValue); await allRows(); await idle();
    await page.locator(sel).evaluate(el => { el.scrollTop = Math.min(el.scrollHeight - el.clientHeight - 10, 9000); });
    await sleep(300);
    const savedTop = await page.locator(sel).evaluate(el => el.scrollTop);
    const before = await centerRowText(sel);
    await openVisibleRow(sel);
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/purchase-records');
    await page.waitForFunction(({ sel, top }) => Math.abs((document.querySelector(sel)?.scrollTop ?? -1) - top) <= 2, { sel, top: savedTop }, { timeout: 30000 }).catch(() => {});
    await idle(); await sleep(400);
    const restoredTop = await page.locator(sel).evaluate(el => el.scrollTop);
    const after = await centerRowText(sel);
    // Search text, filters and sort survive the round trip (stored list state).
    out[label] = { sel, savedTop, restoredTop, before, after, search: await search.inputValue(), sort: await sortSelect.inputValue() };
    assert.equal(out[label].sort, sortValue, `${label}: sort kept`);
    assert.ok(savedTop > 2000, `${label}: scrolled deep (${savedTop})`);
    assert.ok(Math.abs(restoredTop - savedTop) <= 2, `${label}: scroll restored ${restoredTop} vs ${savedTop}`);
    assert.equal(after, before, `${label}: same row back in view`);

    // A fresh entry (not Back) never applies an old position.
    await page.locator(sel).evaluate(el => { el.scrollTop = 4000; });
    await openVisibleRow(sel);
    // In-app link navigation (PUSH), like using the sidebar.
    await page.evaluate(() => document.querySelector('a[href="/unlisted-items"]').click());
    await page.waitForURL(url => url.pathname === '/unlisted-items'); await sleep(800);
    await page.evaluate(() => document.querySelector('a[href="/purchase-records"]').click());
    await page.waitForURL(url => url.pathname === '/purchase-records');
    await page.waitForFunction(() => document.querySelector('tbody tr, .mobile-product-card'));
    await idle(); await sleep(400);
    out[label].freshEntryTop = await page.locator(sel).evaluate(el => el.scrollTop);
    assert.ok(out[label].freshEntryTop < 50, `${label}: fresh entry starts at the top (${out[label].freshEntryTop})`);
  }

  // Cache generation change (authoritative reread / Restore) discards both the return preview and the saved position.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'domcontentloaded' });
  await allRows(); await idle();
  await page.locator('[data-purchase-records-scroll="main"]').evaluate(el => { el.scrollTop = 6000; });
  await openVisibleRow('[data-purchase-records-scroll="main"]');
  await page.evaluate(async () => (await import('/src/lib/viewSnapshotGeneration.ts')).bumpViewSnapshotGeneration());
  await page.evaluate(() => { window.__sawLoader = false; const t = () => { if (document.body.textContent.includes('正在同步雲端資料')) window.__sawLoader = true; window.__r = requestAnimationFrame(t); }; t(); });
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('tbody tr'));
  await idle(); await sleep(400);
  out.generation = { top: await page.locator('[data-purchase-records-scroll="main"]').evaluate(el => el.scrollTop),
    previewDiscarded: await page.evaluate(() => { cancelAnimationFrame(window.__r); return window.__sawLoader; }) };
  assert.ok(out.generation.top < 50, 'stale-generation position not applied');
  assert.equal(out.generation.previewDiscarded, true, 'stale-generation preview not shown (normal first-load path)');
  console.log('SCROLL', JSON.stringify(out));
  assert.deepEqual(supabaseRequests, []); assert.deepEqual(unexpectedErrors, []);
  console.log('PASS purchase-records scroll restore');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
