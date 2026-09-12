import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.P0_4_REALTIME_FAULT_TEST_PORT || '4236';
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const stagingBoundary = {
  projectRef: 'rhfdjsklfrgpoqsaqpkn',
  runtimeRole: 'staging',
  viteMode: 'staging',
  deploymentEnvironment: 'staging',
};

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const module = await vite.ssrLoadModule('/src/lib/stagingRealtimeFaultControl.ts');
  const lifecycleCalls = [];
  const snapshot = {
    channelState: 'subscribed', activeResources: ['purchases'], readStatus: 'fresh-online',
    reconnectGeneration: 1, catchUpAttempt: 0, retryCount: 0, lastCatchUpResult: 'success',
    targetedRefreshCount: 1, fullPulls: 0, diagnostics: [],
    metrics: { receivedEvents: 0, dedupedEvents: 0, deferredEvents: 0, editingCatchUps: 0, targetedRefreshes: 0, fallbackRefreshes: 1, conflicts: 0, fullPulls: 0 },
  };
  const lifecycle = {
    disconnect: async () => { lifecycleCalls.push('disconnect'); return snapshot; },
    reconnect: async () => { lifecycleCalls.push('reconnect'); return snapshot; },
    snapshot: () => { lifecycleCalls.push('snapshot'); return snapshot; },
  };

  const mutableBoundary = { ...stagingBoundary };
  const controller = new module.StagingRealtimeFaultControl(mutableBoundary, lifecycle);
  mutableBoundary.projectRef = 'twzpqyesbtnfxdkorluf';
  await controller.disconnect();
  await controller.reconnect();
  assert.equal(controller.snapshot().fullPulls, 0);
  assert.deepEqual(lifecycleCalls, ['disconnect', 'reconnect', 'snapshot']);
  assert.equal(Object.isFrozen(controller.environment), true);
  assert.equal(controller.environment.projectRef, 'rhfdjsklfrgpoqsaqpkn');

  for (const boundary of [
    { projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'production', viteMode: 'production', deploymentEnvironment: 'production' },
    { projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'experimental', viteMode: 'experimental', deploymentEnvironment: 'staging' },
    { projectRef: 'unknown-ref', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: '', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: undefined, runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'local', viteMode: 'development', deploymentEnvironment: 'development' },
  ]) {
    const rejectedCalls = [];
    assert.throws(() => new module.StagingRealtimeFaultControl(boundary, {
      disconnect: async () => { rejectedCalls.push('disconnect'); return snapshot; },
      reconnect: async () => { rejectedCalls.push('reconnect'); return snapshot; },
      snapshot: () => { rejectedCalls.push('snapshot'); return snapshot; },
    }), /P0_4_STAGING_TEST_HARNESS_DISABLED/u);
    assert.equal(rejectedCalls.length, 0);
  }

  // Defense in depth: bypassing constructor/UI still cannot invoke a lifecycle
  // operation with Production identity.
  const bypassCalls = [];
  const bypassed = Object.create(module.StagingRealtimeFaultControl.prototype);
  Object.defineProperties(bypassed, {
    environment: { value: Object.freeze({
      projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'production', viteMode: 'production', deploymentEnvironment: 'production',
    }) },
    lifecycle: { value: {
      disconnect: async () => { bypassCalls.push('disconnect'); return snapshot; },
      reconnect: async () => { bypassCalls.push('reconnect'); return snapshot; },
      snapshot: () => { bypassCalls.push('snapshot'); return snapshot; },
    } },
  });
  assert.throws(() => bypassed.disconnect(), /P0_4_STAGING_TEST_HARNESS_DISABLED/u);
  assert.throws(() => bypassed.reconnect(), /P0_4_STAGING_TEST_HARNESS_DISABLED/u);
  assert.throws(() => bypassed.snapshot(), /P0_4_STAGING_TEST_HARNESS_DISABLED/u);
  assert.equal(bypassCalls.length, 0, 'Production direct invocation reached Realtime lifecycle');
} finally {
  await vite.close();
}

if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const browserVite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/staging-p0-4-realtime-fault-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
browserVite.stdout.on('data', chunk => { output += String(chunk); });
browserVite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const url = `http://127.0.0.1:${PORT}/tests/fixtures/staging-p0-4-realtime-fault.html`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (browserVite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(url)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !/404 \(Not Found\)/u.test(message.text())) errors.push(message.text());
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.getByTestId('p0-4-auth-harness').waitFor({ timeout: 10_000 });
    } catch (error) {
      console.error(JSON.stringify({ body: await page.locator('body').innerText(), browserErrors: errors, vite: output }, null, 2));
      throw error;
    }
    try {
      await page.getByTestId('realtime-channel-state').getByText('subscribed', { exact: true }).waitFor({ timeout: 10_000 });
    } catch (error) {
      console.error(JSON.stringify({
        body: await page.locator('body').innerText(),
        browserErrors: errors,
        fake: await page.evaluate(() => window.__P0_4_REALTIME_FAKE__?.snapshot?.()),
      }, null, 2));
      throw error;
    }
    await page.getByTestId('realtime-diagnostics').getByText('purchases', { exact: true }).waitFor();
    await page.getByTestId('realtime-read-status').getByText('fresh-online', { exact: true }).waitFor();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="realtime-targeted-refreshes"]')?.textContent) === 1);
    const initial = await page.evaluate(() => window.__P0_4_REALTIME_FAKE__.snapshot());
    assert.equal(initial.channelsCreated, 1);
    assert.equal(initial.channelsRemoved, 0);
    assert.equal(initial.activeChannels, 1);
    assert.equal(initial.deliveredEvents, 0);
    assert.deepEqual(initial.queries.sort(), ['purchase_batch_items', 'purchase_batches']);
    assert.equal(await page.getByTestId('realtime-full-pulls').textContent(), '0');

    await page.getByTestId('realtime-disconnect').click();
    await page.getByTestId('realtime-channel-state').getByText('unsubscribed', { exact: true }).waitFor();
    const disconnected = await page.evaluate(() => window.__P0_4_REALTIME_FAKE__.snapshot());
    assert.equal(disconnected.activeChannels, 0);
    assert.equal(disconnected.channelsRemoved, 1);

    await page.evaluate(() => {
      const fake = window.__P0_4_REALTIME_FAKE__;
      fake.rows.purchase_batches = [{ id: 'p0-4-missed-batch', name: 'P0-4-IDEMPOTENCY-TEST-MISSED', updated_at: '2026-09-08T12:00:00Z' }];
      fake.rows.purchase_batch_items = [{ id: 'p0-4-missed-item', local_id: 'p0-4-missed-item', purchase_batch_id: 'p0-4-missed-batch', product_variant_id: 'variant-1', quantity: 1, cost: 1, updated_at: '2026-09-08T12:00:00Z' }];
      // This is the one and only commit event. The disconnected client must
      // miss it; the same-key replay intentionally emits nothing afterwards.
      fake.emit('purchase_batches', { eventType: 'INSERT', new: fake.rows.purchase_batches[0], old: {} });
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(50);
    const missed = await page.evaluate(() => window.__P0_4_REALTIME_FAKE__.snapshot());
    assert.equal(missed.deliveredEvents, 0, 'Removed channel received the missed INSERT');
    assert.deepEqual(missed.queries.sort(), ['purchase_batch_items', 'purchase_batches'], 'Intentional fault was bypassed by focus/visibility catch-up');

    await page.getByTestId('realtime-reconnect').click();
    await page.getByTestId('realtime-channel-state').getByText('subscribed', { exact: true }).waitFor();
    await page.getByTestId('realtime-read-status').getByText('fresh-online', { exact: true }).waitFor();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="realtime-targeted-refreshes"]')?.textContent) >= 1);
    assert.equal(await page.getByTestId('realtime-full-pulls').textContent(), '0');
    const reconnected = await page.evaluate(() => window.__P0_4_REALTIME_FAKE__.snapshot());
    assert.equal(reconnected.activeChannels, 1);
    assert.equal(reconnected.channelsCreated, 2);
    assert.ok(reconnected.queries.includes('purchase_batches'));
    assert.ok(reconnected.queries.includes('purchase_batch_items'));
    assert.equal(reconnected.deliveredEvents, 0, 'Catch-up depended on a synthetic second event');

    const cache = await page.evaluate(async () => {
      const { cloudCacheDb } = await import('/src/lib/db.ts');
      return {
        batches: await cloudCacheDb.getPurchaseBatches(),
        items: await cloudCacheDb.getPurchaseBatchItems(),
      };
    });
    assert.equal(cache.batches.some(row => row.id === 'p0-4-missed-batch'), true);
    assert.equal(cache.items.some(row => row.id === 'p0-4-missed-item'), true);
    assert.match(await page.getByTestId('realtime-diagnostic-events').textContent(), /attempt-start/u);
    assert.match(await page.getByTestId('realtime-diagnostic-events').textContent(), /complete/u);
    assert.equal(errors.length, 0, errors.join('\n'));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('realtime-channel-state').getByText('subscribed', { exact: true }).waitFor();
  } finally {
    await browser.close();
  }
} finally {
  browserVite.kill();
}

console.log('PASS immutable exact-Staging boundary and Production direct invocation lifecycle=0');
console.log('PASS actual channel remove/recreate lifecycle through CloudRealtimeSyncBoundary');
console.log('PASS disconnected client misses the only INSERT; same-key replay emits no second event');
console.log('PASS reconnect uses authoritative purchases Batch+Items catch-up; fullPulls=0');
console.log('PASS fault diagnostics and reload-safe normal Realtime restoration');
