import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_ISOLATION_TEST_PORT || '4197';
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
    const {
      localDb,
      cloudCacheDb,
      LOCAL_AUTHORITATIVE_INDEXED_DB_NAME,
      CLOUD_CACHE_INDEXED_DB_NAME,
    } = await import('/src/lib/db.ts');
    const { CloudTargetedCache } = await import('/src/providers/cloud/cloudTargetedCache.ts');
    const {
      getCloudConnectivitySnapshot,
      markCloudReadFresh,
      markCloudReachable,
    } = await import('/src/providers/cloud/cloudConnectivity.ts');
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');

    const localGroup = {
      id: '10000000-0000-4000-8000-000000000001',
      title: 'Local authoritative sentinel',
      priority: 'Medium',
    };
    const cloudGroup = {
      id: '20000000-0000-4000-8000-000000000001',
      title: 'Cloud cache sentinel',
      priority: 'Medium',
    };
    await localDb.saveProductGroups([localGroup]);
    await cloudCacheDb.saveProductGroups([cloudGroup]);
    const localBefore = JSON.stringify(await localDb.getProductGroups());
    const cloudBefore = JSON.stringify(await cloudCacheDb.getProductGroups());

    // Local -> Cloud -> Local changes only provider selection, never either database.
    localStorage.setItem('erp_provider_mode', 'local');
    localStorage.setItem('erp_provider_mode', 'cloud');
    localStorage.setItem('erp_provider_mode', 'local');
    const switchHashes = {
      local: JSON.stringify(await localDb.getProductGroups()),
      cloud: JSON.stringify(await cloudCacheDb.getProductGroups()),
    };

    // A server-authoritative targeted read updates only Cloud cache.
    const cache = new CloudTargetedCache({
      query: async request => request.table === 'product_groups'
        ? [{ ...cloudGroup, title: 'Server canonical title', version: 2, updated_at: '2026-09-07T00:00:00.000Z' }]
        : [],
    });
    await cache.refresh({
      reason: 'realtime',
      resources: ['products'],
      changes: [{
        table: 'product_groups',
        canonicalId: cloudGroup.id,
        databaseId: cloudGroup.id,
        localId: null,
        resource: 'products',
        kind: 'UPDATE',
      }],
    });
    const localAfterRefresh = JSON.stringify(await localDb.getProductGroups());
    const cloudAfterRefresh = await cloudCacheDb.getProductGroups();

    // Local mutation never calls Supabase and never changes Cloud cache.
    localStorage.setItem('erp_provider_mode', 'local');
    const cloudHashBeforeLocalWrite = JSON.stringify(await cloudCacheDb.getProductGroups());
    await dataProvider.saveProductGroups([{ ...localGroup, title: 'Local edited' }]);
    const localAfterLocalWrite = await localDb.getProductGroups();
    const cloudAfterLocalWrite = JSON.stringify(await cloudCacheDb.getProductGroups());

    // Central Cloud gate refuses every mutation class while offline/checking.
    localStorage.setItem('erp_provider_mode', 'cloud');
    window.dispatchEvent(new Event('offline'));
    const rejected = {};
    for (const [name, operation] of Object.entries({
      save: () => dataProvider.saveProductGroups([cloudGroup]),
      delete: () => dataProvider.deleteProductGroup(cloudGroup.id),
      import: () => dataProvider.importData('{}'),
    })) {
      try {
        await operation();
        rejected[name] = null;
      } catch (error) {
        rejected[name] = { name: error?.name, code: error?.code };
      }
    }
    const localAfterOfflineAttempts = JSON.stringify(await localDb.getProductGroups());
    const cloudAfterOfflineAttempts = JSON.stringify(await cloudCacheDb.getProductGroups());
    const offlineState = getCloudConnectivitySnapshot();

    // Reconnect changes only connectivity state; it does not flush any local/cache data.
    const beforeReconnect = { local: localAfterOfflineAttempts, cloud: cloudAfterOfflineAttempts };
    window.dispatchEvent(new Event('online'));
    const reconnectState = getCloudConnectivitySnapshot();
    const afterReconnect = {
      local: JSON.stringify(await localDb.getProductGroups()),
      cloud: JSON.stringify(await cloudCacheDb.getProductGroups()),
    };

    // Online mutation fixture: rejected server write leaves cache untouched;
    // acknowledged write is followed by a targeted canonical server readback.
    await cloudCacheDb.saveProductGroups([]);
    const localBeforeCloudMutation = JSON.stringify(await localDb.getProductGroups());
    const cloudMutationGroup = {
      id: '30000000-0000-4000-8000-000000000001',
      title: 'Client draft title',
      priority: 'Medium',
    };
    const serverCanonicalGroup = {
      ...cloudMutationGroup,
      title: 'Server canonical title after save',
      version: 4,
      updated_at: '2026-09-07T00:00:01.000Z',
    };
    let rejectMutation = true;
    let mutationRequests = 0;
    let canonicalReads = 0;
    supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'fixture-user' } } }, error: null });
    supabase.from = table => {
      let operation = 'select';
      const builder = {
        select() { if (operation !== 'upsert') operation = 'select'; return builder; },
        upsert() { operation = 'upsert'; return builder; },
        eq() { return builder; },
        in() { return builder; },
        single: async () => table === 'profiles'
          ? ({ data: { role: 'owner' }, error: null })
          : ({ data: null, error: null }),
        then(resolve, reject) {
          let response = { data: [], error: null };
          if (table === 'product_groups' && operation === 'upsert') {
            mutationRequests += 1;
            response = rejectMutation
              ? { data: null, error: { message: 'fixture server rejected write', code: 'FIXTURE_REJECT' } }
              : { data: [serverCanonicalGroup], error: null };
          } else if (table === 'product_groups' && operation === 'select') {
            canonicalReads += 1;
            response = { data: [serverCanonicalGroup], error: null };
          }
          return Promise.resolve(response).then(resolve, reject);
        },
      };
      return builder;
    };

    markCloudReachable();
    markCloudReadFresh(1);
    let rejectedOnlineSave = null;
    try {
      await dataProvider.saveProductGroups([cloudMutationGroup]);
    } catch (error) {
      rejectedOnlineSave = error?.message || String(error);
    }
    const cacheAfterRejectedOnlineSave = JSON.stringify(await cloudCacheDb.getProductGroups());
    rejectMutation = false;
    markCloudReachable();
    markCloudReadFresh(1);
    await dataProvider.saveProductGroups([cloudMutationGroup]);
    const cacheAfterAcknowledgedSave = await cloudCacheDb.getProductGroups();
    const localAfterCloudMutation = JSON.stringify(await localDb.getProductGroups());
    markCloudReachable();
    markCloudReadFresh(1);

    return {
      namespaces: {
        local: localDb.databaseName,
        cloud: cloudCacheDb.databaseName,
        expectedLocal: LOCAL_AUTHORITATIVE_INDEXED_DB_NAME,
        expectedCloud: CLOUD_CACHE_INDEXED_DB_NAME,
      },
      localBefore,
      cloudBefore,
      switchHashes,
      localAfterRefresh,
      cloudAfterRefresh,
      localAfterLocalWrite,
      cloudHashBeforeLocalWrite,
      cloudAfterLocalWrite,
      rejected,
      localAfterOfflineAttempts,
      cloudAfterOfflineAttempts,
      offlineState,
      beforeReconnect,
      reconnectState,
      afterReconnect,
      localBeforeCloudMutation,
      localAfterCloudMutation,
      rejectedOnlineSave,
      cacheAfterRejectedOnlineSave,
      cacheAfterAcknowledgedSave,
      mutationRequests,
      canonicalReads,
      cacheMetrics: cache.snapshotMetrics(),
    };
  });

  assert.equal(result.namespaces.local, result.namespaces.expectedLocal);
  assert.equal(result.namespaces.cloud, result.namespaces.expectedCloud);
  assert.notEqual(result.namespaces.local, result.namespaces.cloud, 'Local and Cloud use the same IndexedDB namespace');
  assert.equal(result.switchHashes.local, result.localBefore, 'Mode switch changed Local authoritative DB');
  assert.equal(result.switchHashes.cloud, result.cloudBefore, 'Mode switch changed Cloud cache');
  assert.equal(result.localAfterRefresh, result.localBefore, 'Cloud targeted refresh wrote Local authoritative DB');
  assert.equal(result.cloudAfterRefresh[0].title, 'Server canonical title');
  assert.equal(result.localAfterLocalWrite[0].title, 'Local edited');
  assert.equal(result.cloudAfterLocalWrite, result.cloudHashBeforeLocalWrite, 'Local mutation changed Cloud cache');
  for (const mutation of ['save', 'delete', 'import']) {
    assert.deepEqual(result.rejected[mutation], { name: 'CloudOfflineWriteError', code: 'CLOUD_OFFLINE_WRITE_BLOCKED' });
  }
  assert.equal(result.localAfterOfflineAttempts, JSON.stringify(result.localAfterLocalWrite));
  assert.equal(result.cloudAfterOfflineAttempts, result.cloudAfterLocalWrite, 'Offline Cloud mutation changed cache');
  assert.equal(result.offlineState.status, 'offline');
  assert.equal(result.offlineState.readStatus, 'offline');
  assert.deepEqual(result.afterReconnect, result.beforeReconnect, 'Reconnect flushed local/cache data as an outbound mutation');
  assert.equal(result.reconnectState.status, 'checking');
  assert.equal(result.reconnectState.readStatus, 'loading');
  assert.match(result.rejectedOnlineSave, /fixture server rejected write/);
  assert.equal(result.cacheAfterRejectedOnlineSave, '[]', 'Rejected Cloud save mutated Cloud cache');
  assert.equal(result.cacheAfterAcknowledgedSave[0].title, 'Server canonical title after save');
  assert.equal(result.cacheAfterAcknowledgedSave[0].version, 4);
  assert.equal(result.localAfterCloudMutation, result.localBeforeCloudMutation, 'Cloud mutation wrote Local authoritative DB');
  assert.ok(result.mutationRequests >= 2, 'Cloud mutation fixture did not exercise failure and success');
  assert.equal(result.canonicalReads, 1, 'Successful Cloud mutation did not use exactly one targeted canonical readback');
  assert.equal(result.cacheMetrics.fullPulls, 0);
  assert.equal(supabaseRequests.length, 0, 'Isolation regression contacted Supabase');

  const [providerSource, targetedSource, modeSource, realtimeContextSource] = await Promise.all([
    readFile(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/providers/cloud/cloudTargetedCache.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/providers/dataProvider.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/contexts/CloudRealtimeSyncContext.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(providerSource, /cloudCacheDb as db/);
  assert.doesNotMatch(providerSource, /from ['"]\.\.\/\.\.\/lib\/db['"];?\s*\/\/.*local/u);
  assert.match(providerSource, /refreshAcknowledgedCloudRows\('product_groups'/, 'Cloud save does not read back the acknowledged server row');
  assert.match(providerSource, /\.upsert\(upsertData, \{ onConflict: 'inventory_key' \}\)\s*\.select\('\*'\)/u);
  assert.match(targetedSource, /cloudCacheDb as db/);
  assert.match(modeSource, /assertCloudWriteAllowed\(\)/);
  assert.match(realtimeContextSource, /Offline｜顯示最後雲端快取，所有新增、修改、刪除與匯入已停用/);
  assert.match(realtimeContextSource, /fallback\('reconnect'/, 'Reconnect does not use the existing read-only targeted refresh path');

  const methodBody = name => {
    const start = providerSource.indexOf(`  async ${name}(`);
    assert.notEqual(start, -1, `Missing Cloud mutation method ${name}`);
    const end = providerSource.indexOf('\n  async ', start + 3);
    return providerSource.slice(start, end === -1 ? providerSource.length : end)
      .replace(/\/\*[\s\S]*?\*\//g, '');
  };
  for (const name of [
    'saveProductGroups', 'saveProductCategories', 'saveProductVariants',
    'updateProductVariantPatch', 'updateProductVariantPatchBulk',
    'saveSalesOrders', 'saveSalesOrderItems', 'savePurchaseBatches',
    'savePurchaseBatchItems', 'savePrivateOrders', 'savePrivateOrderItems',
    'deletePrivateOrderItems', 'saveBundleComponents', 'saveBundleComponentsForVariant',
    'saveJapanPackages', 'saveJapanPackageItems', 'saveOutboundShipments',
    'saveOutboundShipmentItems', 'deleteProductGroup', 'deleteProductVariant',
    'deleteProductGroups',
  ]) {
    const body = methodBody(name);
    assert.match(body, /refreshAcknowledgedCloudRows/, `${name} does not refresh from acknowledged Cloud rows`);
    assert.doesNotMatch(body, /await db\.(?:save|update|delete)/, `${name} writes optimistic input directly to Cloud cache`);
  }
  for (const name of [
    'saveImportBatches', 'importData', 'clearData', 'clearPurchaseRecords',
    'createPurchaseRecordFromInventory', 'reparseProductVariants',
    'reparseProductTitles', 'syncProductGroupsWithInventory', 'restoreBackup',
  ]) {
    assert.match(methodBody(name), /throw new /, `${name} is not fail-closed in Cloud Mode`);
  }

  console.log('PASS Local authoritative and Cloud cache IndexedDB namespaces are distinct');
  console.log('PASS Local <-> Cloud mode switching preserves Local and Cloud hashes');
  console.log('PASS targeted Cloud refresh writes Cloud cache only; fullPulls = 0');
  console.log('PASS Local mutation creates 0 Supabase requests and leaves Cloud cache unchanged');
  console.log('PASS offline Cloud Save/Delete/Import refuse before network/cache mutation');
  console.log('PASS reconnect creates no outbound mutation');
  console.log('PASS acknowledged server rows, not optimistic input, update Cloud cache');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
