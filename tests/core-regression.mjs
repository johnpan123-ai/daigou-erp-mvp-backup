import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const FIXTURE_URL = new URL('./fixtures/core-regression.json', import.meta.url);
const EXPECTED_URL = new URL('./fixtures/core-regression.expected.json', import.meta.url);
const BASE_URL = 'http://127.0.0.1:4187';
const FIXED_NOW = new Date('2026-08-12T12:00:00+08:00');
const META_GROUP_ID = '00000000-0000-4000-a000-000000000000';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) {
  throw new Error(`找不到 Chrome：${CHROME_PATH}。可用 CORE_TEST_CHROME 指定執行檔。`);
}

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
const expected = JSON.parse(await readFile(EXPECTED_URL, 'utf8'));
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
  japanPackages: 'erp_japan_packages',
  japanPackageItems: 'erp_japan_package_items',
  outboundShipments: 'erp_outbound_shipments',
  outboundShipmentItems: 'erp_outbound_shipment_items',
  bundleComponents: 'erp_bundle_components',
  importBatches: 'erp_import_batches',
};

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4187', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite 提前結束：\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite 啟動逾時：\n${viteOutput}`);
}

async function putFixture(page) {
  await page.evaluate(async ({ data, keys }) => {
    localStorage.clear();
    localStorage.setItem('erp_provider_mode', 'test');
    localStorage.setItem('erp_active_tab', 'all');
    localStorage.setItem('erp_active_secondary_tab', 'all');
    localStorage.setItem('erp_search_term', '');
    localStorage.setItem('erp_filter_source', 'all');
    localStorage.setItem('erp_filter_type', 'all');
    localStorage.setItem('erp_sort_mode', 'closing_urgent');
    localStorage.setItem('erp_needs_purchase_only', 'false');

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
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      };
    });
  }, { data: fixture, keys: storageKeys });
}

async function readFixture(page) {
  return page.evaluate(async keys => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db-test-v1', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const result = {};
    for (const [field, key] of Object.entries(keys)) {
      result[field] = await new Promise((resolve, reject) => {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? []);
      });
    }
    db.close();
    return result;
  }, storageKeys);
}

const parseCount = text => {
  const matches = String(text).replaceAll(',', '').match(/-?\d+/g);
  return matches?.length ? Number(matches.at(-1)) : null;
};

async function captureDashboard(page) {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.locator('.kpi-card').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.category-count')]
    .some(node => Number.parseInt(node.textContent ?? '0', 10) > 0));

  const kpi = await page.locator('.kpi-card .kpi-value').allTextContents();
  const categories = await page.locator('.category-count').allTextContents();
  return {
    kpi: {
      active: parseCount(kpi[0]),
      unordered: parseCount(kpi[1]),
      urgent7: parseCount(kpi[2]),
      closed: parseCount(kpi[3]),
    },
    categories: {
      all: parseCount(categories[0]),
      hololive: parseCount(categories[1]),
      vspo: parseCount(categories[2]),
      proxy: parseCount(categories[3]),
      other: parseCount(categories[4]),
    },
  };
}

async function capturePurchaseRecords(page) {
  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('C108'));

  const buttonTexts = await page.locator('button').allTextContents();
  const findCount = (...tokens) => {
    const text = buttonTexts.find(value => tokens.every(token => value.includes(token)));
    if (!text) throw new Error(`找不到按鈕：${tokens.join(' + ')}`);
    return parseCount(text);
  };

  const raw = await readFixture(page);
  const totals = await page.evaluate(async ({ data, metaId }) => {
    const { calculateVariantDemandAndPurchased } = await import('/src/lib/db.ts');
    const regularGroups = data.productGroups.filter(group => group.id !== metaId);
    const batchesById = new Map(data.purchaseBatches.map(batch => [batch.id, batch]));
    const variantsByGroup = new Map();
    for (const variant of data.productVariants) {
      if (!variantsByGroup.has(variant.product_group_id)) variantsByGroup.set(variant.product_group_id, []);
      variantsByGroup.get(variant.product_group_id).push(variant);
    }
    const batchItemsByGroup = new Map();
    for (const item of data.purchaseBatchItems) {
      const groupId = batchesById.get(item.purchase_batch_id)?.product_group_id;
      if (!groupId) continue;
      if (!batchItemsByGroup.has(groupId)) batchItemsByGroup.set(groupId, []);
      batchItemsByGroup.get(groupId).push(item);
    }
    const privateItemsByGroup = new Map();
    for (const item of data.privateOrderItems) {
      const variant = data.productVariants.find(candidate => candidate.id === item.product_variant_id);
      if (!variant?.product_group_id) continue;
      if (!privateItemsByGroup.has(variant.product_group_id)) privateItemsByGroup.set(variant.product_group_id, []);
      privateItemsByGroup.get(variant.product_group_id).push(item);
    }

    const totals = { myacg: 0, waca: 0, privateOrder: 0, purchased: 0, gap: 0 };
    for (const group of regularGroups) {
      for (const variant of variantsByGroup.get(group.id) ?? []) {
        const result = calculateVariantDemandAndPurchased(
          variant,
          privateItemsByGroup.get(group.id) ?? [],
          batchItemsByGroup.get(group.id) ?? [],
          data.inventory,
          data.salesOrderItems,
        );
        totals.myacg += result.myacg;
        totals.waca += result.waca;
        totals.privateOrder += result.privateOrder;
        totals.purchased += result.purchased;
        totals.gap += result.gap;
      }
    }
    return totals;
  }, { data: raw, metaId: META_GROUP_ID });

  return {
    categories: {
      all: findCount('全部商品'),
      c108: findCount('C108'),
      hololive: findCount('Hololive'),
      vspo: findCount('VSPO'),
      proxy: findCount('代理'),
      other: findCount('其他'),
    },
    tabs: {
      progress: findCount('進行中'),
      closed: findCount('已結單'),
      noClosingDate: findCount('未設定結單日'),
      missingJpy: findCount('未設定日幣金額'),
      toPurchase: findCount('待採購'),
      all: findCount('全部', `(${raw.productGroups.length - 1})`),
    },
    totals,
  };
}

async function captureSnapshot(page) {
  return {
    dashboard: await captureDashboard(page),
    purchaseRecords: await capturePurchaseRecords(page),
  };
}

async function verifyProxyMigration(page) {
  await putFixture(page);
  await page.evaluate(() => {
    localStorage.setItem('erp_proxy_agent_map', JSON.stringify({ 'g-proxy': '萬榮' }));
  });
  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'networkidle' });
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db-test-v1', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const groups = await new Promise((resolve, reject) => {
      const request = db.transaction('kv', 'readonly').objectStore('kv').get('erp_product_groups');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? []);
    });
    db.close();
    return groups.find(group => group.id === 'g-proxy')?.proxy_agent === '萬榮';
  });
  const after = await readFixture(page);
  const migrated = after.productGroups.find(group => group.id === 'g-proxy');
  assert.equal(migrated.id, 'g-proxy', 'migration 不得重建 group');
  assert.equal(migrated.proxy_agent, '萬榮', '舊 localStorage map 應可重現覆蓋現值');
  assert.equal(await page.evaluate(() => localStorage.getItem('erp_proxy_agent_map')), null,
    '成功寫回後 migration key 應被移除');
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  await page.clock.install({ time: FIXED_NOW });

  const cloudRequests = [];
  await page.route(/https?:\/\/[^/]*supabase\.co\/.*/i, route => {
    cloudRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });

  await page.goto(BASE_URL);
  await putFixture(page);
  const before = await readFixture(page);
  const first = await captureSnapshot(page);
  const second = await captureSnapshot(page);
  const after = await readFixture(page);

  assert.deepEqual(first, second, '同一固定資料連續執行結果不同');
  assert.deepEqual(before, after, '回歸測試前後 Local 資料被改變');
  assert.deepEqual(first, expected, '核心數據與固定基準不同');
  assert.equal(cloudRequests.length, 0, `測試期間不應連線 Supabase：${cloudRequests.join(', ')}`);

  await verifyProxyMigration(page);
  assert.equal(cloudRequests.length, 0, 'migration 重現測試不得連線 Supabase');
  await putFixture(page);
  assert.deepEqual(await readFixture(page), before, 'migration 診斷後未還原固定 Local 測試資料');

  console.log('PASS 核心數據固定基準完全一致');
  console.log(JSON.stringify(first, null, 2));
  console.log('PASS erp_proxy_agent_map 可在隔離 Local 資料重現舊值覆蓋，診斷後已還原');
  await context.close();
} finally {
  if (browser) await browser.close();
  vite.kill();
}
