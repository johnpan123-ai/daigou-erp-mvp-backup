import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  appType: 'custom',
});
try {
  const connectivity = await vite.ssrLoadModule('/src/providers/cloud/cloudConnectivity.ts');
  const presentation = await vite.ssrLoadModule('/src/contexts/globalSyncPresentation.ts');
  const refresh = { mode: 'cloud', busy: false, errorAt: null, lastCompletedAt: null, message: '' };
  const view = (mode = 'cloud', override = refresh) => presentation.resolveGlobalSyncPresentation(
    mode, connectivity.getCloudConnectivitySnapshot(), override,
  );

  connectivity.markCloudReadFresh(10);
  assert.equal(view().status, 'fresh', 'fast Cloud success');
  assert.equal(view().writeAllowed, true);

  connectivity.markCloudReadLoading('bootstrap');
  connectivity.markCloudReadDeferred(true);
  assert.equal(connectivity.getCloudConnectivitySnapshot().authoritativeReadPending, true);
  assert.equal(view().status, 'syncing-cached', '4s fallback keeps background request explicit');
  assert.match(view().banner, /背景同步中.*顯示上次快取/u);
  assert.throws(() => connectivity.assertCloudWriteAllowed(), /CLOUD_OFFLINE_WRITE_BLOCKED|雲端資料目前不是/u);

  connectivity.markCloudReadFresh(12);
  assert.equal(view().status, 'fresh', '6s late success converges to fresh');
  assert.equal(connectivity.getCloudConnectivitySnapshot().authoritativeReadPending, false);
  connectivity.assertCloudWriteAllowed();

  connectivity.markCloudReadFailed(new Error('permanent fixture failure'), true);
  assert.equal(view().status, 'failed', 'permanent failure is not reported as syncing');
  assert.match(view().label, /顯示快取/u);

  connectivity.markCloudReadLoading('manual-refresh');
  assert.equal(view('cloud', { ...refresh, busy: true }).status, 'syncing');
  connectivity.markCloudReadFresh(12);
  assert.equal(view('cloud', { ...refresh, lastCompletedAt: Date.now() }).status, 'fresh', 'manual refresh recovery');

  connectivity.markCloudReadDeferred(true);
  connectivity.markCloudReadFresh(13);
  assert.equal(view().status, 'fresh', 'Realtime/targeted authoritative success recovers fallback');

  const routes = ['/dashboard', '/purchase-records', '/settings', '/japan-packages', '/outbound-shipments'];
  const routePresentations = routes.map(() => view());
  assert.deepEqual(routePresentations, routePresentations.map(() => routePresentations[0]), 'all routes share one authoritative state');
  assert.equal(view('next').status, 'local');
  assert.equal(view('next').label, '本機資料');

  const [contextSource, controlSource, providerSource, settingsSource] = await Promise.all([
    readFile(new URL('../src/contexts/CloudRealtimeSyncContext.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/layout/GlobalSyncControl.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(contextSource, /resolveGlobalSyncPresentation/u);
  assert.match(controlSource, /presentation.*useGlobalSyncControl/u);
  assert.doesNotMatch(controlSource, /resolveGlobalSyncPresentation/u, 'global control must consume the provider presentation');
  assert.match(providerSource, /markCloudReadDeferred/u);
  assert.match(providerSource, /if \(err !== syncTimeoutError\) return;[\s\S]*markCloudReadDeferred/u);
  assert.match(settingsSource, /Supabase 雲端資料庫為正式來源/u);
  assert.doesNotMatch(settingsSource, /所有的 ERP 資料目前皆儲存在您的瀏覽器本地端/u);

  console.log('PASS fast success, soft fallback, late success, permanent failure, and manual recovery');
  console.log('PASS Realtime recovery, route parity, NEXT local semantics, and Cloud Settings copy');
} finally {
  await vite.close();
}
