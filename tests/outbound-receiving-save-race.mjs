import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4192';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT_PATH = process.env.OUTBOUND_RACE_SNAPSHOT
  || 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
const TARGET_SHIPMENT_ID = '2f007c6b-deac-4b2c-a211-c8a3b14d23ce';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);
if (!existsSync(SNAPSHOT_PATH)) throw new Error(`Production Snapshot not found: ${SNAPSHOT_PATH}`);

const backup = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const collectionKeys = {
  inventory: 'erp_inventory', salesOrders: 'erp_sales_orders', salesOrderItems: 'erp_sales_order_items',
  productGroups: 'erp_product_groups', productCategories: 'erp_product_categories', productVariants: 'erp_product_variants',
  purchaseBatches: 'erp_purchase_batches', purchaseBatchItems: 'erp_purchase_batch_items',
  privateOrders: 'erp_private_orders', privateOrderItems: 'erp_private_order_items', bundleComponents: 'erp_bundle_components',
  japanPackages: 'erp_japan_packages', japanPackageItems: 'erp_japan_package_items',
  outboundShipments: 'erp_outbound_shipments', outboundShipmentItems: 'erp_outbound_shipment_items',
};
const originalOutboundItems = backup.outboundShipmentItems.map(item => (
  item.outbound_shipment_id === TARGET_SHIPMENT_ID
    ? { ...item, checked: false, checked_at: null }
    : item
));
backup.outboundShipmentItems = originalOutboundItems;
const targetItemCount = originalOutboundItems.filter(item => item.outbound_shipment_id === TARGET_SHIPMENT_ID).length;
assert.ok(targetItemCount >= 10, 'Snapshot needs at least 10 outbound items in the target shipment');

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4192', '--strictPort',
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
      // Vite is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

const stable = value => JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)));
});
const sorted = values => [...values].sort((a, b) => a.localeCompare(b));

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'test'));
const page = await context.newPage();
const supabaseRequests = [];
const unexpectedConsoleErrors = [];
const dialogs = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push({ method: request.method(), url: request.url() });
});
page.on('dialog', async dialog => {
  dialogs.push({ type: dialog.type(), message: dialog.message() });
  await dialog.dismiss();
});
page.on('console', message => {
  const text = message.text();
  const expectedFailure = text.includes('simulated outbound save failure') || text.includes('出庫項目儲存失敗');
  if (message.type() === 'error' && !expectedFailure) unexpectedConsoleErrors.push(text);
});
page.on('pageerror', error => unexpectedConsoleErrors.push(error.message));

async function seedSnapshot() {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ data, keys }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou-erp-db-test-v1', 1);
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
        transaction.onabort = () => reject(transaction.error ?? new Error('Snapshot seed aborted'));
      };
    });
  }, { data: backup, keys: collectionKeys });
}

async function productionSentinels() {
  return page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      indexedDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      search: environment.readPhysicalLocalStorageValue('erp_search_term'),
      email: environment.readPhysicalLocalStorageValue('remembered_email'),
    };
  });
}

async function readStoredOutboundItems() {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('daigou-erp-db-test-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const getRequest = db.transaction('kv', 'readonly').objectStore('kv').get('erp_outbound_shipment_items');
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => { db.close(); resolve(getRequest.result ?? []); };
    };
  }));
}

async function resetTarget() {
  await page.evaluate(async items => new Promise((resolve, reject) => {
    const request = indexedDB.open('daigou-erp-db-test-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(items, 'erp_outbound_shipment_items');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), originalOutboundItems);
  await page.goto(`${BASE_URL}/outbound-shipments/${TARGET_SHIPMENT_ID}`, { waitUntil: 'networkidle' });
  await page.locator('text=點收進度').waitFor({ state: 'visible' });
}

async function installSaveProbe({ delays = [], failCalls = [] } = {}) {
  await page.evaluate(({ probeDelays, probeFailures }) => {
    const provider = window.dataProvider;
    const original = provider.saveOutboundShipmentItems.bind(provider);
    window.__outboundSaveProbe = { calls: [], completionOrder: [], active: 0, maxActive: 0 };
    provider.saveOutboundShipmentItems = async items => {
      const probe = window.__outboundSaveProbe;
      const sequence = probe.calls.length + 1;
      const call = {
        sequence,
        startedAt: performance.now(),
        checkedIds: items.filter(item => item.checked).map(item => item.id).sort(),
      };
      probe.calls.push(call);
      probe.active += 1;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      const delay = probeDelays[sequence - 1] ?? 0;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        if (probeFailures.includes(sequence)) throw new Error('simulated outbound save failure');
        await original(items);
        call.finishedAt = performance.now();
        probe.completionOrder.push(sequence);
      } finally {
        probe.active -= 1;
      }
    };
  }, { probeDelays: delays, probeFailures: failCalls });
}

async function waitForSaveQueue() {
  await page.waitForFunction(() => !document.body.innerText.includes('儲存中（'), null, { timeout: 20000 });
  await page.waitForTimeout(50);
}

async function assertLatestPayloadPersisted() {
  const trace = await page.evaluate(() => window.__outboundSaveProbe);
  assert.ok(trace.calls.length > 0, 'No outbound save call was recorded');
  assert.equal(trace.maxActive, 1, 'More than one outbound save ran concurrently');
  assert.deepEqual(trace.completionOrder, trace.calls.map(call => call.sequence), 'Outbound saves completed out of invocation order');
  const stored = await readStoredOutboundItems();
  const storedChecked = sorted(stored.filter(item => item.checked).map(item => item.id));
  assert.deepEqual(storedChecked, trace.calls.at(-1).checkedIds, 'Stored checked state differs from the newest UI payload');
  assert.equal(stored.length, originalOutboundItems.length, 'Outbound item count changed during receiving saves');
  return { trace, stored };
}

try {
  await seedSnapshot();
  const productionBefore = await productionSentinels();

  // 1 + 2: one item, then ten rapid receiving operations under inverted delays.
  await resetTarget();
  await installSaveProbe({ delays: [700, 20, 600, 30, 500, 40, 400, 50, 300, 60] });
  const receivingButtons = page.locator('button[aria-label*="全部來源點收"]');
  assert.ok(await receivingButtons.count() >= 10, 'Not enough receiving rows for the rapid-click test');
  for (let index = 0; index < 10; index += 1) await receivingButtons.nth(index).click();
  await waitForSaveQueue();
  const rapid = await assertLatestPayloadPersisted();
  assert.ok(rapid.stored.some(item => item.checked && item.checked_at), 'Checked items did not receive checked_at');
  console.log('PASS rapid 10-item receiving saves are serialized and persist the latest payload');

  // 3: route navigation is blocked while a save is pending, then works after completion.
  await resetTarget();
  await installSaveProbe({ delays: [700] });
  await page.locator('button[aria-label*="全部來源點收"]').first().click();
  await page.getByRole('button', { name: '返回出庫清單' }).click();
  assert.equal(new URL(page.url()).pathname, `/outbound-shipments/${TARGET_SHIPMENT_ID}`);
  assert.ok(dialogs.some(dialog => dialog.message.includes('仍在儲存中')), 'Pending internal navigation was not blocked');
  await waitForSaveQueue();
  await page.getByRole('button', { name: '返回出庫清單' }).click();
  await page.waitForURL(`${BASE_URL}/outbound-shipments`);
  console.log('PASS pending save blocks immediate route navigation');

  // 4: an immediate F5 receives beforeunload protection; after completion reload is stable.
  await resetTarget();
  await installSaveProbe({ delays: [700] });
  await page.locator('button[aria-label*="全部來源點收"]').first().click();
  const unloadProtected = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(unloadProtected, true, 'Pending save did not enable beforeunload protection');
  await waitForSaveQueue();
  const beforeReload = await readStoredOutboundItems();
  await page.reload({ waitUntil: 'networkidle' });
  const afterReload = await readStoredOutboundItems();
  assert.deepEqual(afterReload, beforeReload, 'F5 after queue completion changed checked state');
  console.log('PASS immediate F5 is protected until the save queue finishes');

  // 5 + 6: same-SKU group and individual source controls remain separate but serialize together.
  await resetTarget();
  await installSaveProbe({ delays: [500, 20, 400, 30] });
  const b2GroupButton = page.locator('button[aria-label*="B2橫幅掛軸"]');
  await b2GroupButton.click();
  await page.getByRole('button', { name: /來源明細（2）/ }).first().click();
  const sourceButtons = page.locator('button[aria-label^="切換來源"]');
  assert.equal(await sourceButtons.count(), 2, 'Expected two B2 source controls');
  await sourceButtons.nth(0).click();
  await sourceButtons.nth(1).click();
  await b2GroupButton.click();
  await waitForSaveQueue();
  await assertLatestPayloadPersisted();
  console.log('PASS same-SKU group and source-item receiving operations cannot overwrite each other');

  // 7: checked -> unchecked -> checked retains the final state.
  await resetTarget();
  await installSaveProbe({ delays: [500, 20, 300] });
  const firstButton = page.locator('button[aria-label*="全部來源點收"]').first();
  await firstButton.click();
  await firstButton.click();
  await firstButton.click();
  await waitForSaveQueue();
  const triple = await assertLatestPayloadPersisted();
  const latestChecked = new Set(triple.trace.calls.at(-1).checkedIds);
  for (const item of triple.stored.filter(item => latestChecked.has(item.id))) {
    assert.equal(item.checked, true);
    assert.ok(item.checked_at, `checked_at missing for ${item.id}`);
  }
  console.log('PASS checked -> unchecked -> checked persists the final state and checked_at');

  // Save failure must be visible and must reload the actually stored state.
  await resetTarget();
  await installSaveProbe({ delays: [50], failCalls: [1] });
  await page.locator('button[aria-label*="全部來源點收"]').first().click();
  await page.getByRole('alert').waitFor({ state: 'visible', timeout: 5000 });
  await waitForSaveQueue();
  const failedStored = await readStoredOutboundItems();
  assert.equal(failedStored.filter(item => item.outbound_shipment_id === TARGET_SHIPMENT_ID && item.checked).length, 0);
  assert.match(await page.getByRole('alert').innerText(), /儲存失敗/);
  console.log('PASS save failure is visible and the UI reloads stored state');

  const productionAfter = await productionSentinels();
  assert.equal(stable(productionAfter), stable(productionBefore), 'Production browser data changed during Test receiving stress');
  assert.equal(supabaseRequests.length, 0, `Test Mode contacted Supabase: ${JSON.stringify(supabaseRequests)}`);
  assert.deepEqual(unexpectedConsoleErrors, [], `Unexpected console errors: ${JSON.stringify(unexpectedConsoleErrors)}`);
  console.log('PASS Production IndexedDB/localStorage unchanged and Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
