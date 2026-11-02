// Page return caches (outbound list/detail via useMountedContentLoadState) never cross account,
// provider mode, or cloud cache generation; edits/deletes update or drop them. Synthetic, no network.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: 'custom' });
try {
  const cache = await vite.ssrLoadModule('/src/hooks/useMountedContentLoadState.ts');
  const gen = await vite.ssrLoadModule('/src/lib/viewSnapshotGeneration.ts');
  const A = 'cloud:user-a', B = 'cloud:user-b', LOCAL = 'local:user-a';
  const g0 = gen.getViewSnapshotGeneration();
  cache.storeMountedContentCache('outbound-shipments-list', A, g0, [['ob-1']]);
  assert.deepEqual(cache.readMountedContentCache('outbound-shipments-list', A), [['ob-1']], 'same account/mode reuses');
  assert.equal(cache.readMountedContentCache('outbound-shipments-list', B), null, 'another account never sees it');
  assert.equal(cache.readMountedContentCache('outbound-shipments-list', LOCAL), null, 'another provider mode never sees it');
  assert.equal(cache.readMountedContentCache('outbound-shipments-list', A, value => value[0].includes('ob-9')), null, 'accept() rejects a read without the requested record');
  // A read that started before an invalidation is not stored.
  gen.bumpViewSnapshotGeneration();
  cache.storeMountedContentCache('outbound-shipment-detail', A, g0, ['stale']);
  assert.equal(cache.readMountedContentCache('outbound-shipment-detail', A), null, 'straddling read not kept');
  assert.equal(cache.readMountedContentCache('outbound-shipments-list', A), null, 'generation change (Restore / reread) drops old entries');
  // Patch only applies to the matching scope/generation; drop forgets.
  const g1 = gen.getViewSnapshotGeneration();
  cache.storeMountedContentCache('outbound-shipments-list', A, g1, [['ob-1']]);
  cache.patchMountedContentCache('outbound-shipments-list', B, () => [['hijacked']]);
  assert.deepEqual(cache.readMountedContentCache('outbound-shipments-list', A), [['ob-1']], 'other account cannot patch');
  cache.patchMountedContentCache('outbound-shipments-list', A, value => [[...value[0], 'ob-2']]);
  assert.deepEqual(cache.readMountedContentCache('outbound-shipments-list', A), [['ob-1', 'ob-2']]);
  cache.dropMountedContentCache('outbound-shipments-list');
  assert.equal(cache.readMountedContentCache('outbound-shipments-list', A), null, 'delete drops the cache');
  console.log('PASS view return cache: account / mode / generation isolation, patch and drop');
} finally { await vite.close(); }
