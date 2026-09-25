import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4269';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4269', '--strictPort'], { stdio: 'pipe' });
let output = '';
vite.stdout.on('data', bytes => { output += bytes; });
vite.stderr.on('data', bytes => { output += bytes; });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* startup */ }
    if (i > 80 || vite.exitCode !== null) throw Error(output);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await browser.newPage();
  const liveRequests = [];
  const runtimeErrors = [];
  await page.route('**/*.supabase.co/**', route => { liveRequests.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  await page.goto(`${origin}/tests/fixtures/cloud-p0-2-react-harness.html?route=/purchase-records/g-holo`);
  const reload = () => page.getByRole('button', { name: '重新載入最新資料', exact: true });
  const refreshed = async () => {
    await reload().click();
    await page.getByRole('button', { name: '更新中…', exact: true }).waitFor({ state: 'hidden' });
  };
  await reload().waitFor();
  const rootNode = await page.locator('.main-area').elementHandle();
  const patchVariant = patch => page.evaluate(patch => {
    const h = window.__P0_REACT_HARNESS__;
    h.mutateServerRow('product_variants', { ...h.server.productVariants.find(r => r.id === 'v-holo'), ...patch });
  }, patch);
  await patchVariant({ variant_name: 'Manual authoritative A', version: 10 });
  assert.equal(await page.getByText('Manual authoritative A', { exact: false }).count(), 0);
  await refreshed();
  await page.getByText('Manual authoritative A', { exact: false }).first().waitFor();
  assert.equal(await rootNode.evaluate(e => e.isConnected), true, 'same mounted route');
  assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes), 0);
  console.log('PASS A: actual purchase-management button → paged Cloud read → atomic cache commit → same mounted UI');

  // A held read makes duplicate clicks deterministic and proves no early success.
  const before = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
  await page.evaluate(() => window.__P0_REACT_HARNESS__.holdNextTargetedRead());
  await reload().evaluate(e => { e.click(); e.click(); });
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().targetedReadHeld);
  assert.equal(await page.getByRole('button', { name: '更新中…' }).isDisabled(), true);
  await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseTargetedRead());
  await reload().waitFor();
  const after = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
  assert.equal(after.targetedQueriesByTable.product_groups - before.targetedQueriesByTable.product_groups, 1, 'double click = one authoritative read');
  assert.equal(await page.getByRole('alert').count(), 0, 'no-op is quiet');

  await page.getByRole('button', { name: '🔒 已鎖定' }).click();
  const draft = page.getByRole('textbox', { name: 'WACA 需求 SKU-HOLO' });
  await draft.fill('77');
  const base = await page.evaluate(async () => (await (await import('/src/lib/db.ts')).cloudCacheDb.getProductVariants()).find(r => r.id === 'v-holo'));
  await page.evaluate(() => {
    const h = window.__P0_REACT_HARNESS__;
    h.mutateServerRow('product_groups', { ...h.server.productGroups.find(r => r.id === 'g-closed'), title: 'Unrelated B manual' });
  });
  await refreshed();
  assert.equal(await draft.inputValue(), '77');
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.evaluate(async () => (await (await import('/src/lib/db.ts')).cloudCacheDb.getProductGroups()).find(r => r.id === 'g-closed').title), 'Unrelated B manual');
  await patchVariant({ version: 11, updated_by: 'same-owner', updated_at: '2026-09-22T12:00:00Z' });
  await refreshed();
  assert.equal(await draft.inputValue(), '77');
  assert.equal(await page.getByRole('alert').count(), 0, 'same-value metadata advances CAS without false conflict');
  await patchVariant({ variant_name: 'Remote same entity changed', version: 12 });
  await refreshed();
  assert.equal(await draft.inputValue(), '77');
  assert.equal(await page.getByRole('alert').filter({ hasText: '資料已被其他使用者更新' }).count(), 1);
  const protectedBase = await page.evaluate(async () => (await (await import('/src/lib/db.ts')).cloudCacheDb.getProductVariants()).find(r => r.id === 'v-holo'));
  assert.equal(protectedBase.variant_name, base.variant_name);
  assert.equal(protectedBase.version, 11, 'preserve original business/CAS base, never silently rebase draft');
  await page.evaluate(async () => {
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    dataProvider.registerFreshLoad();
    if (!dataProvider.checkIsStaleLive()) throw Error('cache read incorrectly cleared genuine conflict');
  });
  await draft.press('Enter');
  assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes), 0, 'stale save blocked');
  await page.getByRole('button', { name: '✏️ 編輯中' }).click();
  await page.getByText('Remote same entity changed', { exact: false }).first().waitFor();
  console.log('PASS C/D/E: unrelated draft preserved, same-value CAS advanced, true conflict preserves draft/base and blocks stale Save');

  await patchVariant({ variant_name: 'Must not partially commit', version: 13 });
  await page.evaluate(() => window.__P0_REACT_HARNESS__.failTargetedTableRead('product_categories'));
  await refreshed();
  await page.getByRole('alert').filter({ hasText: '尚未完成更新' }).waitFor();
  assert.equal(await page.getByText('Must not partially commit', { exact: false }).count(), 0);
  assert.equal(await page.evaluate(async () => (await (await import('/src/lib/db.ts')).cloudCacheDb.getProductVariants()).find(r => r.id === 'v-holo').version), 12);
  assert.notEqual((await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot())).connectivity.readStatus, 'fresh-online');
  await refreshed();
  await page.getByText('Must not partially commit', { exact: false }).first().waitFor();
  console.log('PASS G: failure preserves cache/UI, explicit error, no false fresh, later user action can recover');

  await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records'));
  await reload().waitFor();
  await page.evaluate(() => {
    const h = window.__P0_REACT_HARNESS__;
    h.mutateServerRow('product_groups', { ...h.server.productGroups.find(r => r.id === 'g-holo'), title: 'Summary manual fresh', normalized_title: 'Summary manual fresh' });
  });
  await refreshed();
  await page.getByText('Summary manual fresh', { exact: false }).first().waitFor();
  console.log('PASS purchase-records summary uses the same real manual button, not just the detail route');

  await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/settings'));
  await page.getByText('商品 SKU (ProductVariant)', { exact: true }).waitFor();
  const settingsNode = await page.getByText('資料庫狀態', { exact: false }).first().elementHandle();
  const stat = label => page.getByText(label, { exact: true }).locator('..').locator('span').last();
  await page.evaluate(async () => {
    const h = window.__P0_REACT_HARNESS__;
    const make = (count, prefix, base) => Array.from({ length: count }, (_, i) => ({ ...base, id: prefix + i }));
    h.server.productGroups = make(705, 'manual-g-', h.server.productGroups[0]);
    h.server.productCategories = make(390, 'manual-c-', h.server.productCategories[0]);
    h.server.productVariants = make(3254, 'manual-v-', h.server.productVariants[0]);
  });
  await refreshed();
  assert.equal(await stat('商品 SKU (ProductVariant)').textContent(), '3254 筆');
  await page.evaluate(() => {
    const h = window.__P0_REACT_HARNESS__;
    const base = h.server.productVariants[0];
    h.server.productVariants = Array.from({ length: 3461 }, (_, i) => ({ ...base, id: 'manual-v-' + i }));
    h.holdNextTargetedRead();
  });
  await reload().click();
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().targetedReadHeld);
  // Actual >4s pending interval, with the provider's existing timeout state.
  await page.waitForTimeout(4100);
  await page.evaluate(async () => {
    const c = await import('/src/providers/cloud/cloudConnectivity.ts');
    c.markCloudReadFailed(new Error('Cloud sync timed out after 4000ms'), true);
  });
  assert.equal(await stat('商品 SKU (ProductVariant)').textContent(), '3254 筆', 'no publication before atomic commit');
  await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseTargetedRead());
  await page.waitForFunction(() => [...document.querySelectorAll('span')].some(e => e.textContent === '3461 筆'));
  assert.equal(await stat('訂購紀錄母體 (ProductGroup)').textContent(), '705 筆');
  assert.equal(await stat('商品分類 (ProductCategory)').textContent(), '390 筆');
  assert.equal(await settingsNode.evaluate(e => e.isConnected), true);
  assert.equal((await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot())).connectivity.readStatus, 'fresh-online');
  await page.evaluate(() => {
    const h = window.__P0_REACT_HARNESS__;
    for (const key of ['productGroups', 'productCategories', 'productVariants']) h.server[key].push({ ...h.server[key][0], id: 'extra-' + key });
  });
  await refreshed();
  await page.waitForFunction(() => [...document.querySelectorAll('span')].some(e => e.textContent === '3462 筆'));
  assert.equal(await stat('訂購紀錄母體 (ProductGroup)').textContent(), '706 筆');
  assert.equal(await stat('商品分類 (ProductCategory)').textContent(), '391 筆');
  console.log('PASS B: mounted Settings 705/390/3254 → delayed 705/390/3461 → 706/391/3462; all pages, no F5/remount/full pull');

  const ordering = await page.evaluate(async () => {
    const { CloudTargetedCache } = await import('/src/providers/cloud/cloudTargetedCache.ts');
    const { CloudSyncCoordinator } = await import('/src/providers/cloud/cloudSyncDomain.ts');
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    // Compare raw canonical cache rows, not the SKU-deduped display projection.
    const duplicates = [{ id: 'raw-1', myacg_item_code: 'SAME-SKU' }, { id: 'raw-2', myacg_item_code: 'SAME-SKU' }];
    await cloudCacheDb.replaceProductVariantsFromAuthoritativeCloud(duplicates);
    const duplicateCache = new CloudTargetedCache({
      protectsDraft: table => table === 'product_variants',
      query: async request => request.table === 'product_variants' ? duplicates : [],
    });
    const duplicateResult = await duplicateCache.refreshWithResult({ reason: 'manual', resources: ['products'], changes: [] });
    const rawCount = (await cloudCacheDb.getProductVariants({ raw: true })).length;
    let release, enter, calls = 0, commits = 0;
    const entered = new Promise(resolve => { enter = resolve; });
    const cache = new CloudTargetedCache({ query: async request => {
      if (request.table !== 'product_groups') return [];
      const n = ++calls;
      if (n === 1) { enter(); await new Promise(resolve => { release = resolve; }); }
      return [{ id: 'race', title: 'generation-' + n }];
    } });
    const req = { reason: 'manual', resources: ['products'], changes: [] };
    const first = cache.refresh(req).catch(error => error.name);
    await entered;
    await cache.refresh(req);
    release();
    const oldResult = await first;
    const title = (await cloudCacheDb.getProductGroups())[0].title;
    let finish;
    const sync = new CloudSyncCoordinator({ isEditing: () => false, onRefreshed: () => { commits++; }, onConflict: () => {}, refresh: () => new Promise(resolve => { finish = resolve; }) });
    const one = sync.manualRefresh(['products']);
    const two = sync.manualRefresh(['products']);
    const samePromise = one === two;
    finish();
    await Promise.all([one, two]);
    sync.dispose();
    let signal, finishDisposed, disposedNotifications = 0;
    const scoped = new CloudSyncCoordinator({
      isEditing: () => false, onConflict: () => {},
      onRefreshed: () => { disposedNotifications++; },
      refresh: (_, currentSignal) => { signal = currentSignal; return new Promise(resolve => { finishDisposed = resolve; }); },
    });
    const disposed = scoped.manualRefresh(['products']);
    scoped.dispose();
    finishDisposed();
    await disposed;
    return { title, oldResult, samePromise, commits, aborted: signal.aborted, disposedNotifications, rawCount, duplicateConflicts: duplicateResult.conflicts.length };
  });
  assert.deepEqual(ordering, { title: 'generation-2', oldResult: 'CloudAuthoritativeRefreshSupersededError', samePromise: true, commits: 1, aborted: true, disposedNotifications: 0, rawCount: 2, duplicateConflicts: 0 });
  assert.equal(liveRequests.length, 0);
  assert.deepEqual(runtimeErrors, []);
  assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().metrics.fullPulls), 0);
  console.log('PASS F: newer-first commit survives older response; concurrent explicit refresh coalesced; live calls/writes/fullPulls=0');
} finally {
  await browser?.close();
  vite.kill();
}
