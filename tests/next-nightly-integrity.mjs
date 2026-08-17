import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4245';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT_PATH = process.env.NEXT_NIGHTLY_SNAPSHOT || 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';

const COLLECTIONS = [
  ['inventory', 'erp_inventory'],
  ['salesOrders', 'erp_sales_orders'],
  ['salesOrderItems', 'erp_sales_order_items'],
  ['productGroups', 'erp_product_groups'],
  ['productCategories', 'erp_product_categories'],
  ['productVariants', 'erp_product_variants'],
  ['purchaseBatches', 'erp_purchase_batches'],
  ['purchaseBatchItems', 'erp_purchase_batch_items'],
  ['privateOrders', 'erp_private_orders'],
  ['privateOrderItems', 'erp_private_order_items'],
  ['bundleComponents', 'erp_bundle_components'],
  ['japanPackages', 'erp_japan_packages'],
  ['japanPackageItems', 'erp_japan_package_items'],
  ['outboundShipments', 'erp_outbound_shipments'],
  ['outboundShipmentItems', 'erp_outbound_shipment_items'],
  ['importBatches', 'erp_import_batches'],
];

const VSPO_GROUP_IDS = [
  '18bcdaae-52a2-47a4-9aec-6f7c9b5897cc',
  '4a584e43-8478-47fd-ae1d-618ad37223f4',
  '52e277f7-18c5-4694-99af-d2a6d34ddf56',
  '549ef9a3-e106-41c8-ac51-ae9dd218c0f3',
  'cf9ccf77-5c84-4afc-8f23-d51e7475d5ce',
];

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);
if (!existsSync(SNAPSHOT_PATH)) throw new Error(`Snapshot not found: ${SNAPSHOT_PATH}`);

const sourceText = readFileSync(SNAPSHOT_PATH, 'utf8');
const source = JSON.parse(sourceText);
const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'next', '--host', '127.0.0.1', '--port', '4245', '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

const stableStringify = value => JSON.stringify(value, (_key, nestedValue) => {
  if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) return nestedValue;
  return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) => left.localeCompare(right)));
});
const ids = rows => rows.map(row => row?.id).filter(Boolean).sort();
const rows = (value, key) => {
  if (!Array.isArray(value)) throw new Error(`${key} is not an array`);
  return value;
};
const positive = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};
const totalForGroup = (data, groupId) => {
  const variants = data.productVariants.filter(row => row.product_group_id === groupId);
  const batchItems = new Map();
  for (const item of data.purchaseBatchItems) {
    const id = item.product_variant_id;
    batchItems.set(id, (batchItems.get(id) || 0) + positive(item.quantity));
  }
  return variants.reduce((total, variant) => {
    total.waca += Math.max(0, positive(variant.waca_auto_quantity) + Number(variant.waca_manual_adjustment ?? 0));
    const manual = positive(variant.purchased_manual_adjustment);
    total.purchased += manual || batchItems.get(variant.id) || positive(variant.ordered_quantity ?? variant.ordered_qty);
    return total;
  }, { waca: 0, purchased: 0 });
};
const orphanCount = (data, sourceField, foreignField, targetField = 'id') => {
  const targetIds = new Set(data[targetField].map(row => row.id));
  return data[sourceField].filter(row => row[foreignField] && !targetIds.has(row[foreignField])).length;
};
const relationChecks = [
  ['purchaseBatchItems', 'purchaseBatches', 'purchase_batch_id'],
  ['purchaseBatchItems', 'productVariants', 'product_variant_id'],
  ['purchaseBatches', 'productGroups', 'product_group_id'],
  ['productVariants', 'productGroups', 'product_group_id'],
  ['privateOrders', 'productGroups', 'product_group_id'],
  ['privateOrderItems', 'privateOrders', 'private_order_id'],
  ['privateOrderItems', 'productVariants', 'product_variant_id'],
  ['bundleComponents', 'productVariants', 'bundle_variant_id'],
  ['bundleComponents', 'productVariants', 'component_variant_id'],
  ['japanPackageItems', 'japanPackages', 'japan_package_id'],
  ['japanPackageItems', 'productVariants', 'product_variant_id'],
  ['japanPackageItems', 'purchaseBatches', 'purchase_batch_id'],
  ['japanPackageItems', 'purchaseBatchItems', 'purchase_batch_item_id'],
  ['outboundShipmentItems', 'outboundShipments', 'outbound_shipment_id'],
  ['outboundShipmentItems', 'japanPackageItems', 'japan_package_item_id'],
  ['outboundShipmentItems', 'productGroups', 'product_group_id'],
  ['outboundShipmentItems', 'productVariants', 'product_variant_id'],
];

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'next'));
const page = await context.newPage();
const supabaseRequests = [];
page.on('request', request => { if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url()); });

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const productionBefore = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
  });
  const importResult = await page.evaluate(async text => {
    const importer = await import('/src/lib/testSnapshotImport.ts');
    const file = new File([text], 'workbench-backup-2026-08-15.json', { type: 'application/json' });
    const candidate = await importer.prepareTestSnapshotFile(file);
    return importer.importTestSnapshot(candidate);
  }, sourceText);
  assert.equal(importResult.productionIndexedDbUnchanged, true);
  assert.equal(importResult.productionLocalStorageUnchanged, true);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));

  const raw = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
  });
  const normalized = Object.fromEntries(COLLECTIONS.map(([field, key]) => [field, rows(raw[key] ?? [], key)]));
  const counts = Object.fromEntries(COLLECTIONS.map(([field, key]) => [field, {
    source: rows(source[field] ?? [], field).length,
    nextRaw: normalized[field].length,
  }]));
  const hashes = Object.fromEntries(COLLECTIONS.map(([field]) => {
    const sourceHash = stableStringify(source[field] ?? []);
    const nextHash = stableStringify(normalized[field]);
    return [field, { equal: sourceHash === nextHash }];
  }));
  assert.ok(Object.values(counts).every(value => value.source === value.nextRaw), 'all collection counts must match');
  assert.ok(Object.values(hashes).every(value => value.equal), 'all collection hashes must match');

  const sourceData = Object.fromEntries(COLLECTIONS.map(([field]) => [field, rows(source[field] ?? [], field)]));
  const orphans = Object.fromEntries(relationChecks.map(([from, to, fk]) => {
    const sourceCount = orphanCount(sourceData, from, fk, to);
    const nextCount = orphanCount(normalized, from, fk, to);
    assert.ok(nextCount <= sourceCount, `${from}.${fk} orphan count increased`);
    return [`${from}.${fk}->${to}`, { source: sourceCount, nextRaw: nextCount }];
  }));
  const golden = VSPO_GROUP_IDS.map(id => {
    const sourceGroup = totalForGroup(sourceData, id);
    const nextGroup = totalForGroup(normalized, id);
    assert.deepEqual(nextGroup, sourceGroup, `VSPO golden totals mismatch for ${id}`);
    const sourceVariants = sourceData.productVariants.filter(row => row.product_group_id === id);
    const nextVariants = normalized.productVariants.filter(row => row.product_group_id === id);
    assert.deepEqual(ids(nextVariants), ids(sourceVariants), `VSPO Variant IDs mismatch for ${id}`);
    return { id, waca: nextGroup.waca, purchased: nextGroup.purchased, variantCount: nextVariants.length };
  });
  const productionAfter = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
  });
  assert.equal(stableStringify(productionAfter), stableStringify(productionBefore), 'Production IndexedDB changed');
  assert.deepEqual(supabaseRequests, [], 'Next run must make zero Production Supabase requests');

  console.log(JSON.stringify({
    snapshot: SNAPSHOT_PATH,
    database: 'daigou-erp-db-next-v1',
    transactionMode: 'readonly probe after atomic import',
    counts,
    allCollectionHashesEqual: Object.values(hashes).every(value => value.equal),
    orphans,
    golden,
    productionIndexedDbUnchanged: true,
    productionSupabaseRequests: supabaseRequests.length,
  }, null, 2));
  console.log('PASS Next nightly raw integrity and Golden Business Regression');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
