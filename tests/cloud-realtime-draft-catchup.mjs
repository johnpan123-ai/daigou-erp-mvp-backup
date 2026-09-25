import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_REALTIME_DRAFT_TEST_PORT || '4214';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const pageContracts = [
  ['src/pages/Dashboard.tsx', 'daily-work-dashboard'],
  ['src/pages/PurchaseRecords.tsx', 'purchase-records'],
  ['src/pages/PurchaseManagement.tsx', 'purchase-management:'],
  ['src/pages/RecentPurchases.tsx', 'recent-purchases'],
  ['src/pages/Purchasing.tsx', 'purchasing-summary'],
  ['src/pages/Inventory.tsx', 'inventory-catalog'],
  ['src/pages/UnlistedItems.tsx', 'unlisted-items'],
  ['src/pages/DuplicateVariants.tsx', 'duplicate-variants'],
  ['src/pages/JapanPackagesList.tsx', 'japan-packages-list'],
  ['src/pages/JapanPackageDetail.tsx', 'japan-package-detail:'],
  ['src/pages/OutboundShipmentsList.tsx', 'outbound-shipments-list'],
  ['src/pages/OutboundShipmentDetail.tsx', 'outbound-shipment-detail:'],
];

const [contextSource, coordinatorSource, cacheSource, coverageSource] = await Promise.all([
  readFile(new URL('../src/contexts/CloudRealtimeSyncContext.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/providers/cloud/cloudSyncDomain.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/providers/cloud/cloudTargetedCache.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/providers/cloud/cloudRealtimeCoverage.ts', import.meta.url), 'utf8'),
]);

assert.match(contextSource, /event: '\*'/u, 'Realtime subscription must include INSERT/UPDATE/DELETE');
assert.match(contextSource, /coordinatorRef\.current\?\.resume\(resources\)/u, 'Editing end must resume deferred resources');
assert.match(contextSource, /registerEditing\?\.\(owner, resourcesRef\.current, editing, draftScopeKey/u);
assert.match(contextSource, /\[editing, owner, registerEditing, resourceKey, draftScopeKey\]/u);
assert.match(contextSource, /if \(!editing && changed\.some/u, 'Refreshed resources must notify the React consumer');
assert.doesNotMatch(contextSource, /setInterval\s*\(/u, 'P0-2 must not add polling');
assert.match(coordinatorSource, /private deferred = new Map/u);
assert.match(coordinatorSource, /private deferredFallbackResources = new Set/u);
assert.match(cacheSource, /request\.reason === 'editing-ended'/u);
assert.doesNotMatch(cacheSource, /pullCoreProductData/u, 'Catch-up path must not full-pull ERP data');

for (const [relativePath, owner] of pageContracts) {
  const source = await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
  assert.match(source, /useCloudResourceSync\(/u, `${relativePath} has no Realtime React consumer`);
  assert.ok(source.includes(owner), `${relativePath} is missing coverage owner ${owner}`);
  assert.ok(coverageSource.includes(owner), `Coverage matrix is missing ${owner}`);
}

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (let attempt = 0; attempt < 80; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
  try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
  if (attempt === 79) throw new Error(`Vite did not start:\n${viteOutput}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext();
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
const page = await context.newPage();
const supabaseRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const { CloudSyncCoordinator, CLOUD_TABLE_RESOURCE } = await import('/src/providers/cloud/cloudSyncDomain.ts');
    const { CLOUD_REALTIME_PAGE_COVERAGE } = await import('/src/providers/cloud/cloudRealtimeCoverage.ts');

    const expectedTables = [
      'product_groups', 'product_categories', 'product_variants',
      'purchase_batches', 'purchase_batch_items',
      'private_orders', 'private_order_items', 'inventory_items', 'bundle_components',
      'japan_packages', 'japan_package_items',
      'outbound_shipments', 'outbound_shipment_items',
      'sales_orders', 'sales_order_items',
    ];

    let editingPurchases = false;
    let serverDashboardCount = 1;
    let dashboardCount = 1;
    let dashboardRenders = 0;
    let serverBatch = { id: 'batch-1', name: '初始批次', deleted_at: null };
    let serverItems = [];
    let purchaseView = { batch: { ...serverBatch }, items: [] };
    let purchaseRenders = 0;
    let draft = '台灣端未儲存草稿';
    let pendingConflicts = 0;
    const refreshes = [];

    const renderResources = resources => {
      if (resources.includes('products') || resources.includes('purchases')) {
        dashboardCount = serverDashboardCount;
        dashboardRenders += 1;
      }
      if (resources.includes('purchases')) {
        purchaseView = {
          batch: serverBatch.deleted_at ? null : { ...serverBatch },
          items: serverItems.filter(item => !item.deleted_at).map(item => ({ ...item })),
        };
        purchaseRenders += 1;
      }
    };

    const coordinator = new CloudSyncCoordinator({
      coalesceMs: 0,
      isEditing: resource => resource === 'purchases' && editingPurchases,
      refresh: async request => {
        refreshes.push({
          reason: request.reason,
          resources: [...request.resources],
          changes: request.changes.map(change => `${change.table}:${change.canonicalId}`),
        });
      },
      onRefreshed: renderResources,
      onConflict: () => { pendingConflicts += 1; },
    });

    const event = (table, id, kind = 'UPDATE', origin = 'remote') => ({
      table,
      canonicalId: id,
      databaseId: id,
      localId: null,
      resource: CLOUD_TABLE_RESOURCE[table],
      kind,
      origin,
    });
    const receive = async (...events) => {
      events.forEach(change => coordinator.receive(change));
      await coordinator.flush();
    };

    // Read-only Dashboard reacts to the same targeted resource notification without F5.
    serverDashboardCount = 2;
    await receive(event('product_groups', 'group-2'));
    const dashboardRealtime = { count: dashboardCount, renders: dashboardRenders };

    // Batch header and item events converge in either order.
    serverBatch = { id: 'batch-2', name: '日本新增批次', deleted_at: null };
    serverItems = [];
    await receive(event('purchase_batches', 'batch-2', 'INSERT'));
    const headerFirst = structuredClone(purchaseView);
    serverItems = [{ id: 'item-2', purchase_batch_id: 'batch-2', quantity: 3, cost: 100, deleted_at: null }];
    await receive(event('purchase_batch_items', 'item-2', 'INSERT'));
    const headerThenItems = structuredClone(purchaseView);

    serverBatch = { id: 'batch-3', name: '反向事件批次', deleted_at: null };
    serverItems = [{ id: 'item-3', purchase_batch_id: 'batch-3', quantity: 4, cost: 120, deleted_at: null }];
    purchaseView = { batch: null, items: [] };
    await receive(event('purchase_batch_items', 'item-3', 'INSERT'));
    const itemsFirst = structuredClone(purchaseView);
    await receive(event('purchase_batches', 'batch-3', 'INSERT'));
    const itemsThenHeader = structuredClone(purchaseView);

    // Remote updates, focus and reconnect are deferred while a draft is active.
    editingPurchases = true;
    const viewBeforeEdit = structuredClone(purchaseView);
    serverBatch = { ...serverBatch, name: '日本端遠端更新' };
    serverItems = [{ ...serverItems[0], quantity: 6 }];
    await receive(event('purchase_batches', 'batch-3'), event('purchase_batch_items', 'item-3'));
    await coordinator.fallback('focus', ['purchases']);
    await coordinator.fallback('reconnect', ['purchases']);
    const duringEdit = {
      view: structuredClone(purchaseView),
      draft,
      pendingConflicts,
      refreshCount: refreshes.length,
    };

    // Cancel/close/editing->idle immediately catches up deferred changes.
    editingPurchases = false;
    const cancelCatchUp = await coordinator.resume(['purchases']);
    const afterCancel = { view: structuredClone(purchaseView), draft };

    // Save success with an older pending remote event converges to server canonical value.
    editingPurchases = true;
    draft = '20';
    serverBatch = { ...serverBatch, name: '遠端 19' };
    await receive(event('purchase_batches', 'batch-3'));
    serverBatch = { ...serverBatch, name: '本機儲存 20' };
    purchaseView = { ...purchaseView, batch: { ...serverBatch } };
    editingPurchases = false;
    const saveCatchUp = await coordinator.resume(['purchases']);
    const afterSave = purchaseView.batch.name;

    // Own echo reads current canonical state; it is not treated as a remote edit conflict.
    const conflictsBeforeEcho = pendingConflicts;
    await receive(event('purchase_batches', 'batch-3', 'UPDATE', 'local'));
    const afterSelfEcho = purchaseView.batch.name;
    serverBatch = { ...serverBatch, name: '本機第二次儲存 21' };
    await receive(event('purchase_batches', 'batch-3', 'UPDATE', 'local'));
    const secondSave = purchaseView.batch.name;

    // Duplicate delivery coalesces to one refresh and does not duplicate view rows.
    const refreshesBeforeDuplicate = refreshes.length;
    await receive(event('purchase_batch_items', 'item-3'), event('purchase_batch_items', 'item-3'));
    const duplicateRefreshDelta = refreshes.length - refreshesBeforeDuplicate;

    serverItems = [{ ...serverItems[0], deleted_at: '2026-09-07T00:00:00.000Z' }];
    await receive(event('purchase_batch_items', 'item-3', 'DELETE'));
    const afterItemDelete = structuredClone(purchaseView);
    serverBatch = { ...serverBatch, deleted_at: '2026-09-07T00:00:01.000Z' };
    await receive(event('purchase_batches', 'batch-3', 'DELETE'));
    const afterBatchDelete = structuredClone(purchaseView);

    const metrics = coordinator.snapshotMetrics();
    coordinator.dispose();
    return {
      allTablesMapped: expectedTables.every(table => Boolean(CLOUD_TABLE_RESOURCE[table])),
      coverageRoutes: CLOUD_REALTIME_PAGE_COVERAGE.map(entry => entry.route),
      dashboardRealtime,
      headerFirst,
      headerThenItems,
      itemsFirst,
      itemsThenHeader,
      viewBeforeEdit,
      duringEdit,
      cancelCatchUp,
      afterCancel,
      saveCatchUp,
      afterSave,
      afterSelfEcho,
      secondSave,
      echoConflictDelta: pendingConflicts - conflictsBeforeEcho,
      duplicateRefreshDelta,
      afterItemDelete,
      afterBatchDelete,
      metrics,
      refreshes,
    };
  });

  assert.equal(result.allTablesMapped, true, 'A core Cloud table is not mapped to a Realtime resource');
  assert.ok(result.coverageRoutes.includes('/dashboard'));
  assert.ok(result.coverageRoutes.includes('/purchasing'));
  assert.deepEqual(result.dashboardRealtime, { count: 2, renders: 1 }, 'Dashboard consumer did not rerender after targeted refresh');
  assert.equal(result.headerFirst.batch.name, '日本新增批次');
  assert.equal(result.headerThenItems.items.length, 1, 'Header→Items did not converge');
  assert.equal(result.itemsFirst.batch.name, '反向事件批次');
  assert.equal(result.itemsThenHeader.items.length, 1, 'Items→Header did not converge');
  assert.deepEqual(result.duringEdit.view, result.viewBeforeEdit, 'Realtime/focus/reconnect overwrote the active view draft');
  assert.equal(result.duringEdit.draft, '台灣端未儲存草稿');
  assert.ok(result.duringEdit.pendingConflicts >= 1);
  assert.equal(result.cancelCatchUp, true, 'Cancel/close did not immediately catch up');
  assert.equal(result.afterCancel.view.batch.name, '日本端遠端更新');
  assert.equal(result.afterCancel.view.items[0].quantity, 6);
  assert.equal(result.saveCatchUp, true, 'Save success did not immediately catch up pending remote data');
  assert.equal(result.afterSave, '本機儲存 20');
  assert.equal(result.afterSelfEcho, '本機儲存 20', 'Self echo jumped back to an older value');
  assert.equal(result.secondSave, '本機第二次儲存 21', 'Second save failed after Realtime echo');
  assert.equal(result.echoConflictDelta, 0, 'Self echo was treated as a remote draft conflict');
  assert.equal(result.duplicateRefreshDelta, 1, 'Duplicate event caused duplicate targeted refreshes');
  assert.equal(result.afterItemDelete.items.length, 0);
  assert.equal(result.afterBatchDelete.batch, null);
  assert.ok(result.metrics.deferredEvents >= 2);
  assert.ok(result.metrics.editingCatchUps >= 2);
  assert.ok(result.metrics.dedupedEvents >= 1);
  assert.equal(result.metrics.fullPulls, 0);
  assert.equal(supabaseRequests.length, 0, 'P0-2 fixture contacted Supabase');

  console.log('PASS Dashboard targeted refresh rerenders without F5');
  console.log('PASS Purchase Batch/Item INSERT UPDATE DELETE and event ordering converge');
  console.log('PASS Realtime, focus and reconnect preserve active drafts');
  console.log('PASS save/cancel/close edit-end performs immediate targeted catch-up');
  console.log('PASS self echo preserves saved value and second save succeeds');
  console.log('PASS duplicate events coalesce and fullPulls = 0');
  console.log('PASS resource-to-page coverage contract includes all primary consumers');
  console.log('PASS fixture Supabase requests = 0');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
