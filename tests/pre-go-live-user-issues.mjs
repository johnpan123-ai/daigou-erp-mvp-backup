import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.PRE_GO_LIVE_ISSUES_PORT || 4327);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    VITE_DEPLOYMENT_ENV: 'test',
    VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'offline-fixture-public-key',
  },
});
let output = '';
vite.stdout.on('data', chunk => { output += chunk; });
vite.stderr.on('data', chunk => { output += chunk; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
  try {
    if ((await fetch(BASE_URL)).ok) break;
  } catch {}
  if (attempt === 59) throw new Error(`Vite did not start:\n${output}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  const domain = await page.evaluate(async () => {
    const ledger = await import('/src/lib/purchaseBatchLedger.ts');
    const pool = await import('/src/lib/outboundPoolAvailability.ts');
    const list = await import('/src/lib/outboundShipmentListState.ts');
    const clipboard = await import('/src/lib/safeClipboard.ts');

    const groups = new Map([['g', { id: 'g', title: '商品' }]]);
    const categories = new Map();
    const variants = [{ id: 'v', product_group_id: 'g', product_title: '商品', variant_name: '規格' }];
    const items = [
      { id: 'i1', purchase_batch_id: 'b', product_variant_id: 'v', quantity: 2, cost: 100 },
      { id: 'i2', purchase_batch_id: 'b', product_variant_id: 'v', quantity: 1, cost: 120 },
      { id: 'i3', purchase_batch_id: 'b', product_variant_id: 'v', quantity: 3, cost: undefined },
    ];
    const ledgerText = ledger.formatPurchaseBatchLedger({
      batchId: 'b', batchItems: items, variants, categoryById: categories,
      groupById: groups, getDisplayProductName: () => '規格',
    });
    const fourColumnVariants = [
      { id: 'p900', product_group_id: 'g', product_title: '商品', variant_name: '中文／日本語＆符號' },
      { id: 'p1100', product_group_id: 'g', product_title: '商品', variant_name: '価格-1100' },
      { id: 'p1300', product_group_id: 'g', product_title: '商品', variant_name: '価格-1300' },
      { id: 'p2200', product_group_id: 'g', product_title: '商品', variant_name: '価格-2200' },
    ];
    const fourColumnLedgerText = ledger.formatPurchaseBatchLedger({
      batchId: 'four-column',
      batchItems: [
        { id: 'p900-a', purchase_batch_id: 'four-column', product_variant_id: 'p900', quantity: 1, cost: 900 },
        { id: 'p900-b', purchase_batch_id: 'four-column', product_variant_id: 'p900', quantity: 2, cost: 900 },
        { id: 'p1100', purchase_batch_id: 'four-column', product_variant_id: 'p1100', quantity: 1, cost: 1100 },
        { id: 'p1300', purchase_batch_id: 'four-column', product_variant_id: 'p1300', quantity: 1, cost: 1300 },
        { id: 'p2200', purchase_batch_id: 'four-column', product_variant_id: 'p2200', quantity: 1, cost: 2200 },
      ],
      variants: fourColumnVariants,
      categoryById: categories,
      groupById: groups,
      getDisplayProductName: variant => variant.variant_name,
    });

    const packages = [{ id: 'p', title: 'P', status: 'arrived', arrived_at: '2026-09-19' }];
    const packageItems = [
      { id: 'a', japan_package_id: 'p', quantity: 3, checked: true },
      { id: 'b', japan_package_id: 'p', quantity: 2, checked: false },
    ];
    const partial = pool.getAvailableJapanPackageItems(packages, packageItems, [
      { id: 's1', outbound_shipment_id: 'other', japan_package_item_id: 'a', quantity: 1 },
      { id: 's2', outbound_shipment_id: 'other', japan_package_item_id: 'a', quantity: 1 },
    ], 'current');
    const unchecked = pool.getAvailableJapanPackageItems(packages, [{ ...packageItems[0], checked: false }], [], 'current');
    const currentIgnored = pool.getAvailableJapanPackageItems(packages, [packageItems[0]], [
      { id: 's3', outbound_shipment_id: 'current', japan_package_item_id: 'a', quantity: 3 },
    ], 'current');

    const shipments = [
      { id: 'missing', created_at: '2026-09-19T12:00:00Z' },
      { id: 'old', created_at: '2026-09-17T12:00:00Z', status_changed_at: '2026-09-18T12:00:00Z' },
      { id: 'new', created_at: '2026-09-16T12:00:00Z', status_changed_at: '2026-09-19T12:00:00Z' },
    ];

    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    const originalExec = document.execCommand;
    let fallbackText = '';
    document.execCommand = command => {
      if (command === 'copy') fallbackText = document.querySelector('textarea')?.value || '';
      return command === 'copy';
    };
    await clipboard.writeTextToClipboard('safe fallback');
    document.execCommand = () => false;
    let clipboardFailure;
    try {
      await clipboard.writeTextToClipboard('must fail safely');
    } catch (error) {
      clipboardFailure = { code: error.code, message: error.message };
    }
    document.execCommand = originalExec;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });

    return {
      ledgerText,
      fourColumnLedgerText,
      partial: partial.map(entry => ({ id: entry.item.id, available: entry.availableQuantity })),
      unchecked: unchecked.length,
      currentIgnored: currentIgnored[0]?.availableQuantity,
      statusRecent: list.sortOutboundShipments(shipments, 'status-recent').map(row => row.id),
      dateDesc: list.sortOutboundShipments(shipments, 'date-desc').map(row => row.id),
      dateAsc: list.sortOutboundShipments(shipments, 'date-asc').map(row => row.id),
      statuses: ['all', 'draft', 'packing', 'shipped', 'received'].map(value => list.parseOutboundStatusFilter(value)),
      fallbackText,
      clipboardFailure,
    };
  });

  assert.deepEqual(domain.ledgerText.split('\n'), [
    '商品-規格\t2\t\t100',
    '商品-規格\t1\t\t120',
    '商品-規格\t3\t\t—',
  ]);
  const fourColumnRows = domain.fourColumnLedgerText.split('\n').map(row => row.split('\t'));
  assert.deepEqual(fourColumnRows, [
    ['商品-中文／日本語＆符號', '3', '', '900'],
    ['商品-価格-1100', '1', '', '1100'],
    ['商品-価格-1300', '1', '', '1300'],
    ['商品-価格-2200', '1', '', '2200'],
  ], 'Every price and Unicode product name must preserve the fixed four-column TSV contract and same-name/same-price grouping');
  assert.deepEqual(domain.partial, [{ id: 'a', available: 1 }]);
  assert.equal(domain.unchecked, 0);
  assert.equal(domain.currentIgnored, 3);
  assert.deepEqual(domain.statusRecent, ['new', 'old', 'missing']);
  assert.deepEqual(domain.dateDesc, ['missing', 'old', 'new']);
  assert.deepEqual(domain.dateAsc, ['new', 'old', 'missing']);
  assert.deepEqual(domain.statuses, ['all', 'draft', 'packing', 'shipped', 'received']);
  assert.equal(domain.fallbackText, 'safe fallback');
  assert.deepEqual(domain.clipboardFailure, {
    code: 'CLIPBOARD_WRITE_FAILED',
    message: '無法寫入剪貼簿，請允許剪貼簿權限後再試。',
  });

  await page.evaluate(async () => {
    localStorage.setItem('erp_provider_mode', 'local');
    const rows = [
      { id: 'draft-id', title: '草稿測試', status: 'draft', created_at: '2026-09-15T00:00:00Z' },
      { id: 'packing-id', title: '打包測試', status: 'packing', created_at: '2026-09-16T00:00:00Z' },
      { id: 'shipped-id', title: '運送中不應成為摘要', status: 'shipped', created_at: '2026-09-17T00:00:00Z' },
      { id: 'received-old', title: '已到貨 Alpha', status: 'received', created_at: '2026-09-18T00:00:00Z', status_changed_at: '2026-09-18T06:00:00Z' },
      { id: 'received-new', title: '已到貨 Beta', status: 'received', created_at: '2026-09-17T00:00:00Z', status_changed_at: '2026-09-19T06:00:00Z' },
    ];
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        store.put(rows, 'erp_outbound_shipments');
        store.put([], 'erp_outbound_shipment_items');
        store.put([], 'erp_japan_packages');
        store.put([], 'erp_japan_package_items');
        store.put([], 'erp_product_groups');
        store.put([], 'erp_product_variants');
        store.put([], 'erp_product_categories');
        store.put([], 'erp_bundle_components');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.goto(`${BASE_URL}/outbound-shipments`, { waitUntil: 'networkidle' });
  await page.getByTestId('outbound-status-received').click();
  await page.getByTestId('outbound-search').fill('已到貨');
  assert.equal(await page.getByTestId('outbound-sort').inputValue(), 'status-recent');
  assert.deepEqual(
    await page.getByTestId('outbound-shipment-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-shipment-id'))),
    ['received-new', 'received-old'],
  );
  assert.match(page.url(), /status=received/u);
  assert.match(page.url(), /q=/u);
  assert.equal(await page.getByText('運送中', { exact: true }).count(), 0, 'Removed in-transit summary must not render');
  await page.getByTestId('outbound-sort').selectOption('date-asc');
  await page.getByTestId('outbound-shipment-row').first().click();
  assert.match(page.url(), /status=received/u);
  assert.match(page.url(), /sort=date-asc/u);
  await page.getByRole('button', { name: /返回出庫清單/u }).click();
  assert.equal(await page.getByTestId('outbound-status-received').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('outbound-search').inputValue(), '已到貨');
  assert.equal(await page.getByTestId('outbound-sort').inputValue(), 'date-asc');

  console.log('PASS ledger unit-price TSV, partial receiving eligibility, availability aggregation, list URL persistence/sorting, summary removal and clipboard fallback');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
