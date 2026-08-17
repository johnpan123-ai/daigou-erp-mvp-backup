import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOTFIX_ROOT = process.env.P0_G_HOTFIX_ROOT
  ?? 'C:\\Users\\小河馬\\.codex\\visualizations\\2026\\07\\14\\019f60f3-32b7-7393-8616-67156b2fc196\\production-p0-g-hotfix-20260818';
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT = process.env.P0_G_VARIANT_SNAPSHOT
  ?? 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
const PORT = 4250;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const envText = existsSync(fileURLToPath(new URL('../.env', import.meta.url)))
  ? readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8')
  : '';
const viteEnv = Object.fromEntries(envText.split(/\r?\n/)
  .map(line => line.match(/^\s*(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY)\s*=\s*(.*?)\s*$/))
  .filter(Boolean)
  .map(match => [match[1], match[2]]));

if (!existsSync(HOTFIX_ROOT)) throw new Error(`Hotfix worktree not found: ${HOTFIX_ROOT}`);
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
if (!existsSync(SNAPSHOT)) throw new Error(`Snapshot not found: ${SNAPSHOT}`);

const source = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const storagePairs = [
  ['erp_inventory', source.inventory ?? []],
  ['erp_sales_orders', source.salesOrders ?? []],
  ['erp_sales_order_items', source.salesOrderItems ?? []],
  ['erp_product_groups', source.productGroups ?? []],
  ['erp_product_categories', source.productCategories ?? []],
  ['erp_product_variants', source.productVariants ?? []],
  ['erp_purchase_batches', source.purchaseBatches ?? []],
  ['erp_purchase_batch_items', source.purchaseBatchItems ?? []],
  ['erp_private_orders', source.privateOrders ?? []],
  ['erp_private_order_items', source.privateOrderItems ?? []],
  ['erp_import_batches', source.importBatches ?? []],
  ['erp_bundle_components', source.bundleComponents ?? []],
  ['erp_japan_packages', source.japanPackages ?? []],
  ['erp_japan_package_items', source.japanPackageItems ?? []],
  ['erp_outbound_shipments', source.outboundShipments ?? []],
  ['erp_outbound_shipment_items', source.outboundShipmentItems ?? []],
];

const VSPO_GROUP_IDS = [
  '18bcdaae-52a2-47a4-9aec-6f7c9b5897cc',
  '4a584e43-8478-47fd-ae1d-618ad37223f4',
  '52e277f7-18c5-4694-99af-d2a6d34ddf56',
  '549ef9a3-e106-41c8-ac51-ae9dd218c0f3',
  'cf9ccf77-5c84-4afc-8f23-d51e7475d5ce',
];

const stable = value => JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
});
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const variantIdentity = rows => rows.map(row => ({
  id: row.id,
  product_group_id: row.product_group_id ?? null,
  myacg_item_code: row.myacg_item_code ?? '',
  waca_manual_adjustment: row.waca_manual_adjustment ?? null,
  purchased_manual_adjustment: row.purchased_manual_adjustment ?? null,
  myacg_manual_adjustment: row.myacg_manual_adjustment ?? null,
  private_manual_adjustment: row.private_manual_adjustment ?? null,
})).sort((a, b) => a.id.localeCompare(b.id));
const groupTotals = (data, groupId) => {
  const variants = data.erp_product_variants.filter(row => row.product_group_id === groupId);
  const batchItems = new Map();
  for (const item of data.erp_purchase_batch_items) {
    batchItems.set(item.product_variant_id, (batchItems.get(item.product_variant_id) ?? 0) + positive(item.quantity));
  }
  return variants.reduce((total, variant) => {
    total.waca += Math.max(0, positive(variant.waca_auto_quantity) + Number(variant.waca_manual_adjustment ?? 0));
    const manual = positive(variant.purchased_manual_adjustment);
    total.purchased += manual || batchItems.get(variant.id) || positive(variant.ordered_quantity ?? variant.ordered_qty);
    return total;
  }, { waca: 0, purchased: 0 });
};
const orphanCounts = data => {
  const ids = key => new Set(data[key].map(row => row.id));
  const count = (from, field, target) => data[from].filter(row => row[field] && !ids(target).has(row[field])).length;
  return {
    batchItemBatch: count('erp_purchase_batch_items', 'purchase_batch_id', 'erp_purchase_batches'),
    batchItemVariant: count('erp_purchase_batch_items', 'product_variant_id', 'erp_product_variants'),
    privateVariant: count('erp_private_order_items', 'product_variant_id', 'erp_product_variants'),
    bundleParentVariant: count('erp_bundle_components', 'bundle_variant_id', 'erp_product_variants'),
    bundleChildVariant: count('erp_bundle_components', 'component_variant_id', 'erp_product_variants'),
    japanVariant: count('erp_japan_package_items', 'product_variant_id', 'erp_product_variants'),
    outboundGroup: count('erp_outbound_shipment_items', 'product_group_id', 'erp_product_groups'),
    outboundPackageItem: count('erp_outbound_shipment_items', 'japan_package_item_id', 'erp_japan_package_items'),
  };
};

const vite = spawn(process.execPath, [VITE, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: HOTFIX_ROOT,
  env: { ...process.env, ...viteEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Hotfix Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(`Hotfix Vite did not start:\n${output}`);
}

async function seed(page) {
  await page.evaluate(async entries => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      store.clear();
      for (const [key, value] of entries) store.put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('seed transaction aborted'));
    });
    database.close();
  }, storagePairs);
}

async function rawSnapshot(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await new Promise((resolve, reject) => {
      const result = {};
      const transaction = database.transaction('kv', 'readonly');
      const cursorRequest = transaction.objectStore('kv').openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        result[cursor.key] = cursor.value;
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('raw read aborted'));
    });
    database.close();
    return values;
  });
}

async function preparePage(browser) {
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'local'));
  const page = await context.newPage();
  const supabaseRequests = [];
  page.on('request', request => { if (/\.supabase\.co\//i.test(request.url())) supabaseRequests.push(request.url()); });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${BASE_URL}/inventory`, { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => Boolean(window.dataProvider || window.db));
  } catch (error) {
    console.log(JSON.stringify({
      startupDiagnostic: {
        url: page.url(),
        title: await page.title(),
        body: (await page.locator('body').innerText()).slice(0, 1000),
        pageErrors,
      },
    }, null, 2));
    throw error;
  }
  await seed(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider || window.db));
  return { context, page, supabaseRequests };
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const normal = await preparePage(browser);
  const before = await rawSnapshot(normal.page);
  const beforeIdentity = variantIdentity(before.erp_product_variants);
  const beforeOrphans = orphanCounts(before);
  const beforeGolden = VSPO_GROUP_IDS.map(id => groupTotals(before, id));
  await normal.page.evaluate(async inventory => {
    const provider = window.dataProvider ?? window.db;
    await provider.upsertInventory(inventory);
    return provider.syncProductGroupsWithInventory();
  }, source.inventory ?? []);
  await normal.page.reload({ waitUntil: 'networkidle' });
  await normal.page.waitForFunction(() => Boolean(window.dataProvider || window.db));
  const normalAfter = await rawSnapshot(normal.page);
  assert.deepEqual(variantIdentity(normalAfter.erp_product_variants), beforeIdentity, 'normal sync changed Variant identity/manual fields');
  assert.deepEqual(VSPO_GROUP_IDS.map(id => groupTotals(normalAfter, id)), beforeGolden, 'normal sync changed Golden totals');
  assert.deepEqual(orphanCounts(normalAfter), beforeOrphans, 'normal sync changed orphan counts');
  assert.deepEqual(normal.supabaseRequests, [], 'production-like normal flow must not call Supabase');
  await normal.context.close();

  const failure = await preparePage(browser);
  const failureBefore = await rawSnapshot(failure.page);
  const failureBeforeSerialized = stable(failureBefore);
  const failureResult = await failure.page.evaluate(async () => {
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function failVariantRead(key) {
      if (this.name === 'kv' && key === 'erp_product_variants') throw new Error('P0-G injected Variant read failure');
      return originalGet.call(this, key);
    };
    try {
      const provider = window.dataProvider ?? window.db;
      await provider.syncProductGroupsWithInventory();
      return { rejected: false };
    } catch (error) {
      return {
        rejected: true,
        code: error?.code ?? null,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }
  });
  const failureAfter = await rawSnapshot(failure.page);
  assert.equal(failureResult.rejected, true, 'Variant read failure must reject sync');
  assert.equal(failureResult.code, 'VARIANT_DESTRUCTIVE_SYNC_GUARD');
  assert.equal(failureResult.message, '商品規格資料讀取失敗，為保護既有採購關聯，本次同步已取消。');
  assert.equal(stable(failureAfter), failureBeforeSerialized, 'fault-injected sync must perform zero IndexedDB writes');
  assert.deepEqual(failure.supabaseRequests, [], 'production-like fault flow must not call Supabase');
  console.log(JSON.stringify({
    hotfixRoot: HOTFIX_ROOT,
    hotfixExpectedCommit: 'b50a0a4',
    database: 'daigou-erp-db',
    normal: {
      variants: normalAfter.erp_product_variants.length,
      golden: VSPO_GROUP_IDS.map((id, index) => ({ id, ...groupTotals(normalAfter, id), baseline: beforeGolden[index] })),
      orphans: beforeOrphans,
      idsUnchanged: true,
    },
    faultInjection: failureResult,
    faultDataUnchanged: true,
    productionSupabaseRequests: 0,
  }, null, 2));
  console.log('PASS P0-G Production-like hotfix normal sync and Variant read-failure guard');
  await failure.context.close();
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
