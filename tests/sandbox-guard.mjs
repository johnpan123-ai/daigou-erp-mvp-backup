import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4188';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4188', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stableStringify = value => JSON.stringify(value, (_key, nestedValue) => {
  if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) return nestedValue;
  return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) => left.localeCompare(right)));
});

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

async function waitForProvider(page) {
  await page.waitForFunction(() => Boolean(window.dataProvider));
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await context.newPage();
const productionSupabaseRequests = [];
const unexpectedConsoleErrors = [];

page.on('dialog', dialog => { void dialog.dismiss(); });
page.on('console', message => {
  const text = message.text();
  const expectedGuardDiagnostic = text.includes('Test Sandbox blocked')
    || text.includes('[Test Sandbox Guard]');
  if (message.type() === 'error' && !expectedGuardDiagnostic) {
    unexpectedConsoleErrors.push(text);
  }
});
page.on('pageerror', error => unexpectedConsoleErrors.push(error.message));
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) {
    productionSupabaseRequests.push({ method: request.method(), url: request.url() });
  }
});

try {
  // Seed an isolated browser-context Production/local baseline. This is not the
  // user's browser DB and never connects to Supabase.
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('erp_provider_mode', 'local');
    localStorage.setItem('erp_search_term', 'production-search-sentinel');
    localStorage.setItem('remembered_email', 'production@example.invalid');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);
  await page.evaluate(async () => {
    await window.dataProvider.clearData();
    await window.dataProvider.saveProductGroups([{
      id: 'production-sentinel',
      title: 'Production sentinel',
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
    }]);
  });

  const productionBefore = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      db: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      search: environment.readPhysicalLocalStorageValue('erp_search_term'),
      rememberedEmail: environment.readPhysicalLocalStorageValue('remembered_email'),
    };
  });
  const productionDbChecksumBefore = stableStringify(productionBefore.db);

  productionSupabaseRequests.length = 0;
  await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'test'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  assert.equal(await page.title(), '[TEST] 小河馬 ERP');
  assert.match(await page.locator('body').innerText(), /Test Owner/);

  const businessOperations = await page.evaluate(async () => {
    await window.dataProvider.clearData();
    const now = '2026-08-13T00:00:00.000Z';
    const group = { id: 'test-group', title: 'Test group', created_at: now, updated_at: now };
    const variant = {
      id: 'test-variant', product_group_id: group.id, name: 'Test variant', sku: 'TEST-SKU',
      myacg_qty: 2, waca_qty: 1, waca_manual_adjustment: 1, created_at: now, updated_at: now,
    };
    const batch = { id: 'test-batch', name: 'Test purchase batch', purchase_date: '2026-08-13', created_at: now };
    const batchItem = {
      id: 'test-batch-item', purchase_batch_id: batch.id, product_variant_id: variant.id,
      quantity: 1, unit_cost_jpy: 100, created_at: now,
    };
    const japanPackage = { id: 'test-package', name: 'Test package', status: 'registered', created_at: now };
    const japanItem = {
      id: 'test-package-item', japan_package_id: japanPackage.id, product_group_id: group.id,
      product_variant_id: variant.id, quantity: 1, created_at: now,
    };
    const shipment = { id: 'test-shipment', name: 'Test shipment', status: 'draft', created_at: now };
    const shipmentItem = {
      id: 'test-shipment-item', outbound_shipment_id: shipment.id,
      japan_package_item_id: japanItem.id, quantity: 1, created_at: now,
    };

    await window.dataProvider.saveProductGroups([group]);
    await window.dataProvider.saveProductGroups([{ ...group, title: 'Test group updated' }]);
    await window.dataProvider.saveProductVariants([variant]);
    await window.dataProvider.updateProductVariantPatch(variant.id, { waca_manual_adjustment: 3 });
    await window.dataProvider.savePurchaseBatches([batch]);
    await window.dataProvider.savePurchaseBatchItems([batchItem]);
    await window.dataProvider.saveJapanPackages([japanPackage]);
    await window.dataProvider.saveJapanPackageItems([japanItem]);
    await window.dataProvider.saveOutboundShipments([shipment]);
    await window.dataProvider.saveOutboundShipmentItems([shipmentItem]);
    await window.dataProvider.upsertInventory([{
      id: 'test-inventory', item_code: 'TEST-SKU', title: 'Test inventory', stock: 1,
      created_at: now, updated_at: now,
    }]);
    await window.dataProvider.saveLastImportBackup({ data: '{"test":true}', timestamp: now });
    localStorage.setItem('erp_search_term', 'test-search');
    localStorage.setItem('remembered_email', 'test-owner@local.invalid');

    const beforeDelete = {
      groups: (await window.dataProvider.getProductGroups()).length,
      variants: (await window.dataProvider.getProductVariants()).length,
      batches: (await window.dataProvider.getPurchaseBatches()).length,
      packageItems: (await window.dataProvider.getJapanPackageItems()).length,
      shipmentItems: (await window.dataProvider.getOutboundShipmentItems()).length,
      inventory: (await window.dataProvider.getInventory()).length,
    };
    await window.dataProvider.deleteProductGroup(group.id);
    return { beforeDelete, groupsAfterDelete: (await window.dataProvider.getProductGroups()).length };
  });

  assert.deepEqual(businessOperations.beforeDelete, {
    groups: 1, variants: 1, batches: 1, packageItems: 1, shipmentItems: 1, inventory: 1,
  });
  assert.equal(businessOperations.groupsAfterDelete, 0);

  // Dashboard image upload must remain local and create no cloud request.
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.locator('.btn-change-image').first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sandbox-dashboard-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from('test-sandbox-image'),
  });
  await page.waitForTimeout(150);

  const networkAttackResult = await page.evaluate(async () => {
    const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
    const productionUrl = supabase.supabaseUrl;
    const blocked = [];
    const expectBlocked = async (name, operation) => {
      try {
        await operation();
      } catch (error) {
        const serialized = error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);
        if (error?.name === 'TestSandboxProductionNetworkBlockedError'
          || serialized.includes('Test Sandbox blocked')
          || serialized.includes('TestSandboxCloudWriteBlockedError')
          || serialized.includes('測試模式禁止寫入正式雲端')) {
          blocked.push(name);
          return;
        }
        throw new Error(`${name} failed for an unexpected reason: ${serialized}`);
      }
      throw new Error(`${name} was not blocked`);
    };

    await expectBlocked('REST GET', () => fetch(`${productionUrl}/rest/v1/product_groups?select=*`));
    await expectBlocked('REST POST', () => fetch(`${productionUrl}/rest/v1/product_groups`, { method: 'POST' }));
    await expectBlocked('REST PATCH', () => fetch(`${productionUrl}/rest/v1/product_groups?id=eq.1`, { method: 'PATCH' }));
    await expectBlocked('REST DELETE', () => fetch(`${productionUrl}/rest/v1/product_groups?id=eq.1`, { method: 'DELETE' }));
    await expectBlocked('RPC', () => fetch(`${productionUrl}/rest/v1/rpc/write_test`, { method: 'POST' }));
    await expectBlocked('Storage', () => fetch(`${productionUrl}/storage/v1/object/test/file`, { method: 'POST' }));
    await expectBlocked('Functions', () => fetch(`${productionUrl}/functions/v1/test`, { method: 'POST' }));
    await expectBlocked('Auth', () => fetch(`${productionUrl}/auth/v1/user`));
    await expectBlocked('Unknown path', () => fetch(`${productionUrl}/future/unknown/path`));
    await expectBlocked('XHR', () => new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `${productionUrl}/rest/v1/product_groups`);
        xhr.onload = resolve;
        xhr.onerror = reject;
        xhr.send();
      } catch (error) { reject(error); }
    }));
    await expectBlocked('sendBeacon', () => Promise.resolve(navigator.sendBeacon(`${productionUrl}/rest/v1/audit`, 'test')));
    await expectBlocked('WebSocket', () => Promise.resolve(new WebSocket(productionUrl.replace(/^http/, 'ws') + '/realtime/v1/websocket')));
    await expectBlocked('Supabase client', async () => {
      const { error } = await supabase.from('product_groups').select('id').limit(1);
      if (error) throw error;
    });
    await expectBlocked('Second client', async () => {
      const { createClient } = await import('/@id/@supabase/supabase-js');
      const client = createClient(productionUrl, 'test-anon-key', {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await client.from('product_groups').select('id').limit(1);
      if (error) throw error;
    });
    return blocked;
  });

  assert.equal(networkAttackResult.length, 14, 'Every Production Supabase channel must be blocked');
  assert.deepEqual(productionSupabaseRequests, [], 'No Production Supabase request may leave Test Mode');

  const productionSwitch = await page.evaluate(async () => {
    const { setProviderMode } = await import('/src/providers/providerMode.ts');
    let confirmations = 0;
    const originalConfirm = window.confirm;
    window.confirm = () => {
      confirmations += 1;
      return true;
    };
    try {
      const switched = setProviderMode('cloud');
      const storedMode = localStorage.getItem('erp_provider_mode');
      localStorage.setItem('erp_provider_mode', 'test');
      return { switched, confirmations, storedMode };
    } finally {
      window.confirm = originalConfirm;
    }
  });
  assert.deepEqual(productionSwitch, { switched: true, confirmations: 2, storedMode: 'cloud' });

  const isolation = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      productionDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      testDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1'),
      productionSearch: environment.readPhysicalLocalStorageValue('erp_search_term'),
      productionRememberedEmail: environment.readPhysicalLocalStorageValue('remembered_email'),
      testSearch: environment.readPhysicalLocalStorageValue('__hippo_test_sandbox__::erp_search_term'),
      testRememberedEmail: environment.readPhysicalLocalStorageValue('__hippo_test_sandbox__::remembered_email'),
    };
  });
  assert.equal(stableStringify(isolation.productionDb), productionDbChecksumBefore, 'Production IndexedDB changed in Test Mode');
  assert.equal(isolation.productionSearch, productionBefore.search, 'Production app localStorage changed in Test Mode');
  assert.equal(isolation.productionRememberedEmail, productionBefore.rememberedEmail, 'Production remembered email changed in Test Mode');
  assert.equal(isolation.testSearch, 'test-search');
  assert.equal(isolation.testRememberedEmail, 'test-owner@local.invalid');
  assert.notDeepEqual(isolation.testDb, {}, 'Test DB did not receive sandbox business data');

  await page.evaluate(async () => {
    const { clearTestSandboxData } = await import('/src/lib/testSandboxEnvironment.ts');
    await clearTestSandboxData();
  });
  const afterClear = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      productionDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      testDb: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1'),
      productionSearch: environment.readPhysicalLocalStorageValue('erp_search_term'),
      testSearch: environment.readPhysicalLocalStorageValue('__hippo_test_sandbox__::erp_search_term'),
    };
  });
  assert.equal(stableStringify(afterClear.productionDb), productionDbChecksumBefore, 'Clearing Test DB changed Production DB');
  assert.deepEqual(afterClear.testDb, {}, 'Test DB was not cleared');
  assert.equal(afterClear.productionSearch, productionBefore.search);
  assert.equal(afterClear.testSearch, null, 'Test localStorage namespace was not cleared');
  assert.deepEqual(unexpectedConsoleErrors, [], 'Unexpected browser console/page error in Test Mode');

  console.log('PASS Test business CRUD writes only to daigou-erp-db-test-v1');
  console.log('PASS Production IndexedDB and app localStorage checksums remain unchanged');
  console.log('PASS REST/Auth/RPC/Storage/Functions/XHR/beacon/WebSocket/client paths are fail-closed');
  console.log('PASS Production Supabase network requests = 0');
  console.log('PASS Test to Production requires two confirmations');
  console.log('PASS clearing Test Sandbox leaves Production data unchanged');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
