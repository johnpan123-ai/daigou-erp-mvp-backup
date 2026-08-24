import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4195';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'next', '--host', '127.0.0.1', '--port', '4195', '--strictPort',
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
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'next'));
const page = await context.newPage();
const productionRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) productionRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const { CloudSyncCoordinator, resolveCloudRowIdentity } = await import('/src/providers/cloud/cloudSyncDomain.ts');
    const { optimisticUpdate, CloudStaleWriteError } = await import('/src/providers/cloud/cloudOptimisticLock.ts');
    const { markLocalCloudWrite, consumeLocalCloudEcho, consumeLocalCloudEchoAliases } = await import('/src/providers/cloud/cloudRealtimeEchoRegistry.ts');

    let server = { id: 'group-1', title: 'v1', version: 1, updated_at: '2026-08-24T00:00:00.000Z' };
    const clientA = { cache: { ...server }, editing: false, draft: '' };
    const clientB = { cache: { ...server }, editing: false, draft: '' };
    const refreshes = { A: 0, B: 0 };
    const conflicts = { A: 0, B: 0 };
    let now = 100_000;

    const makeClient = (name, state) => new CloudSyncCoordinator({
      coalesceMs: 1,
      now: () => now,
      isEditing: () => state.editing,
      refresh: async () => {
        refreshes[name] += 1;
        state.cache = { ...server };
      },
      onRefreshed: () => {},
      onConflict: () => { conflicts[name] += 1; },
    });
    const a = makeClient('A', clientA);
    const b = makeClient('B', clientB);
    const change = () => ({ table: 'product_groups', rowId: server.id, resource: 'products', kind: 'UPDATE' });

    // A writes v2; the already-open B client receives one targeted refresh without F5.
    server = { ...server, title: 'v2', version: 2, updated_at: '2026-08-24T00:00:01.000Z' };
    b.receive(change());
    await b.flush();
    const viewingRefresh = clientB.cache.title;

    // B starts editing. A writes v3. B's draft and cached form model are not overwritten.
    clientB.editing = true;
    clientB.draft = 'B 尚未儲存的內容';
    server = { ...server, title: 'v3', version: 3, updated_at: '2026-08-24T00:00:02.000Z' };
    b.receive(change());
    await b.flush();
    const editingState = { cache: clientB.cache.title, draft: clientB.draft, conflicts: conflicts.B };

    // The stale v2 snapshot cannot overwrite v3.
    let staleBlocked = false;
    try {
      await optimisticUpdate({
        read: async () => ({ ...server }),
        compareAndSet: async (_id, expectedVersion, patch) => {
          if (server.version !== expectedVersion) return null;
          server = { ...server, ...patch, version: server.version + 1 };
          return { ...server };
        },
      }, clientB.cache, { title: 'stale overwrite' });
    } catch (error) {
      staleBlocked = error instanceof CloudStaleWriteError;
    }

    // After leaving edit mode, reconnect performs a catch-up refresh. Focus is throttled.
    clientB.editing = false;
    const reconnectRan = await b.fallback('reconnect', ['products']);
    const afterReconnect = clientB.cache.title;
    const focusThrottled = !(await b.fallback('focus', ['products']));
    now += 16_000;
    const focusRan = await b.fallback('focus', ['products']);

    // Duplicate events for the same row coalesce into one targeted read.
    const beforeDedupeRefreshes = refreshes.B;
    b.receive(change());
    b.receive(change());
    await b.flush();
    const dedupeRefreshDelta = refreshes.B - beforeDedupeRefreshes;
    const metrics = b.snapshotMetrics();

    // The writer's own Realtime echo refreshes its cached version without being
    // mistaken for another user's conflicting edit.
    clientA.editing = true;
    const aConflictsBefore = conflicts.A;
    a.receive({ ...change(), origin: 'local' });
    await a.flush();
    const ownEcho = { cache: clientA.cache.title, conflictDelta: conflicts.A - aConflictsBefore };
    markLocalCloudWrite('product_groups', ['echo-row'], 1000);
    const echoRegistry = [consumeLocalCloudEcho('product_groups', 'echo-row'), consumeLocalCloudEcho('product_groups', 'echo-row')];
    markLocalCloudWrite('product_groups', ['db-id'], 1000);
    const echoAliasRegistry = consumeLocalCloudEchoAliases('product_groups', ['local-id', 'db-id']);
    const rowIdentity = resolveCloudRowIdentity({ id: 'db-row', local_id: 'local-row' });

    // Non-stale CAS succeeds exactly once.
    const freshSnapshot = { ...server };
    const saved = await optimisticUpdate({
      read: async () => ({ ...server }),
      compareAndSet: async (_id, expectedVersion, patch) => {
        if (server.version !== expectedVersion) return null;
        server = { ...server, ...patch, version: server.version + 1 };
        return { ...server };
      },
    }, freshSnapshot, { title: 'v4' });

    a.dispose();
    b.dispose();
    return { viewingRefresh, editingState, staleBlocked, reconnectRan, afterReconnect, focusThrottled, focusRan, dedupeRefreshDelta, metrics, ownEcho, echoRegistry, echoAliasRegistry, rowIdentity, saved };
  });

  assert.equal(result.viewingRefresh, 'v2', 'Viewing client did not refresh after the other client wrote');
  assert.deepEqual(result.editingState, { cache: 'v2', draft: 'B 尚未儲存的內容', conflicts: 1 }, 'Editing draft was overwritten or conflict was not surfaced');
  assert.equal(result.staleBlocked, true, 'Stale client write was not blocked');
  assert.equal(result.reconnectRan, true);
  assert.equal(result.afterReconnect, 'v3');
  assert.equal(result.focusThrottled, true, 'Focus fallback ignored its 15-second request budget');
  assert.equal(result.focusRan, true, 'Focus fallback did not catch up after the throttle window');
  assert.equal(result.dedupeRefreshDelta, 1, 'Duplicate row events caused duplicate targeted reads');
  assert.ok(result.metrics.dedupedEvents >= 1);
  assert.equal(result.metrics.fullPulls, 0, 'Realtime path performed a full pull');
  assert.deepEqual(result.ownEcho, { cache: 'v3', conflictDelta: 0 }, 'Writer treated its own Realtime echo as a remote conflict');
  assert.deepEqual(result.echoRegistry, [true, false], 'Local echo registry did not consume exactly once');
  assert.equal(result.echoAliasRegistry, true, 'Local echo registry did not match database/local id aliases');
  assert.deepEqual(result.rowIdentity, { rowId: 'local-row', databaseId: 'db-row' }, 'Realtime identity must use local_id for cache/echo and id for targeted DB reads');
  assert.equal(result.saved.title, 'v4');
  assert.equal(result.saved.version, 4);
  assert.equal(productionRequests.length, 0, 'NEXT integration test contacted Production Supabase');

  const [contextSource, cacheSource, providerSource] = await Promise.all([
    readFile(new URL('../src/contexts/CloudRealtimeSyncContext.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/providers/cloud/cloudTargetedCache.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(contextSource, /postgres_changes/);
  assert.match(contextSource, /visibilitychange/);
  assert.doesNotMatch(contextSource, /setInterval\s*\(/, 'Realtime implementation must not use high-frequency polling');
  assert.match(cacheSource, /\.in\('id', databaseIds\)/, 'Realtime changes must refetch changed rows by database id');
  assert.match(cacheSource, /\.gt\('updated_at', cursor\)/, 'Focus/reconnect must use incremental catch-up');
  assert.doesNotMatch(cacheSource, /pullCoreProductData/, 'Realtime cache path must not full-pull ERP data');
  assert.match(providerSource, /assertCloudRowsFresh\('product_groups'/);
  assert.match(providerSource, /\.eq\('version', localVariant\.version \?\? -1\)/);
  console.log('PASS two-client viewing refreshes without F5');
  console.log('PASS editing draft is preserved and remote change is surfaced');
  console.log('PASS stale write is blocked by optimistic version contract');
  console.log('PASS reconnect/focus catch-up is incremental and throttled');
  console.log('PASS duplicate realtime events use one targeted refresh');
  console.log('PASS NEXT integration Production Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
