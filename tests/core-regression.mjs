import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  buildCoreTestUrls,
  createCoreTestRunId,
  resolveCoreTestPort,
  spawnOwnedCoreTestServer,
  stopOwnedCoreTestServer,
  waitForOwnedCoreTestServer,
} from './helpers/core-test-server.mjs';

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const FIXTURE_URL = new URL('./fixtures/core-regression.json', import.meta.url);
const EXPECTED_URL = new URL('./fixtures/core-regression.expected.json', import.meta.url);
const CORE_TEST_PORT = resolveCoreTestPort();
const { baseUrl: BASE_URL, identityUrl: CORE_TEST_IDENTITY_URL } = buildCoreTestUrls(CORE_TEST_PORT);
const CORE_TEST_RUN_ID = createCoreTestRunId();
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

const vite = spawnOwnedCoreTestServer({
  rootPath: ROOT_PATH,
  vitePath: fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  configPath: fileURLToPath(new URL('./fixtures/core-regression-vite.config.mjs', import.meta.url)),
  port: CORE_TEST_PORT,
  runId: CORE_TEST_RUN_ID,
});

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const stopOwnedViteOnExit = () => {
  if (vite.exitCode === null && vite.signalCode === null) vite.kill();
};
let signalCleanupStarted = false;
const stopOwnedViteOnSignal = signal => {
  if (signalCleanupStarted) return;
  signalCleanupStarted = true;
  void stopOwnedCoreTestServer(vite)
    .catch(error => { console.error(error instanceof Error ? error.message : 'Core Test child cleanup failed.'); })
    .finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
};
const handleSigint = () => stopOwnedViteOnSignal('SIGINT');
const handleSigterm = () => stopOwnedViteOnSignal('SIGTERM');
process.once('exit', stopOwnedViteOnExit);
process.once('SIGINT', handleSigint);
process.once('SIGTERM', handleSigterm);

async function putFixture(page, fixtureData = fixture) {
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
  }, { data: fixtureData, keys: storageKeys });
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
  await page.locator('[data-dashboard-task="unlisted"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-task-count]')]
    .every(node => /^\d+$/.test((node.textContent ?? '').trim())));

  const taskLabels = await page.locator('[data-dashboard-task] .task-copy strong').allTextContents();
  assert.deepEqual(taskLabels, ['待下架', '快結單', '已過期', '尚未下單'], '首頁工作卡順序或名稱退化');
  const bodyText = await page.locator('body').innerText();
  assert.equal(bodyText.includes('商品分類'), false, '每日工作首頁不應再顯示商品分類');
  assert.equal(bodyText.includes('即將發售商品'), false, '每日工作首頁不應再顯示即將發售商品');
  assert.equal(await page.locator('[data-dashboard-queue]').count(), 1, '首頁一次只能展開一個工作清單');
  assert.match(await page.locator('[data-dashboard-queue="unlisted"]').innerText(), /C108 Closed/, '首頁待下架清單漏掉仍在目錄中的過期商品');
  assert.match(await page.locator('[data-dashboard-queue="unlisted"]').innerText(), /Other Closed/, '首頁待下架清單未沿用待下架頁的完整商品集合');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => { window.__dashboardCopiedName = value; } },
    });
  });
  const firstUnlistedRow = page.locator('[data-dashboard-queue="unlisted"] .work-queue-row').first();
  const firstUnlistedName = (await firstUnlistedRow.locator('.work-item-main strong').textContent())?.trim();
  await firstUnlistedRow.locator('[data-copy-unlisted-name]').click();
  assert.equal(await page.evaluate(() => window.__dashboardCopiedName), firstUnlistedName, '待下架複製按鈕未複製畫面使用的同一份商品名稱');
  assert.equal(new URL(page.url()).pathname, '/dashboard', '複製待下架商品名稱不應觸發商品導頁');
  assert.match(await firstUnlistedRow.locator('[data-copy-unlisted-name]').innerText(), /已複製/, '複製後缺少清楚但低調的完成回饋');
  await page.locator('[data-work-queue-tab="upcoming"]').click();
  assert.equal(await page.locator('[data-dashboard-queue]').count(), 1, '快結單切換後不得同時展開多個工作清單');
  assert.equal(await page.locator('[data-dashboard-queue="upcoming"] [data-copy-unlisted-name]').count(), 0, '複製按鈕只應出現在待下架清單');
  assert.match(await page.locator('[data-dashboard-queue="upcoming"]').innerText(), /Today Closing/, '快結單清單漏掉今天結單商品');
  await page.locator('[data-work-queue-tab="overdue"]').click();
  assert.equal(await page.locator('[data-dashboard-queue]').count(), 1, '切換後不得同時展開多個工作清單');
  assert.match(await page.locator('[data-dashboard-queue="overdue"]').innerText(), /C108 Closed/, '已過期清單漏掉未完成商品');
  await page.locator('[data-work-queue-tab="unordered"]').click();
  assert.equal(await page.locator('[data-dashboard-queue]').count(), 1, '尚未下單切換後不得同時展開多個工作清單');
  assert.match(await page.locator('[data-dashboard-queue="unordered"]').innerText(), /Today Closing/, '尚未下單清單漏掉有需求且採購為 0 的商品');
  const unorderedCategoryTabs = await page.locator('[data-unordered-category]').allTextContents();
  assert.deepEqual(
    unorderedCategoryTabs.map(text => text.replace(/\s+/g, ' ').trim()),
    ['全部 1', 'C108專區 0', 'Hololive商品 0', 'VSPO商品 0', '代理版商品 0', '其他商品 1'],
    '尚未下單分類按鈕或分類數量不正確',
  );
  await page.locator('[data-unordered-category="other"]').click();
  assert.match(await page.locator('[data-dashboard-queue="unordered"]').innerText(), /Today Closing/, '其他商品分類漏掉對應尚未下單商品');
  await page.locator('[data-unordered-category="c108"]').click();
  assert.match(await page.locator('[data-dashboard-queue="unordered"]').innerText(), /沒有尚未下單的商品/, '空分類應顯示清楚的空狀態');

  const taskCounts = await page.locator('[data-dashboard-task] [data-task-count]').allTextContents();
  return {
    tasks: {
      unlisted: parseCount(taskCounts[0]),
      upcoming: parseCount(taskCounts[1]),
      overdue: parseCount(taskCounts[2]),
      unordered: parseCount(taskCounts[3]),
    },
  };
}

async function verifyDashboardTaskNavigation(page) {
  const cases = ['unlisted', 'upcoming', 'overdue', 'unordered'];

  for (const task of cases) {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
    await page.locator(`[data-dashboard-task="${task}"]`).click();
    assert.equal(new URL(page.url()).pathname, '/dashboard', `首頁 ${task} 卡片不應錯誤跳到全部商品`);
    assert.equal(
      await page.locator(`[data-work-queue-tab="${task}"]`).getAttribute('aria-selected'),
      'true',
      `首頁 ${task} 卡片未切換到對應工作清單`,
    );
    assert.equal(
      await page.locator('[data-dashboard-queue]').getAttribute('data-dashboard-queue'),
      task,
      `首頁 ${task} 卡片顯示了錯誤工作清單`,
    );
  }

  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.locator('[data-work-queue-tab="upcoming"]').click();
  await page.locator('[data-dashboard-queue="upcoming"] .work-queue-row').first().click();
  await page.waitForURL(url => url.pathname === '/purchase-records/g-today');
}

async function verifyUnlistedQueueRule(page) {
  const snapshot = JSON.stringify({ catalog_import_id: 'import-current', processed_group_ids: ['g-one'] });
  const result = await page.evaluate(async storedSnapshot => {
    localStorage.setItem('erp_unlisted_processed_local', storedSnapshot);
    const { getPendingUnlistedGroupIds } = await import('/src/lib/dashboardDailyWork.ts');
    const groups = [
      { id: 'g-one', closing_date: '2026/08/01' },
      { id: 'g-two', closing_date: '2026-08-02' },
      { id: 'g-future', closing_date: '2026-08-30' },
    ];
    const variants = [
      { id: 'v-one', product_group_id: 'g-one', myacg_item_code: 'sku-one' },
      { id: 'v-two', product_group_id: 'g-two', myacg_item_code: 'sku-two' },
      { id: 'v-future', product_group_id: 'g-future', myacg_item_code: 'sku-future' },
    ];
    const inventoryItems = [
      { myacg_item_code: 'SKU-ONE', latest_catalog_import_id: 'import-current', catalog_last_seen_at: '2026-08-12T01:00:00Z' },
      { myacg_item_code: 'SKU-TWO', latest_catalog_import_id: 'import-current', catalog_last_seen_at: '2026-08-12T01:00:00Z' },
      { myacg_item_code: 'SKU-FUTURE', latest_catalog_import_id: 'import-current', catalog_last_seen_at: '2026-08-12T01:00:00Z' },
    ];
    const currentProcessed = JSON.parse(storedSnapshot);
    const pending = getPendingUnlistedGroupIds({ groups, variants, inventoryItems, today: '2026-08-12', processedSnapshot: currentProcessed });
    const staleMarkPending = getPendingUnlistedGroupIds({
      groups,
      variants,
      inventoryItems,
      today: '2026-08-12',
      processedSnapshot: { catalog_import_id: 'import-old', processed_group_ids: ['g-one'] },
    });
    return {
      pending,
      staleMarkPending,
      storageAfter: localStorage.getItem('erp_unlisted_processed_local'),
    };
  }, snapshot);

  assert.deepEqual(result.pending, ['g-two'], '目前 Catalog 的已處理標記未正確排除待下架商品');
  assert.deepEqual(result.staleMarkPending, ['g-one', 'g-two'], '舊 Catalog 的已處理標記不應隱藏目前待下架商品');
  assert.equal(result.storageAfter, snapshot, '首頁待下架計數不得寫入或改動已處理狀態');
}

async function verifyDashboardDisplayNameNormalization(page) {
  const rawTitle = '【小河馬日本代購】預購 27年01月 代理版 GSC 測試商品';
  const reorderedRawTitle = '【小河馬日本代購】預購 代理版 27年05月 figma 測試商品';
  const displayFixture = structuredClone(fixture);
  displayFixture.productGroups.find(group => group.id === 'g-today').title = rawTitle;
  await putFixture(page, displayFixture);

  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.locator('[data-work-queue-tab="upcoming"]').click();
  const upcomingText = await page.locator('[data-dashboard-queue="upcoming"]').innerText();
  assert.match(upcomingText, /代理版 GSC 測試商品/, '首頁工作清單未保留真正商品名稱');
  assert.equal(upcomingText.includes('小河馬日本代購'), false, '首頁工作清單仍顯示固定賣場前綴');
  assert.equal(upcomingText.includes('預購'), false, '首頁工作清單仍顯示開頭預購標記');
  assert.equal(upcomingText.includes('27年01月'), false, '首頁工作清單仍顯示開頭賣場年月');

  const helperResult = await page.evaluate(async title => {
    const { normalizeDashboardWorkTitle } = await import('/src/lib/dashboardDailyWork.ts');
    return {
      reordered: normalizeDashboardWorkTitle(title),
      middleMonthPreserved: normalizeDashboardWorkTitle('【小河馬日本代購】商品A 27年05月紀念版'),
    };
  }, reorderedRawTitle);
  assert.equal(helperResult.reordered, '代理版 figma 測試商品', '首頁未清除固定前綴區段中的賣場年月');
  assert.equal(helperResult.middleMonthPreserved, '商品A 27年05月紀念版', '商品名稱中間的正常年月不得被錯刪');

  const stored = await readFixture(page);
  assert.equal(
    stored.productGroups.find(group => group.id === 'g-today')?.title,
    rawTitle,
    '首頁顯示清理不得修改原始商品名稱',
  );
  await putFixture(page);
}

async function verifyDashboardCategoryParity(page) {
  const result = await page.evaluate(async ({ data, metaId }) => {
    const { buildProductDisplayCategoryMap } = await import('/src/lib/dashboardDailyWork.ts');
    const regularGroups = data.productGroups.filter(group => group.id !== metaId);
    const categoryMap = buildProductDisplayCategoryMap(regularGroups, data.productVariants, data.inventory);
    const counts = { c108: 0, hololive: 0, vspo: 0, proxy: 0, other: 0 };
    regularGroups.forEach(group => { counts[categoryMap.get(group.id) ?? 'other'] += 1; });
    return counts;
  }, { data: fixture, metaId: META_GROUP_ID });

  assert.deepEqual(result, {
    c108: expected.purchaseRecords.categories.c108,
    hololive: expected.purchaseRecords.categories.hololive,
    vspo: expected.purchaseRecords.categories.vspo,
    proxy: expected.purchaseRecords.categories.proxy,
    other: expected.purchaseRecords.categories.other,
  }, '首頁尚未下單分類必須與訂購紀錄表 Accepted 分類完全一致');
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
  const after = await readFixture(page);
  const group = after.productGroups.find(candidate => candidate.id === 'g-proxy');
  assert.equal(group?.proxy_agent, '鉅霖', 'Product Group proxy_agent must remain the source of truth');
  assert.equal(await page.evaluate(() => localStorage.getItem('erp_proxy_agent_map')),
    JSON.stringify({ 'g-proxy': '萬榮' }),
    'Retired proxy-agent map must be ignored and preserved');
}

let browser;
try {
  const serverIdentity = await waitForOwnedCoreTestServer({
    child: vite,
    identityUrl: CORE_TEST_IDENTITY_URL,
    runId: CORE_TEST_RUN_ID,
    output: () => viteOutput,
  });
  console.log(`PASS Core Test owned server identity runId=${serverIdentity.runId} port=${CORE_TEST_PORT}`);
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

  await verifyDashboardTaskNavigation(page);
  await verifyUnlistedQueueRule(page);
  await verifyDashboardDisplayNameNormalization(page);
  await verifyDashboardCategoryParity(page);
  assert.deepEqual(await readFixture(page), before, '首頁導頁與待下架計數 regression 不得修改正式資料');

  await verifyProxyMigration(page);
  assert.equal(cloudRequests.length, 0, 'migration 重現測試不得連線 Supabase');
  await putFixture(page);
  assert.deepEqual(await readFixture(page), before, 'migration 診斷後未還原固定 Local 測試資料');

  console.log('PASS 核心數據固定基準完全一致');
  console.log(JSON.stringify(first, null, 2));
  console.log('PASS retired erp_proxy_agent_map is ignored and preserved');
  await context.close();
} finally {
  if (browser) await browser.close();
  process.removeListener('exit', stopOwnedViteOnExit);
  process.removeListener('SIGINT', handleSigint);
  process.removeListener('SIGTERM', handleSigterm);
  await stopOwnedCoreTestServer(vite);
}
