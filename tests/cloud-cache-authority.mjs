import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_CACHE_AUTHORITY_TEST_PORT || '4198';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (let attempt = 0; attempt < 60; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
  try {
    if ((await fetch(BASE_URL)).ok) break;
  } catch {}
  if (attempt === 59) throw new Error(`Vite did not start:\n${output}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const supabaseRequests = [];

const openFixturePage = async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  page.on('request', request => {
    if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  return { context, page };
};

try {
  const freshRowsFixture = await openFixturePage();
  const freshRows = await freshRowsFixture.page.evaluate(async () => {
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    const { supabaseProvider } = await import('/src/providers/cloud/supabaseProvider.ts');
    const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
    const { getCloudConnectivitySnapshot } = await import('/src/providers/cloud/cloudConnectivity.ts');
    const serverGroup = {
      id: '81000000-0000-4000-8000-000000000001',
      title: 'Server fresh row',
      priority: 'Medium',
      version: 2,
      updated_at: '2026-09-07T00:00:00.000Z',
    };
    await cloudCacheDb.saveProductGroups([{ ...serverGroup, title: 'Old cache row' }]);
    supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'fixture-user', email: 'fixture@example.test' } } }, error: null });
    supabase.from = table => {
      const builder = {
        select() { return builder; }, is() { return builder; }, order() { return builder; }, range() { return builder; },
        eq() { return builder; }, limit() { return builder; },
        single: async () => table === 'profiles' ? ({ data: { role: 'owner' }, error: null }) : ({ data: null, error: null }),
        then(resolve, reject) {
          return Promise.resolve({ data: table === 'product_groups' ? [serverGroup] : [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    };
    const rows = await supabaseProvider.getProductGroups();
    return { rows, cached: await cloudCacheDb.getProductGroups(), state: getCloudConnectivitySnapshot() };
  });
  await freshRowsFixture.context.close();
  assert.equal(freshRows.rows[0].title, 'Server fresh row');
  assert.equal(freshRows.cached[0].title, 'Server fresh row');
  assert.equal(freshRows.state.readStatus, 'fresh-online');

  const slowBootstrapFixture = await openFixturePage();
  const slowBootstrap = await slowBootstrapFixture.page.evaluate(async () => {
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    const { supabaseProvider } = await import('/src/providers/cloud/supabaseProvider.ts');
    const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
    const { getCloudConnectivitySnapshot } = await import('/src/providers/cloud/cloudConnectivity.ts');
    const staleInventory = [{
      id: '87000000-0000-4000-8000-000000000001',
      inventory_key: 'stale-key', myacg_item_code: 'STALE-SKU', product_title: 'Stale catalog',
      normalized_product_title: 'Stale catalog', raw_variant_name: '', listing_type: '', final_price: 0,
      myacg_available_quantity: 0, myacg_sold_quantity: 0, myacg_listed_at: '',
    }];
    const staleGroups = [{ id: '87000000-0000-4000-8000-000000000002', title: 'Stale group', priority: 'Medium' }];
    const serverInventory = [{
      id: '88000000-0000-4000-8000-000000000001',
      inventory_key: 'server-key', myacg_item_code: 'SERVER-SKU', product_title: 'Server catalog',
      normalized_product_title: 'Server catalog', raw_variant_name: '', listing_type: '', final_price: 10,
      myacg_available_quantity: 2, myacg_sold_quantity: 0, myacg_listed_at: '',
    }];
    const serverGroups = [{ id: '88000000-0000-4000-8000-000000000002', title: 'Server group', priority: 'Medium' }];
    await cloudCacheDb.replaceAuthoritativeCloudCollections([
      { storageKey: 'erp_inventory', value: staleInventory },
      { storageKey: 'erp_product_groups', value: staleGroups },
    ]);
    localStorage.setItem('erp_cloud_cache_sync_version', 'v2_pagination');
    supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'fixture-user', email: 'fixture@example.test' } } }, error: null });
    supabase.from = table => {
      const builder = {
        select() { return builder; }, is() { return builder; }, order() { return builder; }, range() { return builder; },
        eq() { return builder; }, limit() { return builder; },
        single: async () => table === 'profiles' ? ({ data: { role: 'owner' }, error: null }) : ({ data: null, error: null }),
        then(resolve, reject) {
          const data = table === 'product_groups' ? serverGroups : table === 'inventory_items' ? serverInventory : [];
          const delay = table === 'inventory_items' ? 4_200 : 0;
          return new Promise(done => setTimeout(() => done({ data, error: null }), delay)).then(resolve, reject);
        },
      };
      return builder;
    };
    const convergence = supabaseProvider.waitForCloudBootstrapConvergence();
    await supabaseProvider.getProductGroups();
    const duringTimeout = await supabaseProvider.getInventoryCatalogSnapshot();
    const converged = await convergence;
    const afterCompletion = await supabaseProvider.getInventoryCatalogSnapshot();
    return { duringTimeout, converged, afterCompletion, state: getCloudConnectivitySnapshot() };
  });
  await slowBootstrapFixture.context.close();
  assert.equal(slowBootstrap.duringTimeout.inventory[0].myacg_item_code, 'STALE-SKU');
  assert.equal(slowBootstrap.duringTimeout.productGroups[0].title, 'Stale group');
  assert.equal(slowBootstrap.converged, true, 'The detached pull completion must be observable after the four-second boundary');
  assert.equal(slowBootstrap.afterCompletion.inventory[0].myacg_item_code, 'SERVER-SKU');
  assert.equal(slowBootstrap.afterCompletion.productGroups[0].title, 'Server group');
  assert.equal(slowBootstrap.state.readStatus, 'fresh-online');

  const emptyFixture = await openFixturePage();
  const freshEmpty = await emptyFixture.page.evaluate(async () => {
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    const { supabaseProvider } = await import('/src/providers/cloud/supabaseProvider.ts');
    const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
    const { getCloudConnectivitySnapshot } = await import('/src/providers/cloud/cloudConnectivity.ts');
    await cloudCacheDb.saveProductGroups([{ id: '82000000-0000-4000-8000-000000000001', title: 'Stale row', priority: 'Medium' }]);
    await cloudCacheDb.saveProductVariants([{
      id: '82000000-0000-4000-8000-000000000002',
      product_group_id: '82000000-0000-4000-8000-000000000001',
      myacg_item_code: 'STALE-SKU',
      variant_name: 'Stale variant',
      product_title: 'Stale row',
    }]);
    await cloudCacheDb.saveInventory([{
      inventory_key: 'STALE-INVENTORY', myacg_item_code: 'STALE-SKU', product_title: 'Stale row',
      raw_variant_name: '', listing_type: '', final_price: 0, myacg_available_quantity: 0,
      myacg_sold_quantity: 1, myacg_listed_at: '',
    }]);
    await cloudCacheDb.saveSalesOrders([{
      id: 'STALE-ORDER', platform: 'myacg', order_number: 'STALE-ORDER', buyer_name: 'Fixture', created_at: '2026-09-07',
    }]);
    await cloudCacheDb.saveSalesOrderItems([{
      id: 'STALE-ITEM', order_id: 'STALE-ORDER', myacg_item_code: 'STALE-SKU', quantity: 1,
    }]);
    supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'fixture-user', email: 'fixture@example.test' } } }, error: null });
    supabase.from = table => {
      const builder = {
        select() { return builder; }, is() { return builder; }, order() { return builder; }, range() { return builder; },
        eq() { return builder; }, limit() { return builder; },
        single: async () => table === 'profiles' ? ({ data: { role: 'owner' }, error: null }) : ({ data: null, error: null }),
        then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
      };
      return builder;
    };
    const rows = await supabaseProvider.getProductGroups();
    return {
      rows,
      cached: await cloudCacheDb.getProductGroups(),
      cachedVariants: await cloudCacheDb.getProductVariants(),
      cachedInventory: await cloudCacheDb.getInventory(),
      cachedSalesOrders: await cloudCacheDb.getSalesOrders(),
      cachedSalesOrderItems: await cloudCacheDb.getSalesOrderItems(),
      state: getCloudConnectivitySnapshot(),
    };
  });
  await emptyFixture.context.close();
  assert.deepEqual(freshEmpty.rows, []);
  assert.deepEqual(freshEmpty.cached, []);
  assert.deepEqual(freshEmpty.cachedVariants, []);
  assert.deepEqual(freshEmpty.cachedInventory, []);
  assert.deepEqual(freshEmpty.cachedSalesOrders, []);
  assert.deepEqual(freshEmpty.cachedSalesOrderItems, []);
  assert.equal(freshEmpty.state.status, 'online');
  assert.equal(freshEmpty.state.readStatus, 'fresh-empty');

  const partialFailureFixture = await openFixturePage();
  const partialFailure = await partialFailureFixture.page.evaluate(async () => {
    const { cloudCacheDb, localDb } = await import('/src/lib/db.ts');
    const { supabaseProvider } = await import('/src/providers/cloud/supabaseProvider.ts');
    const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
    const { getCloudConnectivitySnapshot, markCloudReadFresh } = await import('/src/providers/cloud/cloudConnectivity.ts');
    const cachedGroup = { id: '82500000-0000-4000-8000-000000000001', title: 'Atomic old cache', priority: 'Medium' };
    const localGroup = { id: '82500000-0000-4000-8000-000000000002', title: 'Local remains isolated', priority: 'Medium' };
    await cloudCacheDb.saveProductGroups([cachedGroup]);
    await localDb.saveProductGroups([localGroup]);
    const cacheBefore = JSON.stringify(await cloudCacheDb.getProductGroups());
    const localBefore = JSON.stringify(await localDb.getProductGroups());
    supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'fixture-user', email: 'fixture@example.test' } } }, error: null });
    supabase.from = table => {
      const builder = {
        select() { return builder; }, is() { return builder; }, order() { return builder; }, range() { return builder; },
        eq() { return builder; }, limit() { return builder; },
        single: async () => table === 'profiles' ? ({ data: { role: 'owner' }, error: null }) : ({ data: null, error: null }),
        then(resolve, reject) {
          if (table === 'inventory_items') return Promise.reject(new Error('fixture read failed after other tables returned')).then(resolve, reject);
          const data = table === 'product_groups'
            ? [{ ...cachedGroup, title: 'Partial server row must not leak into cache' }]
            : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    };
    markCloudReadFresh(1);
    const rows = await supabaseProvider.getProductGroups();
    return {
      rows,
      cacheStable: cacheBefore === JSON.stringify(await cloudCacheDb.getProductGroups()),
      localStable: localBefore === JSON.stringify(await localDb.getProductGroups()),
      state: getCloudConnectivitySnapshot(),
    };
  });
  await partialFailureFixture.context.close();
  assert.equal(partialFailure.cacheStable, true);
  assert.equal(partialFailure.localStable, true);
  assert.equal(partialFailure.rows[0].title, 'Atomic old cache');
  assert.equal(partialFailure.state.readStatus, 'stale-cache');

  for (const cachePresent of [true, false]) {
    const timeoutFixture = await openFixturePage();
    const timeout = await timeoutFixture.page.evaluate(async hasCache => {
      const { cloudCacheDb } = await import('/src/lib/db.ts');
      const { supabaseProvider } = await import('/src/providers/cloud/supabaseProvider.ts');
      const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
      const { getCloudConnectivitySnapshot, markCloudReadFresh } = await import('/src/providers/cloud/cloudConnectivity.ts');
      if (hasCache) {
        await cloudCacheDb.saveProductGroups([{ id: '83000000-0000-4000-8000-000000000001', title: 'Timeout cache', priority: 'Medium' }]);
      }
      supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'fixture-user', email: 'fixture@example.test' } } }, error: null });
      supabase.from = () => {
        const builder = {
          select() { return builder; }, is() { return builder; }, order() { return builder; }, range() { return builder; },
          eq() { return builder; }, limit() { return builder; }, single: () => new Promise(() => {}), then: () => new Promise(() => {}),
        };
        return builder;
      };
      markCloudReadFresh(1);
      const rows = await supabaseProvider.getProductGroups();
      return { rows, cached: await cloudCacheDb.getProductGroups(), state: getCloudConnectivitySnapshot() };
    }, cachePresent);
    await timeoutFixture.context.close();
    assert.equal(timeout.state.status, 'online', 'A read timeout must be degraded/stale, not misreported as offline.');
    assert.equal(timeout.state.readStatus, cachePresent ? 'stale-cache' : 'read-error');
    assert.equal(timeout.rows.length, cachePresent ? 1 : 0);
    assert.deepEqual(timeout.rows, timeout.cached);
  }

  const reconnectFixture = await openFixturePage();
  const reconnect = await reconnectFixture.page.evaluate(async () => {
    const { localDb, cloudCacheDb } = await import('/src/lib/db.ts');
    const { CloudTargetedCache } = await import('/src/providers/cloud/cloudTargetedCache.ts');
    const { getCloudConnectivitySnapshot } = await import('/src/providers/cloud/cloudConnectivity.ts');
    const localGroup = { id: '84000000-0000-4000-8000-000000000001', title: 'Local sentinel', priority: 'Medium' };
    const cachedGroup = { id: '85000000-0000-4000-8000-000000000001', title: 'Old cloud cache', priority: 'Medium' };
    const serverGroup = { id: '86000000-0000-4000-8000-000000000001', title: 'Reconnect server row', priority: 'Medium', version: 3 };
    await localDb.saveProductGroups([localGroup]);
    await cloudCacheDb.saveProductGroups([cachedGroup]);
    const localBefore = JSON.stringify(await localDb.getProductGroups());
    let serverRows = [];
    let outboundMutations = 0;
    const cache = new CloudTargetedCache({
      query: async request => {
        if ('mutation' in request) outboundMutations += 1;
        return request.table === 'product_groups' ? serverRows : [];
      },
    });
    cache.initializeCursor();
    await cache.refresh({ reason: 'reconnect', resources: ['products'], changes: [] });
    const afterZero = { rows: await cloudCacheDb.getProductGroups(), state: getCloudConnectivitySnapshot() };
    serverRows = [serverGroup];
    await cache.refresh({ reason: 'reconnect', resources: ['products'], changes: [] });
    const afterRows = { rows: await cloudCacheDb.getProductGroups(), state: getCloudConnectivitySnapshot() };
    return {
      afterZero,
      afterRows,
      localStable: localBefore === JSON.stringify(await localDb.getProductGroups()),
      outboundMutations,
      metrics: cache.snapshotMetrics(),
    };
  });
  await reconnectFixture.context.close();
  assert.deepEqual(reconnect.afterZero.rows, []);
  assert.equal(reconnect.afterZero.state.readStatus, 'fresh-empty');
  assert.equal(reconnect.afterRows.rows[0].title, 'Reconnect server row');
  assert.equal(reconnect.afterRows.state.readStatus, 'fresh-online');
  assert.equal(reconnect.localStable, true);
  assert.equal(reconnect.outboundMutations, 0);
  assert.equal(reconnect.metrics.fullPulls, 0);

  const contextSource = await readFile(new URL('../src/contexts/CloudRealtimeSyncContext.tsx', import.meta.url), 'utf8');
  assert.match(contextSource, /雲端讀取失敗｜目前顯示舊快取/);
  assert.match(contextSource, /雲端已確認｜目前沒有資料/);
  assert.equal(supabaseRequests.length, 0, 'Cloud cache authority regression contacted Supabase');

  console.log('PASS server rows replace Cloud cache and are marked fresh-online');
  console.log('PASS four-second stale fallback observes the eventual atomic authoritative replacement');
  console.log('PASS authoritative server zero clears stale Cloud cache and is marked fresh-empty');
  console.log('PASS partial server read failure leaves the complete Cloud cache transaction unchanged');
  console.log('PASS timeout with cache is stale-cache; timeout without cache is read-error');
  console.log('PASS reconnect zero/new rows converge cache without outbound mutation; fullPulls = 0');
  console.log('PASS Cloud cache authority fixtures create 0 Production/Staging requests');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
