import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT = process.env.P0_G_VARIANT_SNAPSHOT
  ?? 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
const SERVERS = [
  { mode: 'next', port: 4230, db: 'daigou-erp-db-next-v1' },
  { mode: 'experimental', port: 4231, db: 'daigou-erp-db-experimental-v1' },
];

if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
if (!existsSync(SNAPSHOT)) throw new Error(`Snapshot not found: ${SNAPSHOT}`);

const source = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const storagePairs = [
  ['erp_inventory', source.inventory],
  ['erp_sales_orders', source.salesOrders],
  ['erp_sales_order_items', source.salesOrderItems],
  ['erp_product_groups', source.productGroups],
  ['erp_product_categories', source.productCategories],
  ['erp_product_variants', source.productVariants],
  ['erp_purchase_batches', source.purchaseBatches],
  ['erp_purchase_batch_items', source.purchaseBatchItems],
  ['erp_private_orders', source.privateOrders],
  ['erp_private_order_items', source.privateOrderItems],
  ['erp_bundle_components', source.bundleComponents],
  ['erp_japan_packages', source.japanPackages],
  ['erp_japan_package_items', source.japanPackageItems],
  ['erp_outbound_shipments', source.outboundShipments],
  ['erp_outbound_shipment_items', source.outboundShipmentItems],
];

const stable = value => JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
});

const relationCounts = data => {
  const ids = rows => new Set((rows ?? []).map(row => row.id));
  const variants = ids(data.erp_product_variants);
  const batches = ids(data.erp_purchase_batches);
  const privateOrders = ids(data.erp_private_orders);
  const packages = ids(data.erp_japan_packages);
  const packageItems = ids(data.erp_japan_package_items);
  const groups = ids(data.erp_product_groups);
  const count = (rows, key, parentIds) => (rows ?? [])
    .filter(row => row[key] && !parentIds.has(row[key])).length;
  return {
    batchItemBatch: count(data.erp_purchase_batch_items, 'purchase_batch_id', batches),
    batchItemVariant: count(data.erp_purchase_batch_items, 'product_variant_id', variants),
    privateOrder: count(data.erp_private_order_items, 'private_order_id', privateOrders),
    privateVariant: count(data.erp_private_order_items, 'product_variant_id', variants),
    bundleParentVariant: count(data.erp_bundle_components, 'bundle_variant_id', variants),
    bundleChildVariant: count(data.erp_bundle_components, 'component_variant_id', variants),
    japanPackage: count(data.erp_japan_package_items, 'japan_package_id', packages),
    japanVariant: count(data.erp_japan_package_items, 'product_variant_id', variants),
    outboundGroup: count(data.erp_outbound_shipment_items, 'product_group_id', groups),
    outboundPackageItem: count(data.erp_outbound_shipment_items, 'japan_package_item_id', packageItems),
  };
};

const variantIdentity = rows => (rows ?? []).map(row => ({
  id: row.id,
  product_group_id: row.product_group_id ?? null,
  myacg_item_code: row.myacg_item_code ?? '',
  waca_manual_adjustment: row.waca_manual_adjustment ?? null,
  purchased_manual_adjustment: row.purchased_manual_adjustment ?? null,
  myacg_manual_adjustment: row.myacg_manual_adjustment ?? null,
  private_manual_adjustment: row.private_manual_adjustment ?? null,
})).sort((left, right) => left.id.localeCompare(right.id));

const children = SERVERS.map(server => {
  const child = spawn(process.execPath, [
    VITE,
    '--mode', server.mode,
    '--host', '127.0.0.1',
    '--port', String(server.port),
    '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += String(chunk); });
  child.stderr.on('data', chunk => { child.output += String(chunk); });
  return child;
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stopServers = () => children.forEach(child => child.kill('SIGTERM'));
process.on('exit', stopServers);

async function waitForServer(server, child) {
  const url = `http://127.0.0.1:${server.port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${server.mode} exited early:\n${child.output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  throw new Error(`${server.mode} did not start:\n${child.output}`);
}

async function seed(page, pairs) {
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
  }, pairs);
}

async function rawSnapshot(page, dbName) {
  return page.evaluate(async name => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot(name);
  }, dbName);
}

async function runNormalCase(browser, server) {
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  const supabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//i.test(request.url())) supabaseRequests.push(request.url());
  });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/inventory`, { waitUntil: 'networkidle' });
    await seed(page, storagePairs);
    await page.reload({ waitUntil: 'networkidle' });
    const before = await rawSnapshot(page, server.db);
    assert.equal(before.erp_product_variants.length, 2438);
    const beforeIdentity = variantIdentity(before.erp_product_variants);
    const beforeOrphans = relationCounts(before);

    const syncResult = await page.evaluate(async () => {
      const module = await import('/src/lib/db.ts');
      return module.db.syncProductGroupsWithInventory();
    });
    const after = await rawSnapshot(page, server.db);
    assert.equal(stable(variantIdentity(after.erp_product_variants)), stable(beforeIdentity));
    assert.deepEqual(relationCounts(after), beforeOrphans);
    assert.deepEqual(supabaseRequests, []);
    return { syncResult, variants: after.erp_product_variants.length, orphans: beforeOrphans };
  } finally {
    await context.close();
  }
}

async function runFailureCase(browser, server) {
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  const supabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//i.test(request.url())) supabaseRequests.push(request.url());
  });
  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/inventory?simulateVariantReadFailure=1`,
      { waitUntil: 'networkidle' },
    );
    await seed(page, storagePairs);
    await page.reload({ waitUntil: 'networkidle' });
    const before = await rawSnapshot(page, server.db);
    const beforeSerialized = stable(before);
    const result = await page.evaluate(async () => {
      const module = await import('/src/lib/db.ts');
      try {
        await module.db.syncProductGroupsWithInventory();
        return { rejected: false };
      } catch (error) {
        return {
          rejected: true,
          code: error?.code,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
    const after = await rawSnapshot(page, server.db);
    assert.equal(result.rejected, true);
    assert.equal(result.code, 'VARIANT_DESTRUCTIVE_SYNC_GUARD');
    assert.equal(result.message, '商品規格資料讀取失敗，為保護既有採購關聯，本次同步已取消。');
    assert.equal(stable(after), beforeSerialized, 'read failure must produce zero IndexedDB writes');
    assert.equal(after.erp_product_variants.length, 2438);
    assert.deepEqual(relationCounts(after), {
      batchItemBatch: 3,
      batchItemVariant: 145,
      privateOrder: 0,
      privateVariant: 17,
      bundleParentVariant: 32,
      bundleChildVariant: 34,
      japanPackage: 0,
      japanVariant: 41,
      outboundGroup: 35,
      outboundPackageItem: 1,
    });
    assert.deepEqual(supabaseRequests, []);
    return { rejected: result.rejected, variants: after.erp_product_variants.length, orphans: relationCounts(after) };
  } finally {
    await context.close();
  }
}

async function runVerifiedEmptyCase(browser, server) {
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  const supabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//i.test(request.url())) supabaseRequests.push(request.url());
  });
  const now = new Date().toISOString();
  const emptyFixture = [
    ['erp_inventory', [{
      inventory_key: 'NEW-SKU::SPEC',
      myacg_item_code: 'NEW-SKU',
      product_title: '全新資料庫商品',
      normalized_product_title: '全新資料庫商品',
      raw_variant_name: '測試規格',
      listing_type: '',
      final_price: 100,
      myacg_available_quantity: 1,
      myacg_sold_quantity: 0,
      myacg_listed_at: now,
    }]],
    ['erp_product_groups', [{
      id: 'new-group',
      title: '全新資料庫商品',
      normalized_title: '全新資料庫商品',
      status: 'active',
      created_at: now,
      updated_at: now,
    }]],
    ['erp_product_categories', []],
    ['erp_product_variants', []],
    ['erp_purchase_batches', []],
    ['erp_purchase_batch_items', []],
    ['erp_private_orders', []],
    ['erp_private_order_items', []],
    ['erp_bundle_components', []],
    ['erp_japan_packages', []],
    ['erp_japan_package_items', []],
    ['erp_outbound_shipments', []],
    ['erp_outbound_shipment_items', []],
    ['erp_sales_orders', []],
    ['erp_sales_order_items', []],
  ];
  try {
    await page.goto(`http://127.0.0.1:${server.port}/inventory`, { waitUntil: 'networkidle' });
    await seed(page, emptyFixture);
    await page.reload({ waitUntil: 'networkidle' });
    const result = await page.evaluate(async () => {
      const module = await import('/src/lib/db.ts');
      const syncResult = await module.db.syncProductGroupsWithInventory();
      return { syncResult, variants: await module.db.getProductVariants() };
    });
    assert.equal(result.variants.length, 1);
    assert.equal(result.variants[0].product_group_id, 'new-group');
    assert.equal(result.variants[0].myacg_item_code, 'NEW-SKU');
    assert.equal(result.syncResult.filledVariantsCount, 1);
    assert.deepEqual(supabaseRequests, []);
    return { variants: result.variants.length, createdId: result.variants[0].id };
  } finally {
    await context.close();
  }
}

async function runAnomalousEmptyCase(browser, server) {
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  const now = new Date().toISOString();
  const groups = Array.from({ length: 11 }, (_value, index) => ({
    id: `existing-group-${index}`,
    title: `既有商品 ${index}`,
    normalized_title: `既有商品 ${index}`,
    status: 'active',
    created_at: now,
    updated_at: now,
  }));
  try {
    await page.goto(`http://127.0.0.1:${server.port}/inventory`, { waitUntil: 'networkidle' });
    await seed(page, [
      ['erp_inventory', []],
      ['erp_product_groups', groups],
      ['erp_product_categories', []],
      ['erp_product_variants', []],
      ['erp_purchase_batches', []],
      ['erp_purchase_batch_items', []],
      ['erp_private_orders', []],
      ['erp_private_order_items', []],
      ['erp_bundle_components', []],
      ['erp_japan_packages', []],
      ['erp_japan_package_items', []],
      ['erp_outbound_shipments', []],
      ['erp_outbound_shipment_items', []],
      ['erp_sales_orders', []],
      ['erp_sales_order_items', []],
    ]);
    await page.reload({ waitUntil: 'networkidle' });
    const before = await rawSnapshot(page, server.db);
    const result = await page.evaluate(async () => {
      const module = await import('/src/lib/db.ts');
      try {
        await module.db.syncProductGroupsWithInventory();
        return { rejected: false };
      } catch (error) {
        return { rejected: true, code: error?.code };
      }
    });
    const after = await rawSnapshot(page, server.db);
    assert.equal(result.rejected, true);
    assert.equal(result.code, 'VARIANT_DESTRUCTIVE_SYNC_GUARD');
    assert.equal(stable(after), stable(before));
    return { rejected: true, groups: groups.length, variants: after.erp_product_variants.length };
  } finally {
    await context.close();
  }
}

let browser;
try {
  await Promise.all(SERVERS.map((server, index) => waitForServer(server, children[index])));
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const reports = [];
  for (const server of SERVERS) {
    reports.push({
      mode: server.mode,
      normal: await runNormalCase(browser, server),
      readFailure: await runFailureCase(browser, server),
      anomalousEmpty: await runAnomalousEmptyCase(browser, server),
      verifiedEmpty: await runVerifiedEmptyCase(browser, server),
    });
  }
  console.log(JSON.stringify({ snapshot: SNAPSHOT, reports }, null, 2));
  console.log('PASS normal sync preserves 2438 Variant identities, WACA/manual metadata, and orphan baselines');
  console.log('PASS forced Variant read failure aborts with zero Test DB writes');
  console.log('PASS existing Product Groups plus an anomalous zero-Variant source aborts with zero writes');
  console.log('PASS verified-empty DB retains the legal first-time initialization path');
  console.log('PASS Next/Experimental Production Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  stopServers();
}
