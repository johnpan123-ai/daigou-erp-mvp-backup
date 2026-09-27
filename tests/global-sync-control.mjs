import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4391';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4391', '--strictPort'], { stdio: 'pipe' });
let output = '';
vite.stdout.on('data', bytes => { output += bytes; });
vite.stderr.on('data', bytes => { output += bytes; });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* local server starting */ }
    if (i > 80 || vite.exitCode !== null) throw Error(output);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const runtimeErrors = [];
  const liveRequests = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route('**/*.supabase.co/**', route => { liveRequests.push(route.request().url()); return route.abort(); });
  await page.goto(`${origin}/tests/fixtures/cloud-p0-2-react-harness.html?route=/purchase-records&realReads=1`);
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  // The fixture boots in its sandbox identity, as production AuthProvider requires.
  // Switch only its disposable browser storage after the real route has mounted.
  await page.evaluate(async () => {
    localStorage.setItem('erp_provider_mode', 'cloud');
    (await import('/src/providers/cloud/cloudConnectivity.ts')).markCloudReadFresh(10);
  });
  const control = page.locator('[data-global-sync-control]');
  const button = control.getByRole('button', { name: '同步資料' });
  const status = control.getByRole('status').first();
  await button.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-global-sync-control] [role=status]')?.textContent?.includes('已同步'));
  assert.equal(await page.locator('.environment-status-bar').count() > 0, true, 'environment badge retained');
  assert.equal(await page.locator('[data-workspace-header] .cloud-refresh-control').count(), 0, 'duplicate page refresh removed');

  await page.evaluate(() => window.__P0_REACT_HARNESS__.holdNextTargetedRead());
  const before = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
  await button.evaluate(node => { node.click(); node.click(); });
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().targetedReadHeld);
  assert.match(await status.textContent(), /同步中/);
  assert.equal(await control.getByRole('button', { name: '同步中…' }).isDisabled(), true);
  await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseTargetedRead());
  await button.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-global-sync-control] [role=status]')?.textContent?.includes('已同步'));
  const after = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
  assert.equal(after.targetedQueriesByTable.product_groups - before.targetedQueriesByTable.product_groups, 1, 'double click dispatches one authoritative read');
  assert.equal(after.writes, 0);
  assert.equal(after.metrics.fullPulls, 0);

  await page.evaluate(async () => {
    const connectivity = await import('/src/providers/cloud/cloudConnectivity.ts');
    connectivity.markCloudReadFailed(new Error('Cloud sync timed out after 4000ms'), true);
    let blocked = false;
    try { connectivity.assertCloudWriteAllowed(); } catch (error) { blocked = error.code === 'CLOUD_OFFLINE_WRITE_BLOCKED'; }
    if (!blocked) throw new Error('soft timeout opened cloud write guard');
  });
  await page.waitForFunction(() => document.querySelector('[data-global-sync-control] [role=status]')?.textContent?.includes('顯示快取資料'));
  assert.equal(await page.getByRole('status').filter({ hasText: '雲端仍在同步｜目前顯示上次快取；寫入已暫停' }).count(), 1, 'soft timeout is not presented as a hard read failure');
  await page.evaluate(async () => (await import('/src/providers/cloud/cloudConnectivity.ts')).markCloudReadFresh(10));
  await page.waitForFunction(() => document.querySelector('[data-global-sync-control] [role=status]')?.textContent?.includes('已同步'));
  await page.evaluate(async () => (await import('/src/providers/cloud/cloudConnectivity.ts')).markCloudReadFailed(new Error('authoritative request failed'), true));
  await page.waitForFunction(() => document.querySelector('[data-global-sync-control] [role=status]')?.textContent?.includes('同步失敗'));
  await page.evaluate(async () => {
    localStorage.setItem('erp_provider_mode', 'experimental');
    (await import('/src/providers/cloud/cloudConnectivity.ts')).markCloudReadFresh(10);
  });
  await page.waitForFunction(() => document.querySelector('[data-global-sync-control] [role=status]')?.textContent?.includes('已同步'));
  assert.equal(await control.getByRole('alert').count(), 0, 'old Cloud failure does not leak into local identity');
  assert.deepEqual(liveRequests, []);
  assert.deepEqual(runtimeErrors, []);
  console.log('PASS cloud global sync: badge, fresh, single-flight, syncing, late fresh, cached soft timeout, hard failure, write fail-closed, no writes/full pull/live traffic');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await control.isVisible(), false, 'mobile header preserved');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'mobile no fatal overflow');
  console.log('PASS mobile header unchanged, no overflow');
} finally {
  await browser?.close();
  vite.kill();
}
