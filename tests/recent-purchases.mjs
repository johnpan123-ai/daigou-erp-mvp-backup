import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4193';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TAIPEI_TIME_ZONE = 'Asia/Taipei';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4193', '--strictPort',
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

function getTaipeiDateKey(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
  const timestamp = Date.parse(`${dateKey}T00:00:00+08:00`) + days * 86_400_000;
  return getTaipeiDateKey(timestamp);
}

function atTaipeiTime(dateKey, time) {
  return new Date(`${dateKey}T${time}:00+08:00`).toISOString();
}

const todayKey = getTaipeiDateKey(Date.now());
const yesterdayKey = shiftDateKey(todayKey, -1);
const eightDaysAgoKey = shiftDateKey(todayKey, -8);

const groupDefaults = {
  purchase_date: todayKey,
  priority: 'Medium',
  listing_type: '日本代購',
  source_type: 'Hololive',
  closing_date: '2099-12-31',
  release_month: '2099-12',
  has_official_site: true,
  created_at: atTaipeiTime(eightDaysAgoKey, '08:00'),
  updated_at: atTaipeiTime(todayKey, '08:00'),
};

const productGroups = [
  { ...groupDefaults, id: 'group-url', title: '商品 A', normalized_title: '商品 A', product_url: 'https://example.com/product-a', proxy_agent: '萬榮' },
  { ...groupDefaults, id: 'group-no-url', title: '商品 B', normalized_title: '商品 B', product_url: '', has_official_site: false },
  { ...groupDefaults, id: 'group-old', title: '商品 C', normalized_title: '商品 C', product_url: 'https://example.com/product-c' },
];

const productCategories = productGroups.map((group, index) => ({
  id: `category-${index + 1}`,
  product_group_id: group.id,
  title: '一般商品',
  sort_order: index,
}));

const productVariants = productGroups.map((group, index) => ({
  id: `variant-${index + 1}`,
  product_group_id: group.id,
  product_category_id: productCategories[index].id,
  myacg_item_code: `TEST-SKU-${index + 1}`,
  product_title: group.title,
  variant_name: '一般商品',
  raw_variant_name: '一般商品',
  source: 'catalog',
  default_jpy_cost: 100,
  myacg_manual_adjustment: 0,
  waca_manual_adjustment: 0,
}));

const purchaseBatches = [
  { id: 'batch-a-late', product_group_id: 'group-url', name: '下午採購', date: todayKey, note: '', created_at: atTaipeiTime(todayKey, '14:20') },
  { id: 'batch-b', product_group_id: 'group-no-url', name: '商品 B 採購', date: todayKey, note: '', created_at: atTaipeiTime(todayKey, '13:45') },
  { id: 'batch-a-early', product_group_id: 'group-url', name: '上午採購', date: todayKey, note: '', created_at: atTaipeiTime(todayKey, '10:05') },
  { id: 'batch-a-yesterday', product_group_id: 'group-url', name: '昨天採購', date: yesterdayKey, note: '', created_at: atTaipeiTime(yesterdayKey, '21:30') },
  { id: 'batch-c-old', product_group_id: 'group-old', name: '較早採購', date: eightDaysAgoKey, note: '', created_at: atTaipeiTime(eightDaysAgoKey, '18:00') },
];

const purchaseBatchItems = [
  { id: 'item-a-late', purchase_batch_id: 'batch-a-late', product_variant_id: 'variant-1', quantity: 2, cost: 100, note: '' },
  { id: 'item-b', purchase_batch_id: 'batch-b', product_variant_id: 'variant-2', quantity: 12, cost: 100, note: '' },
  { id: 'item-a-early', purchase_batch_id: 'batch-a-early', product_variant_id: 'variant-1', quantity: 3, cost: 100, note: '' },
  { id: 'item-a-yesterday', purchase_batch_id: 'batch-a-yesterday', product_variant_id: 'variant-1', quantity: 3, cost: 100, note: '' },
  { id: 'item-c-old', purchase_batch_id: 'batch-c-old', product_variant_id: 'variant-3', quantity: 4, cost: 100, note: '' },
];

const fixture = {
  inventory: productVariants.map(variant => ({
    inventory_key: `${variant.myacg_item_code}::一般商品`,
    myacg_item_code: variant.myacg_item_code,
    product_title: variant.product_title,
    raw_variant_name: '一般商品',
    listing_type: '日本代購',
    myacg_sold_quantity: 0,
  })),
  salesOrders: [],
  salesOrderItems: [],
  productGroups,
  productCategories,
  productVariants,
  purchaseBatches,
  purchaseBatchItems,
  privateOrders: [],
  privateOrderItems: [],
  bundleComponents: [],
  japanPackages: [],
  japanPackageItems: [],
  outboundShipments: [],
  outboundShipmentItems: [],
};

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
  bundleComponents: 'erp_bundle_components',
  japanPackages: 'erp_japan_packages',
  japanPackageItems: 'erp_japan_package_items',
  outboundShipments: 'erp_outbound_shipments',
  outboundShipmentItems: 'erp_outbound_shipment_items',
};

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: TAIPEI_TIME_ZONE });
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

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ data, keys }) => {
    localStorage.clear();
    localStorage.setItem('erp_provider_mode', 'local');

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

  await page.reload({ waitUntil: 'networkidle' });
  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'networkidle' });
  assert.equal(await page.getByTestId('recent-purchases-panel').count(), 0, 'PurchaseRecords must not contain the old recent-purchase cards');
  const sidebarLink = page.getByRole('link', { name: '近期採購' });
  assert.equal(await sidebarLink.getAttribute('href'), '/recent-purchases');

  await sidebarLink.click();
  await page.waitForURL(`${BASE_URL}/recent-purchases`);
  await page.getByTestId('recent-purchases-page').waitFor();

  assert.equal(await page.getByTestId('recent-purchases-filter-7d').getAttribute('aria-pressed'), 'true', 'Recent 7 days must be the default filter');
  const sections = page.getByTestId('recent-purchases-date-section');
  assert.equal(await sections.count(), 2, 'Default range should group today and yesterday into two sections');
  assert.deepEqual(await sections.evaluateAll(elements => elements.map(element => element.getAttribute('data-date'))), [todayKey, yesterdayKey]);

  const dateToggles = page.getByTestId('recent-purchases-date-toggle');
  assert.equal(await dateToggles.count(), 2, 'Every date section must have its own toggle');
  assert.deepEqual(await dateToggles.evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded'))), ['false', 'false'], 'All date sections must start collapsed');

  const rows = page.getByTestId('recent-purchase-row');
  assert.equal(await rows.count(), 0, 'Collapsed date sections must not render purchase rows');

  await dateToggles.first().click();
  assert.equal(await rows.count(), 2, 'Opening today must reveal only today rows');
  assert.equal(await dateToggles.nth(1).getAttribute('aria-expanded'), 'false', 'Opening one date must not open another date');

  const firstRow = rows.first();
  assert.equal(await firstRow.getAttribute('data-quantity'), '5', 'Same-day quantity must sum purchase_batch_items.quantity');
  assert.equal(await firstRow.getAttribute('data-batch-count'), '2', 'Same-day duplicate product must report two batches');
  assert.match(await firstRow.innerText(), /×5/);
  assert.match(await firstRow.innerText(), /2 批/);
  assert.match(await firstRow.innerText(), /14:20/);
  assert.equal(await firstRow.getByTestId('recent-purchase-agent').innerText(), '萬榮', 'Non-empty proxy_agent must appear as a read-only badge');

  const officialLink = firstRow.getByTestId('recent-purchase-official-link');
  assert.equal(await officialLink.getAttribute('href'), 'https://example.com/product-a');
  assert.equal(await officialLink.getAttribute('target'), '_blank');
  assert.equal(await rows.nth(1).getByTestId('recent-purchase-official-link').count(), 0, 'URL-less products must not show an official link');
  assert.equal(await rows.nth(1).getByTestId('recent-purchase-agent').count(), 0, 'Blank proxy_agent must not render a badge');

  await dateToggles.first().click();
  assert.equal(await rows.count(), 0, 'Clicking an open date must collapse it again');
  await dateToggles.first().click();
  await dateToggles.nth(1).click();
  assert.equal(await rows.count(), 3, 'Same product and date must merge into one row');
  assert.deepEqual(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-group-id'))), ['group-url', 'group-no-url', 'group-url']);

  await page.getByTestId('recent-purchases-filter-today').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="recent-purchase-row"]').length === 0);
  assert.equal(await page.getByTestId('recent-purchases-date-toggle').getAttribute('aria-expanded'), 'false', 'Changing the date filter must reset sections to collapsed');
  await page.getByTestId('recent-purchases-date-toggle').click();
  assert.equal(await page.getByTestId('recent-purchase-row').count(), 2, 'Today filter must show only today rows');

  await page.getByTestId('recent-purchases-filter-yesterday').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="recent-purchase-row"]').length === 0);
  await page.getByTestId('recent-purchases-date-toggle').click();
  assert.equal(await page.getByTestId('recent-purchase-row').count(), 1, 'Yesterday filter must show only yesterday rows');

  await page.getByTestId('recent-purchases-filter-30d').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="recent-purchase-row"]').length === 0);
  const monthToggles = page.getByTestId('recent-purchases-date-toggle');
  for (let index = 0; index < await monthToggles.count(); index += 1) {
    await monthToggles.nth(index).click();
  }
  assert.equal(await page.getByTestId('recent-purchase-row').count(), 4, 'Recent 30 days must include the older fixture row');

  await page.getByTestId('recent-purchases-search').fill('商品 C');
  assert.equal(await page.getByTestId('recent-purchase-row').count(), 1, 'Product-name search must narrow the list');
  assert.match(await page.getByTestId('recent-purchase-row').innerText(), /商品 C/);
  await page.getByTestId('recent-purchases-search').fill('');

  await page.getByTestId('recent-purchases-only-official').check();
  assert.equal(await page.getByTestId('recent-purchase-row').count(), 3, 'Official-site filter must hide only URL-less products');

  await page.getByTestId('recent-purchase-row').first().getByTestId('recent-purchase-view').click();
  await page.waitForURL(`${BASE_URL}/purchase-records/group-url`);

  assert.equal(supabaseRequests.length, 0, `Local fixture test made Supabase requests: ${JSON.stringify(supabaseRequests)}`);
  assert.deepEqual(unexpectedErrors, [], `Unexpected browser errors: ${JSON.stringify(unexpectedErrors)}`);

  console.log('PASS PurchaseRecords no longer contains recent-purchase cards');
  console.log('PASS Recent Purchases is an independent sidebar page');
  console.log('PASS same date + product_group_id merges quantity and batch count');
  console.log('PASS date sections and last-purchase ordering are correct');
  console.log('PASS date sections are independent, collapsed by default, and reset on date-filter changes');
  console.log('PASS date/search/official-site filters are correct');
  console.log('PASS proxy_agent is shown read-only and blank agents stay hidden');
  console.log('PASS product detail and official URL actions are correct');
  console.log('PASS Local fixture Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
