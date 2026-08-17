import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = process.env.SYNC_REGRESSION_ROOT
  ? process.env.SYNC_REGRESSION_ROOT
  : fileURLToPath(new URL('../', import.meta.url));
const VITE_PATH = process.env.SYNC_REGRESSION_VITE
  ?? fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const BASE_URL = process.env.SYNC_REGRESSION_URL ?? 'http://127.0.0.1:4201';
const PORT = new URL(BASE_URL).port;
const CHROME_PATH = process.env.CORE_TEST_CHROME
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT_PATH = process.env.SYNC_REGRESSION_SNAPSHOT
  ?? 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
// The regression gate defaults to the destructive transient-empty-read case.
// Set SYNC_REGRESSION_INJECT_EMPTY_VARIANTS=0 only for the healthy control run.
const injectEmptyVariantRead = process.env.SYNC_REGRESSION_INJECT_EMPTY_VARIANTS !== '0';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);
if (!existsSync(SNAPSHOT_PATH)) throw new Error(`Snapshot not found: ${SNAPSHOT_PATH}`);
if (!existsSync(VITE_PATH)) throw new Error(`Vite not found: ${VITE_PATH}`);

const sourceText = readFileSync(SNAPSHOT_PATH, 'utf8');
const source = JSON.parse(sourceText);
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

const targetGroupPrefixes = ['18bcdaae', '4a584e43', '52e277f7', '549ef9a3', 'cf9ccf77'];
const targetGroups = source.productGroups.filter(row => targetGroupPrefixes.some(prefix => row.id.startsWith(prefix)));
const targetGroupIds = new Set(targetGroups.map(row => row.id));
const targetVariants = source.productVariants.filter(row => targetGroupIds.has(row.product_group_id));
const targetVariantIds = new Set(targetVariants.map(row => row.id));
const targetSkus = new Set(targetVariants.map(row => row.myacg_item_code).filter(Boolean));
const targetBatches = source.purchaseBatches.filter(row => targetGroupIds.has(row.product_group_id));
const targetBatchIds = new Set(targetBatches.map(row => row.id));
const targetPrivateOrders = source.privateOrders.filter(row => targetGroupIds.has(row.product_group_id));
const targetPrivateOrderIds = new Set(targetPrivateOrders.map(row => row.id));
const localStoragePairs = [
  ['erp_inventory', source.inventory.filter(row => targetSkus.has(row.myacg_item_code))],
  ['erp_sales_orders', source.salesOrders],
  ['erp_sales_order_items', source.salesOrderItems.filter(row => targetVariantIds.has(row.product_variant_id) || targetSkus.has(row.myacg_item_code))],
  ['erp_product_groups', targetGroups],
  ['erp_product_categories', source.productCategories.filter(row => targetGroupIds.has(row.product_group_id))],
  ['erp_product_variants', targetVariants],
  ['erp_purchase_batches', targetBatches],
  ['erp_purchase_batch_items', source.purchaseBatchItems.filter(row => targetBatchIds.has(row.purchase_batch_id))],
  ['erp_private_orders', targetPrivateOrders],
  ['erp_private_order_items', source.privateOrderItems.filter(row => targetPrivateOrderIds.has(row.private_order_id))],
  ['erp_bundle_components', source.bundleComponents.filter(row => targetVariantIds.has(row.bundle_variant_id) || targetVariantIds.has(row.component_variant_id))],
  ['erp_japan_packages', source.japanPackages],
  ['erp_japan_package_items', source.japanPackageItems.filter(row => targetGroupIds.has(row.product_group_id))],
  ['erp_outbound_shipments', source.outboundShipments],
  ['erp_outbound_shipment_items', source.outboundShipmentItems.filter(row => targetGroupIds.has(row.product_group_id))],
];

const vite = spawn(process.execPath, [
  VITE_PATH,
  '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
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

const stable = value => JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)));
});

function relationCounts(data) {
  const variants = new Set((data.productVariants ?? []).map(row => row.id));
  const batches = new Set((data.purchaseBatches ?? []).map(row => row.id));
  const count = (rows, key, ids) => (rows ?? []).filter(row => row[key] && !ids.has(row[key])).length;
  return {
    batchItemVariant: count(data.purchaseBatchItems, 'product_variant_id', variants),
    batchItemBatch: count(data.purchaseBatchItems, 'purchase_batch_id', batches),
    privateVariant: count(data.privateOrderItems, 'product_variant_id', variants),
    bundleParentVariant: count(data.bundleComponents, 'bundle_variant_id', variants),
    bundleChildVariant: count(data.bundleComponents, 'component_variant_id', variants),
    japanPackageVariant: count(data.japanPackageItems, 'product_variant_id', variants),
  };
}

function variantFingerprint(rows) {
  return (rows ?? []).map(row => ({
    id: row.id,
    group: row.product_group_id,
    sku: row.myacg_item_code ?? '',
    wacaAuto: row.waca_auto_quantity ?? null,
    wacaManual: row.waca_manual_adjustment ?? null,
    purchasedManual: row.purchased_manual_adjustment ?? null,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
// A new incognito context gives every run a fresh IndexedDB/localStorage namespace.
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'local'));
const page = await context.newPage();

try {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ indexedDbPairs, localPairs }) => {
    localStorage.clear();
    localStorage.setItem('erp_provider_mode', 'local');
    for (const [key, value] of localPairs) localStorage.setItem(key, JSON.stringify(value));

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
      for (const [key, value] of indexedDbPairs) store.put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { indexedDbPairs: storagePairs, localPairs: localStoragePairs });

  await page.reload({ waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async injectEmptyVariantReadInBrowser => {
    const module = await import('/src/lib/db.ts');
    const adapter = module.db;
    const before = {
      productVariants: await adapter.getProductVariants(),
      purchaseBatches: await adapter.getPurchaseBatches(),
      purchaseBatchItems: await adapter.getPurchaseBatchItems(),
      privateOrderItems: await adapter.getPrivateOrderItems(),
      bundleComponents: typeof adapter.getBundleComponents === 'function' ? await adapter.getBundleComponents() : [],
      japanPackageItems: typeof adapter.getJapanPackageItems === 'function' ? await adapter.getJapanPackageItems() : [],
    };
    const supported = typeof adapter.syncProductGroupsWithInventory === 'function';
    if (supported && injectEmptyVariantReadInBrowser) {
      const originalGetProductVariants = adapter.getProductVariants.bind(adapter);
      let variantReadCount = 0;
      adapter.getProductVariants = async (...args) => {
        variantReadCount += 1;
        if (variantReadCount === 1) return [];
        return originalGetProductVariants(...args);
      };
    }
    if (supported) await adapter.syncProductGroupsWithInventory();
    const after = {
      productVariants: await adapter.getProductVariants(),
      purchaseBatches: await adapter.getPurchaseBatches(),
      purchaseBatchItems: await adapter.getPurchaseBatchItems(),
      privateOrderItems: await adapter.getPrivateOrderItems(),
      bundleComponents: typeof adapter.getBundleComponents === 'function' ? await adapter.getBundleComponents() : [],
      japanPackageItems: typeof adapter.getJapanPackageItems === 'function' ? await adapter.getJapanPackageItems() : [],
    };
    return { supported, before, after };
  }, injectEmptyVariantRead);

  const beforeFingerprint = variantFingerprint(result.before.productVariants);
  const afterFingerprint = variantFingerprint(result.after.productVariants);
  const beforeOrphans = relationCounts(result.before);
  const afterOrphans = relationCounts(result.after);
  const variantParity = stable(afterFingerprint) === stable(beforeFingerprint);
  const orphanParity = stable(afterOrphans) === stable(beforeOrphans);
  console.log(JSON.stringify({
    root: ROOT_PATH,
    snapshot: SNAPSHOT_PATH,
    syncSupported: result.supported,
    variants: result.before.productVariants.length,
    variantsAfter: result.after.productVariants.length,
    injectEmptyVariantRead,
    variantParity,
    orphanParity,
    beforeOrphans,
    afterOrphans,
    verdict: variantParity && orphanParity ? 'PASS' : 'FAIL',
  }, null, 2));
  assert.equal(variantParity, true, 'sync changed Variant identity or WACA/manual metadata');
  assert.equal(orphanParity, true, 'sync increased or changed referential-integrity failures');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
