import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_RESTORE_CACHE_TEST_PORT || '4271';
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
  try { if ((await fetch(BASE_URL)).ok) break; } catch {}
  if (attempt === 59) throw new Error(`Vite did not start:\n${output}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext();
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
const page = await context.newPage();
const externalRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) externalRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    const { CloudTargetedCache } = await import('/src/providers/cloud/cloudTargetedCache.ts');
    const { preserveCloudRestoreSuccessThroughRefresh } = await import('/src/providers/cloud/cloudRestoreSubmit.ts');

    const makeRows = (count, makeRow) => Array.from({ length: count }, (_, index) => makeRow(index));
    const server = {
      inventory_items: makeRows(5517, index => ({
        id: `inventory-${index}`, inventory_key: `inventory-key-${index}`, myacg_item_code: `SKU-${index}`,
        product_title: `Product ${index}`, raw_variant_name: `Variant ${index}`, listing_type: 'fixture',
        final_price: 10, myacg_available_quantity: 2, myacg_sold_quantity: 0,
        myacg_listed_at: '2026-09-21T00:00:00.000Z', updated_at: '2026-09-21T00:00:00.000Z',
      })),
      product_groups: makeRows(847, index => ({
        id: `group-${index}`, title: `Group ${index}`, priority: 'Medium', updated_at: '2026-09-21T00:00:00.000Z',
      })),
      product_categories: makeRows(663, index => ({
        id: `category-${index}`, product_group_id: `group-${index % 847}`, name: `Category ${index}`,
        updated_at: '2026-09-21T00:00:00.000Z',
      })),
      product_variants: makeRows(4939, index => ({
        id: `variant-${index}`, product_group_id: `group-${index % 847}`,
        product_category_id: `category-${index % 663}`, myacg_item_code: `VARIANT-SKU-${index}`,
        variant_name: `Variant ${index}`, product_title: `Variant product ${index}`,
        updated_at: '2026-09-21T00:00:00.000Z',
      })),
    };
    const oldInventory = server.inventory_items.slice(0, 1000);
    const oldGroups = server.product_groups.slice(0, 705);
    const oldCategories = server.product_categories.slice(0, 390);
    const oldVariants = server.product_variants.slice(0, 721);
    await cloudCacheDb.replaceAuthoritativeCloudCollections([
      { storageKey: 'erp_inventory', value: oldInventory },
      { storageKey: 'erp_product_groups', value: oldGroups },
      { storageKey: 'erp_product_categories', value: oldCategories },
      { storageKey: 'erp_product_variants', value: oldVariants },
    ]);

    const cache = new CloudTargetedCache({
      query: async request => {
        const rows = server[request.table] || [];
        const from = request.from ?? 0;
        const to = request.to ?? rows.length - 1;
        return rows.slice(from, to + 1);
      },
    });
    const originalReplace = cloudCacheDb.replaceAuthoritativeCloudCollections.bind(cloudCacheDb);
    let releaseCommit;
    let commitStarted = false;
    const commitGate = new Promise(resolve => { releaseCommit = resolve; });
    cloudCacheDb.replaceAuthoritativeCloudCollections = async entries => {
      commitStarted = true;
      await commitGate;
      return originalReplace(entries);
    };
    let refreshSettled = false;
    const refreshResult = preserveCloudRestoreSuccessThroughRefresh(
      { ok: true, restoreEpoch: 3 },
      () => cache.refresh({
        reason: 'reconnect', resources: ['products', 'inventory'], changes: [], authoritativeEpoch: 3,
      }),
      { attemptCorrelationId: 'fixture-attempt', idempotencyKey: 'fixture-key' },
    ).then(value => { refreshSettled = true; return value; });
    while (!commitStarted) await new Promise(resolve => setTimeout(resolve, 0));
    const completionBeforeCommit = refreshSettled;
    releaseCommit();
    const completed = await refreshResult;
    cloudCacheDb.replaceAuthoritativeCloudCollections = originalReplace;

    const counts = {
      inventory: (await cloudCacheDb.getInventory()).length,
      groups: (await cloudCacheDb.getProductGroups()).length,
      categories: (await cloudCacheDb.getProductCategories()).length,
      variants: (await cloudCacheDb.getProductVariants({ recalc: false })).length,
    };
    const metrics = cache.snapshotMetrics();

    let epochRegression = null;
    try {
      await cache.refresh({ reason: 'reconnect', resources: ['inventory'], changes: [], authoritativeEpoch: 2 });
    } catch (error) {
      epochRegression = error instanceof Error ? error.message : String(error);
    }

    let releaseOld;
    let oldStarted = false;
    let serveOld = true;
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const raceCache = new CloudTargetedCache({
      query: async request => {
        if (serveOld) {
          oldStarted = true;
          await oldGate;
          return request.from === 0 ? [server.inventory_items[0]] : [];
        }
        return request.from === 0 ? server.inventory_items.slice(0, 2) : [];
      },
    });
    const oldRefresh = raceCache.refresh({
      reason: 'reconnect', resources: ['inventory'], changes: [], authoritativeEpoch: 2,
    }).then(() => null, error => error instanceof Error ? error.message : String(error));
    while (!oldStarted) await new Promise(resolve => setTimeout(resolve, 0));
    serveOld = false;
    await raceCache.refresh({ reason: 'reconnect', resources: ['inventory'], changes: [], authoritativeEpoch: 3 });
    releaseOld();
    const oldOutcome = await oldRefresh;
    const raceRows = await cloudCacheDb.getInventory();

    return {
      completionBeforeCommit,
      completionStatus: completed.authoritativeRefresh?.status,
      counts,
      metrics,
      epochRegression,
      oldOutcome,
      raceCount: raceRows.length,
      raceEpoch: raceCache.snapshotMetrics().committedAuthoritativeEpoch,
    };
  });

  assert.equal(result.completionBeforeCommit, false, 'Refresh completion was published before the cache transaction committed');
  assert.equal(result.completionStatus, 'complete');
  assert.deepEqual(result.counts, { inventory: 5517, groups: 847, categories: 663, variants: 4939 });
  assert.equal(result.metrics.requestsByTable.inventory_items, 6, '5517 rows must require six 1000-row pages');
  assert.equal(result.metrics.requestsByTable.product_variants, 5, '4939 rows must require five 1000-row pages');
  assert.equal(result.metrics.committedAuthoritativeEpoch, 3);
  assert.equal(result.epochRegression, 'CLOUD_CACHE_AUTHORITATIVE_EPOCH_REGRESSION');
  assert.equal(result.oldOutcome, 'CLOUD_CACHE_AUTHORITATIVE_REFRESH_SUPERSEDED');
  assert.equal(result.raceCount, 2, 'A late epoch-2 result overwrote the epoch-3 cache');
  assert.equal(result.raceEpoch, 3);
  assert.equal(externalRequests.length, 0, 'Offline cache convergence fixture contacted Supabase');

  console.log('PASS Restore authoritative reads paginate 5517/847/663/4939 rows and atomically replace cache');
  console.log('PASS completion remains pending until the IndexedDB transaction commits');
  console.log('PASS epoch 2 cache/results cannot overwrite the committed epoch 3 generation');
  console.log('PASS fixture Cloud/Production requests = 0');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
