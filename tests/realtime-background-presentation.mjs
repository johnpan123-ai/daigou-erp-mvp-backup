// Presentation of the background pause: never synced/writable, no banner/counter for the normal pause,
// offline and real Realtime failures keep their warnings. Pure module test (no network).
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: 'custom' });
try {
  const { resolveGlobalSyncPresentation } = await vite.ssrLoadModule('/src/contexts/globalSyncPresentation.ts');
  const refresh = { mode: 'cloud', busy: false, errorAt: null, lastCompletedAt: null, message: '', restorePending: false };
  const conn = over => ({ status: 'online', readStatus: 'stale-cache', authoritativeReadPending: false, lastReachableAt: 1, lastFreshReadAt: 1, reason: 'realtime-background-paused', ...over });
  const paused = resolveGlobalSyncPresentation('cloud', conn({}), refresh, { unproven: false, backgroundPaused: true });
  assert.deepEqual([paused.label, paused.banner, paused.writeAllowed], ['背景暫停中，切回後同步', null, false]);
  const resuming = resolveGlobalSyncPresentation('cloud', conn({ readStatus: 'loading' }), { ...refresh, busy: true }, { unproven: false, resuming: true });
  assert.deepEqual([resuming.label, resuming.banner, resuming.writeAllowed], ['正在重新連線…', null, false]);
  // Fresh wins only when actually fresh (after the proof): then normal synced presentation.
  const fresh = resolveGlobalSyncPresentation('cloud', conn({ readStatus: 'fresh-online', reason: null }), refresh, { unproven: false, resuming: true });
  assert.equal(fresh.writeAllowed, true);
  // Real failure overrides pause/resume; offline keeps its own warning.
  const failed = resolveGlobalSyncPresentation('cloud', conn({}), refresh, { unproven: true, resuming: true });
  assert.match(failed.banner, /即時同步目前未確認/u); assert.equal(failed.writeAllowed, false); assert.equal(failed.action, 'realtime-reconnect');
  const offline = resolveGlobalSyncPresentation('cloud', conn({ status: 'offline', readStatus: 'offline', reason: 'browser-offline' }), refresh, { unproven: false, backgroundPaused: true });
  assert.notEqual(offline.label, '背景暫停中，切回後同步'); assert.equal(offline.writeAllowed, false); assert.ok(offline.banner, 'offline still explained');
  console.log('PASS background pause presentation: not synced/writable, no counter/banner; failures and offline still warn');
} finally { await vite.close(); }
