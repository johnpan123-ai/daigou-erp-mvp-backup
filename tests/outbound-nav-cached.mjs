import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4201';
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
const at = '2026-10-20T00:00:00.000Z';
const japanPackages = [], japanPackageItems = [], outboundShipments = [], outboundShipmentItems = [];
for (let p = 0; p < 80; p++) {
  japanPackages.push({ id: `jp-${p}`, title: `合成包裹 ${p}`, status: 'confirmed', arrived_at: '2026-10-21', created_at: at, updated_at: at });
  for (let k = 0; k < 12; k++) { const g = (p * 12 + k) % N_GROUPS, v = k % PER;
    japanPackageItems.push({ id: `jpi-${p}-${k}`, japan_package_id: `jp-${p}`, product_group_id: `g-${g}`, product_variant_id: `v-${g}-${v}`, product_title: groups[g].title,
      variant_name: `款式 ${v}`, sku: `BN${g}-${v}`, quantity: 3, checked: true, checked_at: at, created_at: at, updated_at: at }); }
}
for (let o = 0; o < 40; o++) {
  outboundShipments.push({ id: `ob-${o}`, title: `合成出庫單 ${o}`, status: o % 3 === 0 ? 'received' : 'draft', created_at: at, updated_at: at, ...(o % 3 === 0 ? { received_at: at } : {}) });
  for (let k = 0; k < 24; k++) { const src = japanPackageItems[(o * 24 + k) % japanPackageItems.length];
    outboundShipmentItems.push({ id: `obi-${o}-${k}`, outbound_shipment_id: `ob-${o}`, japan_package_item_id: src.id, product_group_id: src.product_group_id, product_variant_id: src.product_variant_id,
      product_title: src.product_title, variant_name: src.variant_name, sku: src.sku, quantity: 1 + (k % 2), checked: k % 4 === 0, created_at: at, updated_at: at }); }
}
const fixture = { inventory, salesOrders: [], salesOrderItems: [], productGroups: groups, productCategories: [], productVariants: variants,
  purchaseBatches: [], purchaseBatchItems: [], privateOrders: [], privateOrderItems: [], bundleComponents: [], japanPackages, japanPackageItems, outboundShipments, outboundShipmentItems };
const IMPORT_ID_UNUSED = IMPORT_ID;
// PERF_PREVIEW=1 measures the production build (vite build + preview) instead of the dev server.
const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const PREVIEW_DIR = process.env.PERF_PREVIEW ? `${process.env.TMPDIR || '/tmp'}/outbound-nav-perf-dist` : '';
if (PREVIEW_DIR) {
  const { spawnSync } = await import('node:child_process');
  const built = spawnSync(process.execPath, [VITE_BIN, 'build', '--mode', 'experimental', '--outDir', PREVIEW_DIR, '--emptyOutDir'],
    { cwd: ROOT_PATH, env: { ...process.env, VITE_SANDBOX_ENV: 'test' }, stdio: 'pipe' });
  if (built.status !== 0) throw new Error(`build failed: ${String(built.stderr).slice(-800)}`);
}
const vite = spawn(process.execPath, [
  VITE_BIN, ...(PREVIEW_DIR ? ['preview', '--outDir', PREVIEW_DIR] : []),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4201', '--strictPort',
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

  const watch = () => page.evaluate(() => {
    window.__loaderFrames = 0; window.__blankFrames = 0; window.__firstContentAt = null; const t0 = performance.now();
    window.__t0 = t0;
    const tick = () => {
      const text = document.querySelector('.page-content, main')?.textContent ?? document.body.textContent;
      if (/載入中\.\.\.|正在同步雲端資料/u.test(text)) window.__loaderFrames++;
      const ready = window.__ready?.();
      if (ready) { if (window.__firstContentAt === null) window.__firstContentAt = Math.round(performance.now() - t0); } else window.__blankFrames++;
      window.__raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(window.__raf); tick();
  });
  const stop = () => page.evaluate(() => { cancelAnimationFrame(window.__raf); return { loaderFrames: window.__loaderFrames, blankFrames: window.__blankFrames, contentMs: window.__firstContentAt }; });
  const setReady = kind => page.evaluate(kind => {
    window.__ready = kind === 'list'
      ? () => location.pathname === '/outbound-shipments' && document.body.textContent.includes('合成出庫單 3')
      : () => /^\/outbound-shipments\/ob-3$/u.test(location.pathname) && document.body.textContent.includes('合成出庫單 3') && document.body.textContent.includes('BN');
  }, kind);
  const result = {};
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 900 }]]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/outbound-shipments`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.textContent.includes('合成出庫單 3'), null, { timeout: 120000 });
    await sleep(800);
    const rounds = [];
    for (let round = 0; round < 5; round++) {
      await setReady('detail'); await watch();
      await page.evaluate(() => document.querySelector('a[href^="/outbound-shipments/ob-3"]') ? document.querySelector('a[href^="/outbound-shipments/ob-3"]').click() : (history.pushState({}, '', '/outbound-shipments/ob-3'), dispatchEvent(new PopStateEvent('popstate'))));
      await page.waitForFunction(() => window.__ready(), null, { timeout: 120000, polling: 16 });
      await sleep(600);
      const enter = await stop();
      // detail correctness: this shipment's own lines only
      const detail = await page.evaluate(() => ({ title: document.body.textContent.includes('合成出庫單 3'), other: /合成出庫單 4\b/u.test(document.querySelector('h1, h2')?.textContent ?? '') }));
      await setReady('list'); await watch();
      await page.goBack();
      await page.waitForFunction(() => window.__ready(), null, { timeout: 120000, polling: 16 });
      await sleep(600);
      const back = await stop();
      rounds.push({ enter, back, detailOk: detail.title && !detail.other });
    }
    result[label] = rounds;
  }
  // Own edit (點收) on level 2 is what the next remount paints first: no frame shows the pre-edit state.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const openDetail = () => page.evaluate(() => document.querySelector('a[href^="/outbound-shipments/ob-3"]') ? document.querySelector('a[href^="/outbound-shipments/ob-3"]').click() : (history.pushState({}, '', '/outbound-shipments/ob-3'), dispatchEvent(new PopStateEvent('popstate'))));
  const checkedCount = () => page.evaluate(() => document.querySelectorAll('[data-testid="outbound-receiving-row"] button[aria-label^="取消 "]').length);
  await openDetail();
  await page.waitForFunction(() => document.querySelector('[data-testid="outbound-receiving-row"]'), null, { timeout: 60000 });
  const checkedBefore = await checkedCount();
  await page.locator('[data-testid="outbound-receiving-row"] button[aria-label^="完成 "]').first().click();
  await page.waitForFunction(n => document.querySelectorAll('[data-testid="outbound-receiving-row"] button[aria-label^="取消 "]').length === n + 1
    && !document.querySelector('[data-testid="outbound-receiving-row"][data-pending="true"]'), checkedBefore, { timeout: 30000 });
  await sleep(500);
  await page.goBack(); await page.waitForFunction(() => location.pathname === '/outbound-shipments' && document.body.textContent.includes('合成出庫單 3')); await sleep(500);
  await page.evaluate(() => { window.__checkedFrames = []; const t = () => { const rows = document.querySelectorAll('[data-testid="outbound-receiving-row"]');
    if (rows.length) window.__checkedFrames.push(document.querySelectorAll('[data-testid="outbound-receiving-row"] button[aria-label^="取消 "]').length); window.__r2 = requestAnimationFrame(t); }; t(); });
  await openDetail();
  await page.waitForFunction(() => document.querySelector('[data-testid="outbound-receiving-row"]')); await sleep(1500);
  const frames = await page.evaluate(() => { cancelAnimationFrame(window.__r2); return window.__checkedFrames; });
  const edit = { checkedBefore, expected: checkedBefore + 1, distinct: [...new Set(frames)] };
  assert.deepEqual(edit.distinct, [checkedBefore + 1], 'remount never shows the pre-edit receiving state');
  const stored = await page.evaluate(async () => (await window.dataProvider.getOutboundShipmentItems()).filter(i => i.outbound_shipment_id === 'ob-3' && i.checked).length);
  edit.storedChecked = stored;

  // Cache generation change (authoritative reread / Restore): the next detail mount cold-loads, never repaints the old read.
  await page.goBack(); await page.waitForFunction(() => location.pathname === '/outbound-shipments'); await sleep(500);
  let afterBump = 'skipped (preview build)';
  if (!PREVIEW_DIR) {
    await page.evaluate(async () => (await import('/src/lib/viewSnapshotGeneration.ts')).bumpViewSnapshotGeneration());
    await setReady('detail'); await watch();
    await openDetail();
    await page.waitForFunction(() => window.__ready(), null, { timeout: 120000, polling: 16 }); await sleep(500);
    afterBump = await stop();
    assert.ok(afterBump.loaderFrames > 0, 'stale-generation cache is not used (cold load)');
  }
  // Blue external-link button of a group: opens the MyACG member-center list page in a new tab only.
  await page.waitForFunction(() => document.querySelector('[data-testid="outbound-myacg-button"]'), null, { timeout: 60000 });
  const linkCheck = await page.evaluate(async () => {
    const calls = []; const original = window.open;
    window.open = (...args) => { calls.push(args); return null; };
    try { navigator.clipboard.writeText = async () => {}; } catch { /* clipboard stub unavailable */ }
    const before = location.href;
    document.querySelector('[data-testid="outbound-myacg-button"]').click();
    await new Promise(resolve => setTimeout(resolve, 200));
    window.open = original;
    return { calls, stayed: location.href === before };
  });
  assert.deepEqual(linkCheck.calls, [['https://www.myacg.com.tw/member_center_v2.php?e_id=1&list_type=3', '_blank', 'noopener,noreferrer']], 'member-center list page in a new tab');
  assert.equal(linkCheck.stayed, true, 'ERP page stays where it was');
  console.log('OUTNAV', JSON.stringify({ result, edit, afterBump, linkCheck, supabase: supabaseRequests.length, errors: unexpectedErrors.slice(0, 3) }));
  for (const label of Object.keys(result)) for (const r of result[label]) {
    assert.ok(r.detailOk, `${label}: correct shipment`);
    assert.equal(r.back.loaderFrames, 0, `${label}: list return without full-page loader`);
    if (r !== result[label][0]) assert.equal(r.enter.loaderFrames, 0, `${label}: detail entry without full-page loader once data is cached`);
  }
  assert.deepEqual(supabaseRequests, []); assert.deepEqual(unexpectedErrors, []);
  console.log('PASS outbound navigation keeps content on screen');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
