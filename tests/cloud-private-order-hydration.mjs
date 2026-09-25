import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4201';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4201', '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
const page = await context.newPage();
const supabaseRequests = [];
const unexpectedErrors = [];

page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});
page.on('console', message => {
  if (message.type() === 'error') unexpectedErrors.push(message.text());
});
page.on('pageerror', error => unexpectedErrors.push(error.message));

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const { cloudCacheDb: db, calculateVariantDemandAndPurchased } = await import('/src/lib/db.ts');
    const { SupabaseProvider } = await import('/src/providers/cloud/supabaseProvider.ts');

    const groupId = '10000000-0000-4000-8000-000000000001';
    const variantId = '30000000-0000-4000-8000-000000000001';
    const privateOrderIds = [
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002',
    ];
    const privateItemIds = [
      '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002',
    ];
    const variant = {
      id: variantId,
      local_id: 'preview-variant-a',
      product_group_id: groupId,
      product_category_id: null,
      myacg_item_code: 'PREVIEW-SKU-A',
      product_title: 'Preview Product A',
      variant_name: '標準版',
      effective_myacg_quantity: 200,
      myacg_manual_adjustment: 0,
      waca_auto_quantity: 100,
      waca_manual_adjustment: 0,
      private_manual_adjustment: 0,
      purchased_manual_adjustment: null,
      note: '',
      sort_order: 0,
      version: 1,
      updated_at: '2026-08-24T00:00:00.000Z',
    };
    const orders = privateOrderIds.map((id, index) => ({
      id,
      product_group_id: groupId,
      customer_name: `Preview Customer ${index + 1}`,
      contact: '',
      note: '',
      created_at: `2026-08-24T00:00:0${index}.000Z`,
      version: 1,
    }));
    const items = privateItemIds.map((id, index) => ({
      id,
      private_order_id: privateOrderIds[index],
      product_variant_id: variantId,
      quantity: 99,
      amount: 0,
      note: '',
      version: 1,
      updated_at: `2026-08-24T00:00:0${index}.000Z`,
    }));

    await db.clearData();
    const provider = new SupabaseProvider();
    let releaseHydration;
    const hydrationGate = new Promise(resolve => { releaseHydration = resolve; });
    let hydrationPromise = null;
    let hydrationStarts = 0;

    // Model a cold Cloud pull: all getters start against an empty cache, then the
    // existing single-flight hydration writes every related collection atomically in order.
    provider.pullCoreProductData = () => {
      if (!hydrationPromise) {
        hydrationStarts += 1;
        hydrationPromise = (async () => {
          await hydrationGate;
          await db.saveProductGroups([{
            id: groupId,
            purchase_date: '2026-08-24',
            priority: 'Medium',
            title: 'Preview Product A',
            closing_date: '',
            release_month: '',
            has_official_site: false,
            product_url: '',
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:00.000Z',
            version: 1,
          }]);
          await db.saveProductVariants([variant]);
          await db.savePrivateOrders(orders);
          await db.savePrivateOrderItems(items);
        })();
      }
      return hydrationPromise;
    };

    const coldReadPromise = Promise.all([
      provider.getProductVariants({ recalc: false }),
      provider.getPrivateOrders(),
      provider.getPrivateOrderItems(),
    ]);
    const emptyBeforeHydration = {
      orders: (await db.getPrivateOrders()).length,
      items: (await db.getPrivateOrderItems()).length,
    };
    releaseHydration();
    const [coldVariants, coldOrders, coldItems] = await coldReadPromise;
    const coldVariant = coldVariants.find(row => row.id === variantId);
    const singleItemDemand = calculateVariantDemandAndPurchased(coldVariant, coldItems.slice(0, 1), [], [], []);
    const coldDemand = calculateVariantDemandAndPurchased(coldVariant, coldItems, [], [], []);

    const [warmVariants, warmOrders, warmItems] = await Promise.all([
      provider.getProductVariants({ recalc: false }),
      provider.getPrivateOrders(),
      provider.getPrivateOrderItems(),
    ]);
    const warmVariant = warmVariants.find(row => row.id === variantId);
    const warmDemand = calculateVariantDemandAndPurchased(warmVariant, warmItems, [], [], []);
    const orderIds = new Set(warmOrders.map(row => row.id));
    const variantIds = new Set(warmVariants.map(row => row.id));

    return {
      emptyBeforeHydration,
      hydrationStarts,
      cold: {
        variantFound: Boolean(coldVariant),
        canonicalId: coldVariant?.id,
        localId: coldVariant?.local_id,
        privateManualAdjustment: coldVariant?.private_manual_adjustment,
        orderCount: coldOrders.length,
        itemCount: coldItems.length,
        singleItemPrivateOrder: singleItemDemand.privateOrder,
        privateOrder: coldDemand.privateOrder,
        totalDemand: coldDemand.myacg + coldDemand.waca + coldDemand.privateOrder,
      },
      warm: {
        variantFound: Boolean(warmVariant),
        orderCount: warmOrders.length,
        itemCount: warmItems.length,
        privateOrder: warmDemand.privateOrder,
        totalDemand: warmDemand.myacg + warmDemand.waca + warmDemand.privateOrder,
      },
      uniqueOrderIds: new Set(warmOrders.map(row => row.id)).size,
      uniqueItemIds: new Set(warmItems.map(row => row.id)).size,
      duplicateVariants: warmVariants.length - new Set(warmVariants.map(row => row.id)).size,
      orphanItems: warmItems.filter(item => !orderIds.has(item.private_order_id) || !variantIds.has(item.product_variant_id)).length,
      unknownProducts: warmVariants.filter(row => row.product_title === 'Unknown Product').length,
    };
  });

  assert.deepEqual(result.emptyBeforeHydration, { orders: 0, items: 0 });
  assert.equal(result.hydrationStarts, 1, 'Concurrent product/private getters must share one Cloud hydration');
  assert.deepEqual(result.cold, {
    variantFound: true,
    canonicalId: '30000000-0000-4000-8000-000000000001',
    localId: 'preview-variant-a',
    privateManualAdjustment: 0,
    orderCount: 2,
    itemCount: 2,
    singleItemPrivateOrder: 99,
    privateOrder: 198,
    totalDemand: 498,
  });
  assert.deepEqual(result.warm, {
    variantFound: true,
    orderCount: 2,
    itemCount: 2,
    privateOrder: 198,
    totalDemand: 498,
  });
  assert.equal(result.uniqueOrderIds, 2);
  assert.equal(result.uniqueItemIds, 2);
  assert.equal(result.duplicateVariants, 0);
  assert.equal(result.orphanItems, 0);
  assert.equal(result.unknownProducts, 0);
  assert.deepEqual(supabaseRequests, [], 'The deterministic hydration regression must not contact Supabase');
  assert.deepEqual(unexpectedErrors, []);

  console.log('PASS cold Cloud cache read waits for product/private-order hydration on first load');
  console.log('PASS private_manual_adjustment = 0 does not override one item = 99');
  console.log('PASS PREVIEW-SKU-A private demand = 198 and total demand = 498 without reload');
  console.log('PASS warm cache remains 198/498 and reuses the same single-flight pull');
  console.log('PASS private order/item duplicates = 0, orphan delta = 0, Unknown Product risk = 0');
  console.log('PASS canonical UUID/local_id identity remains stable; Product variant not found = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
