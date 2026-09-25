import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4196';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4196', '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${output}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext();
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
const page = await context.newPage();
const productionRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) productionRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const { cloudCacheDb: db } = await import('/src/lib/db.ts');
    const { CloudTargetedCache } = await import('/src/providers/cloud/cloudTargetedCache.ts');
    const { CloudSyncCoordinator, resolveCloudRowIdentity } = await import('/src/providers/cloud/cloudSyncDomain.ts');
    const { optimisticUpdate, CloudStaleWriteError } = await import('/src/providers/cloud/cloudOptimisticLock.ts');

    const databaseId = '30000000-0000-4000-8000-000000000001';
    const localId = 'preview-variant-a';
    const groupId = '10000000-0000-4000-8000-000000000001';
    let server = {
      id: databaseId,
      local_id: localId,
      product_group_id: groupId,
      product_category_id: null,
      myacg_item_code: 'PREVIEW-SKU-A',
      product_title: 'preview canonical identity product',
      variant_name: 'standard',
      note: '',
      sort_order: 0,
      default_twd_cost: 1310,
      version: 1,
      updated_at: '2026-08-24T00:00:00.000Z',
    };
    await db.saveProductVariants([{ ...server }]);
    const initial = (await db.getProductVariants({ recalc: false })).find(row => row.id === databaseId);
    const initialKey = initial?.id || null;
    const queries = [];
    const cache = new CloudTargetedCache({
      query: async request => {
        queries.push({ ...request });
        if (request.table !== 'product_variants') return [];
        if (request.databaseIds && !request.databaseIds.includes(server.id)) return [];
        return [{ ...server }];
      },
    });

    // Case A/D: initial UUID row -> targeted refresh -> real IndexedDB write -> second save.
    server = { ...server, default_twd_cost: 1320, version: 2, updated_at: '2026-08-24T00:00:01.000Z' };
    const identity = resolveCloudRowIdentity('product_variants', server);
    await cache.refresh({
      reason: 'realtime',
      resources: ['products'],
      changes: [{
        table: 'product_variants',
        canonicalId: identity.canonicalId,
        databaseId: identity.databaseId,
        localId: identity.localId,
        resource: 'products',
        kind: 'UPDATE',
      }],
    });
    const afterRefreshRows = await db.getProductVariants({ recalc: false });
    const afterRefresh = afterRefreshRows.find(row => row.id === databaseId);
    const afterRefreshKey = afterRefresh?.id || null;
    const afterRefreshLocalId = afterRefresh?.local_id || null;

    let reachedFreshVersionComparison = false;
    const freshSaved = await optimisticUpdate({
      read: async id => (await db.getProductVariants({ recalc: false })).find(row => row.id === id) || null,
      compareAndSet: async (_id, expectedVersion, patch) => {
        reachedFreshVersionComparison = true;
        if (server.version !== expectedVersion) return null;
        server = { ...server, ...patch, version: server.version + 1, updated_at: '2026-08-24T00:00:02.000Z' };
        return { ...server };
      },
    }, afterRefresh, { default_twd_cost: 1330 });
    await db.updateProductVariantPatch(databaseId, {
      default_twd_cost: freshSaved.default_twd_cost,
      version: freshSaved.version,
      updated_at: freshSaved.updated_at,
    });
    const afterSecondSave = (await db.getProductVariants({ recalc: false })).find(row => row.id === databaseId);

    // Case B/C: editing client keeps its draft/cache snapshot while A advances the server.
    const draft = { value: 'B unsaved draft' };
    let editing = true;
    let conflicts = 0;
    let refreshes = 0;
    const coordinator = new CloudSyncCoordinator({
      coalesceMs: 1,
      isEditing: () => editing,
      refresh: async request => { refreshes += 1; await cache.refresh(request); },
      onRefreshed: () => {},
      onConflict: () => { conflicts += 1; },
    });
    const staleSnapshot = { ...afterSecondSave };
    server = { ...server, default_twd_cost: 1400, version: server.version + 1, updated_at: '2026-08-24T00:00:03.000Z' };
    const changedIdentity = resolveCloudRowIdentity('product_variants', server);
    coordinator.receive({
      table: 'product_variants',
      canonicalId: changedIdentity.canonicalId,
      databaseId: changedIdentity.databaseId,
      localId: changedIdentity.localId,
      resource: 'products',
      kind: 'UPDATE',
      origin: 'remote',
    });
    await coordinator.flush();
    const duringEdit = (await db.getProductVariants({ recalc: false })).find(row => row.id === databaseId);

    let staleBlocked = false;
    let reachedStaleVersionComparison = false;
    try {
      await optimisticUpdate({
        read: async id => (await db.getProductVariants({ recalc: false })).find(row => row.id === id) || null,
        compareAndSet: async (_id, expectedVersion, patch) => {
          reachedStaleVersionComparison = true;
          if (server.version !== expectedVersion) return null;
          server = { ...server, ...patch, version: server.version + 1 };
          return { ...server };
        },
      }, staleSnapshot, { default_twd_cost: 1500 });
    } catch (error) {
      staleBlocked = error instanceof CloudStaleWriteError;
    }

    const refreshesDuringEdit = refreshes;
    editing = false;
    const reconnectRan = await coordinator.fallback('reconnect', ['products']);
    const afterReconnect = (await db.getProductVariants({ recalc: false })).find(row => row.id === databaseId);
    coordinator.dispose();

    return {
      initialKey,
      afterRefreshKey,
      afterRefreshLocalId,
      afterRefreshCount: afterRefreshRows.filter(row => row.id === databaseId || row.id === localId).length,
      freshSave: {
        reachedVersionComparison: reachedFreshVersionComparison,
        found: Boolean(afterSecondSave),
        id: afterSecondSave?.id,
        value: afterSecondSave?.default_twd_cost,
        version: afterSecondSave?.version,
      },
      stale: {
        reachedVersionComparison: reachedStaleVersionComparison,
        blocked: staleBlocked,
        conflicts,
        refreshesDuringEdit,
        draft: draft.value,
        localVersionDuringEdit: duringEdit?.version,
        remoteVersion: server.version,
      },
      reconnect: {
        ran: reconnectRan,
        id: afterReconnect?.id,
        value: afterReconnect?.default_twd_cost,
        version: afterReconnect?.version,
      },
      queries,
      cacheMetrics: cache.snapshotMetrics(),
    };
  });

  assert.equal(result.initialKey, '30000000-0000-4000-8000-000000000001');
  assert.equal(result.afterRefreshKey, result.initialKey, 'Targeted refresh changed the canonical IndexedDB key');
  assert.equal(result.afterRefreshLocalId, 'preview-variant-a', 'local_id metadata was not retained');
  assert.equal(result.afterRefreshCount, 1, 'Targeted refresh created a UUID/local_id duplicate');
  assert.deepEqual(result.freshSave, {
    reachedVersionComparison: true,
    found: true,
    id: '30000000-0000-4000-8000-000000000001',
    value: 1330,
    version: 3,
  }, 'Second save after targeted refresh did not update the original entity');
  assert.deepEqual(result.stale, {
    reachedVersionComparison: true,
    blocked: true,
    conflicts: 1,
    refreshesDuringEdit: 0,
    draft: 'B unsaved draft',
    localVersionDuringEdit: 3,
    remoteVersion: 4,
  }, 'Editing draft or stale version behavior is incorrect');
  assert.deepEqual(result.reconnect, {
    ran: true,
    id: '30000000-0000-4000-8000-000000000001',
    value: 1400,
    version: 4,
  }, 'Reconnect did not converge to the latest canonical row');
  assert.deepEqual(result.queries[0].databaseIds, ['30000000-0000-4000-8000-000000000001']);
  assert.equal(result.cacheMetrics.fullPulls, 0);
  assert.equal(productionRequests.length, 0, 'Canonical identity test contacted Production Supabase');

  console.log('PASS canonical key remains stable across initial cache and targeted refresh');
  console.log('PASS second save reaches version comparison and updates the original IndexedDB entity');
  console.log('PASS editing draft is retained and stale save reaches the CAS conflict');
  console.log('PASS reconnect converges without a full ERP pull');
  console.log('PASS canonical identity integration Production Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
