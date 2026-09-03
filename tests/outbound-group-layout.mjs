import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const TEST_PORT = Number(process.env.OUTBOUND_GROUP_LAYOUT_TEST_PORT || 4294);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHIPMENT_ID = 'shipment-layout';
const GROUP_NAME = '代理版 超長商品群組名稱 Hololive SUPER EXPO 2026 限定紀念套組 商品名稱完整顯示測試';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const source = await readFile(new URL('../src/pages/OutboundShipmentDetail.tsx', import.meta.url), 'utf8');
assert.ok(source.includes('data-testid="outbound-group-title"'), 'Product name must occupy the first row');
assert.ok(source.includes('data-testid="outbound-group-meta"'), 'Counts and actions must occupy the second row');
assert.ok(source.includes('title={groupName}'), 'Long names must retain the full-name tooltip');
assert.ok(source.includes("? '已複製' : '複製名稱'"), 'Existing desktop copy label must remain unchanged');
assert.ok(source.includes("minWidth: isMobile ? 44 : undefined"), 'Mobile copy touch target must be at least 44px');
assert.ok(source.includes("width: isMobile ? 44 : 28"), 'MyACG touch target must be 44px on mobile and retain desktop size');
assert.ok(source.includes("gap: isMobile ? 8 : 4"), 'Mobile actions must have clear spacing');
assert.ok(source.includes("flexWrap: isMobile ? 'wrap' : 'nowrap'"), 'Mobile actions may wrap without compressing the title');
assert.ok(source.includes('openMyacgForGroup(groupName)'), 'Existing MyACG action must keep the same group-name source');

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', String(TEST_PORT), '--strictPort',
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

const fixture = {
  inventory: [], salesOrders: [], salesOrderItems: [], productGroups: [], productCategories: [],
  productVariants: [], purchaseBatches: [], purchaseBatchItems: [], privateOrders: [],
  privateOrderItems: [], bundleComponents: [], japanPackages: [], japanPackageItems: [],
  outboundShipments: [{
    id: SHIPMENT_ID, title: '版面測試出庫單', status: 'packing', carrier: 'Test carrier',
    tracking_number: 'LAYOUT-TEST-001', created_at: '2026-09-03T00:00:00.000Z',
  }],
  outboundShipmentItems: [{
    id: 'shipment-layout-item', outbound_shipment_id: SHIPMENT_ID, product_title: GROUP_NAME,
    variant_name: '一般商品', sku: 'LAYOUT-001', quantity: 2, checked: false,
    created_at: '2026-09-03T00:00:00.000Z',
  }],
};

const storageKeys = {
  inventory: 'erp_inventory', salesOrders: 'erp_sales_orders', salesOrderItems: 'erp_sales_order_items',
  productGroups: 'erp_product_groups', productCategories: 'erp_product_categories',
  productVariants: 'erp_product_variants', purchaseBatches: 'erp_purchase_batches',
  purchaseBatchItems: 'erp_purchase_batch_items', privateOrders: 'erp_private_orders',
  privateOrderItems: 'erp_private_order_items', bundleComponents: 'erp_bundle_components',
  japanPackages: 'erp_japan_packages', japanPackageItems: 'erp_japan_package_items',
  outboundShipments: 'erp_outbound_shipments', outboundShipmentItems: 'erp_outbound_shipment_items',
};

async function installFixture(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ data, keys }) => {
    localStorage.clear();
    localStorage.setItem('erp_provider_mode', 'local');
    localStorage.setItem('erp_view_mode', 'auto');
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
}

async function verifyViewport(browser, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-TW' });
  const page = await context.newPage();
  const unexpectedErrors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Test Sandbox blocked')) unexpectedErrors.push(message.text());
  });
  page.on('pageerror', error => unexpectedErrors.push(error.message));
  try {
    await installFixture(page);
    await page.goto(`${BASE_URL}/outbound-shipments/${SHIPMENT_ID}`, { waitUntil: 'networkidle' });
    const header = page.getByTestId('outbound-group-header');
    const title = page.getByTestId('outbound-group-title');
    await header.waitFor();
    assert.equal(await title.getAttribute('title'), GROUP_NAME, `${width}px must keep the full-name tooltip`);
    const geometry = await page.evaluate(() => {
      const rect = testId => document.querySelector(`[data-testid="${testId}"]`).getBoundingClientRect();
      const headerNode = document.querySelector('[data-testid="outbound-group-header"]');
      const titleRect = rect('outbound-group-title');
      const metaRect = rect('outbound-group-meta');
      const copyRect = rect('outbound-copy-button');
      const myacgRect = rect('outbound-myacg-button');
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        headerOverflow: headerNode.scrollWidth > headerNode.clientWidth + 1,
        titleAboveMeta: titleRect.bottom <= metaRect.top + 1,
        copy: { width: copyRect.width, height: copyRect.height },
        myacg: { width: myacgRect.width, height: myacgRect.height },
      };
    });
    assert.equal(geometry.headerOverflow, false, `${width}px group header must not overflow horizontally`);
    assert.equal(geometry.titleAboveMeta, true, `${width}px title and meta/actions must remain on separate rows`);
    if (width === 390) {
      assert.equal(geometry.documentOverflow, false, '390px page must not create horizontal scrolling');
      assert.ok(geometry.copy.height >= 44, `390px copy target must be at least 44px high, got ${geometry.copy.height}`);
      assert.ok(geometry.myacg.width >= 44 && geometry.myacg.height >= 44, '390px MyACG target must be at least 44x44px');
    } else {
      assert.ok(geometry.copy.height < 44, `${width}px desktop copy button must retain compact sizing`);
      assert.ok(geometry.myacg.width < 44 && geometry.myacg.height < 44, `${width}px desktop MyACG button must retain compact sizing`);
    }
    assert.deepEqual(unexpectedErrors, [], `${width}px must not produce browser errors`);
  } finally {
    await context.close();
  }
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
try {
  await verifyViewport(browser, 390, 844);
  await verifyViewport(browser, 1280, 900);
  await verifyViewport(browser, 1366, 900);
} finally {
  await browser.close();
  vite.kill();
}

console.log('PASS outbound group title has first-row width priority and a full-name tooltip');
console.log('PASS counts/actions use the second row with unchanged desktop sizing');
console.log('PASS 390px mobile copy/MyACG targets are at least 44px with no horizontal overflow');
console.log('PASS 1280px and 1366px retain compact desktop sizing without group-header overflow');
console.log('PASS layout-only regression performs 0 ERP data writes');
