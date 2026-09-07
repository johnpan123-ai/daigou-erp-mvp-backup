import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_REALTIME_REACT_TEST_PORT || '4219';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIXTURE_URL = `${BASE_URL}/tests/fixtures/cloud-p0-2-react-harness.html`;
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

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
  if (attempt === 79) throw new Error(`Vite start timeout:\n${viteOutput}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const supabaseRequests = [];
const consoleErrors = [];
let pageReloads = 0;

const boot = async route => {
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  page.on('request', request => {
    if (/\.supabase\.co\//iu.test(request.url())) supabaseRequests.push(request.url());
  });
  page.on('console', message => {
    if (message.type() === 'error' && !/favicon\.ico/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) pageReloads += 1; });
  await page.goto(`${FIXTURE_URL}?route=${encodeURIComponent(route)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().connectivity.readStatus !== 'loading');
  return { context, page };
};

const snap = page => page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
const closeSession = async session => session.context.close();
const serverRow = (page, collection, id) => page.evaluate(({ collection, id }) => (
  structuredClone(window.__P0_REACT_HARNESS__.server[collection].find(row => row.id === id))
), { collection, id });
const emitPatch = async (page, table, collection, id, patch, eventType = 'UPDATE') => {
  await page.evaluate(async ({ table, collection, id, patch, eventType }) => {
    const harness = window.__P0_REACT_HARNESS__;
    const current = harness.server[collection].find(row => row.id === id) || { id };
    await harness.emitUpsert(table, { ...current, ...patch, id, updated_at: new Date().toISOString() }, eventType);
  }, { table, collection, id, patch, eventType });
};
const waitText = (page, text) => page.getByText(text, { exact: false }).first().waitFor();

const coverage = [];
const exercisePage = async ({ route, readyText, table, collection, id, patch, expectedText, beforeAction }) => {
  const session = await boot(route);
  const { page } = session;
  try {
    await waitText(page, readyText);
    if (beforeAction) await beforeAction(page);
    const before = await snap(page);
    await emitPatch(page, table, collection, id, patch);
    await waitText(page, expectedText);
    const after = await snap(page);
    assert.ok(after.metrics.targetedRefreshes > before.metrics.targetedRefreshes, `${route} did not targeted-refresh`);
    assert.ok(after.targetedQueries > before.targetedQueries, `${route} did not query the changed resource`);
    assert.equal(after.metrics.fullPulls, 0, `${route} used a full pull`);
    coverage.push({ route, table, reactDom: 'PASS', targetedRefresh: 'PASS' });
  } finally {
    await closeSession(session);
  }
};

try {
  // Dashboard: actual React DOM and Cloud freshness states.
  {
    const session = await boot('/dashboard');
    const { page } = session;
    try {
      await page.locator('[data-dashboard-task="unlisted"]').waitFor();
      const beforeCounts = await page.locator('[data-dashboard-task] [data-task-count]').allTextContents();
      const before = await snap(page);
      const navigationsBeforeEvent = pageReloads;
      await emitPatch(page, 'product_groups', 'productGroups', 'g-c108', { title: 'Dashboard Remote B' });
      await waitText(page, 'Dashboard Remote B');
      const after = await snap(page);
      assert.ok(after.metrics.targetedRefreshes > before.metrics.targetedRefreshes);
      assert.equal(after.metrics.fullPulls, 0);
      assert.equal(pageReloads, navigationsBeforeEvent, 'Dashboard test unexpectedly reloaded the page');

      await page.evaluate(() => window.__P0_REACT_HARNESS__.failTargetedReadOnce());
      await page.evaluate(async () => {
        const h = window.__P0_REACT_HARNESS__;
        const row = { ...h.server.productGroups.find(item => item.id === 'g-c108'), title: 'SHOULD NOT BE FRESH' };
        try { await h.emitUpsert('product_groups', row); } catch { /* expected */ }
      });
      await waitText(page, '目前顯示舊快取');
      assert.deepEqual(await page.locator('[data-dashboard-task] [data-task-count]').allTextContents(), beforeCounts);
      assert.equal((await snap(page)).connectivity.readStatus, 'stale-cache');

      await emitPatch(page, 'product_groups', 'productGroups', 'g-c108', { title: 'Dashboard Recovered Fresh' });
      await waitText(page, 'Dashboard Recovered Fresh');
      assert.equal((await snap(page)).connectivity.readStatus, 'fresh-online');

      await page.evaluate(async () => {
        const h = window.__P0_REACT_HARNESS__;
        for (const table of [
          'product_groups', 'product_categories', 'product_variants', 'purchase_batches', 'purchase_batch_items',
          'private_orders', 'private_order_items', 'inventory_items', 'sales_orders', 'sales_order_items',
        ]) h.setServerRows(table, []);
        await h.fallback('reconnect', ['products', 'purchases', 'privateOrders', 'inventory', 'salesOrders']);
      });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-task-count]')].every(node => node.textContent === '0'));
      await waitText(page, '雲端已確認｜目前沒有資料');
      assert.equal((await snap(page)).connectivity.readStatus, 'fresh-empty');
      coverage.push({ route: '/dashboard', table: 'product_groups + dependencies', reactDom: 'PASS', targetedRefresh: 'PASS' });
    } finally {
      await closeSession(session);
    }
  }

  // Dashboard read-error with no cache and explicit Offline state.
  {
    const session = await boot('/dashboard');
    const { page } = session;
    try {
      await page.evaluate(async () => {
        const h = window.__P0_REACT_HARNESS__;
        await h.setCacheRows('product_groups', []);
        h.failTargetedReadOnce();
        const row = { ...h.server.productGroups[0], title: 'READ ERROR ROW' };
        try { await h.emitUpsert('product_groups', row); } catch { /* expected */ }
      });
      await waitText(page, '目前沒有可確認的最新資料');
      assert.equal((await snap(page)).connectivity.readStatus, 'read-error');
      await page.evaluate(() => window.__P0_REACT_HARNESS__.offline());
      await waitText(page, 'Offline｜顯示最後雲端快取');
      assert.equal((await snap(page)).connectivity.status, 'offline');
    } finally {
      await closeSession(session);
    }
  }

  // Every primary React consumer receives a real event, targeted-refetches, and changes the actual DOM.
  const pageCases = [
    { route: '/purchase-records', readyText: '訂購紀錄表', table: 'product_groups', collection: 'productGroups', id: 'g-holo', patch: { normalized_title: 'records remote b' }, expectedText: 'records remote b' },
    { route: '/purchase-records/g-holo', readyText: '代購工作規格表', table: 'product_categories', collection: 'productCategories', id: 'c-holo', patch: { title: 'Category Remote B' }, expectedText: 'Category Remote B' },
    { route: '/purchase-records/g-holo', readyText: '代購工作規格表', table: 'product_variants', collection: 'productVariants', id: 'v-holo', patch: { variant_name: 'Variant Remote B' }, expectedText: 'Variant Remote B' },
    { route: '/recent-purchases', readyText: '近期採購', table: 'product_groups', collection: 'productGroups', id: 'g-holo', patch: { normalized_title: 'recent remote b' }, expectedText: 'recent remote b', beforeAction: page => page.locator('[data-testid="recent-purchases-date-toggle"]').click() },
    { route: '/purchasing', readyText: '採購總表', table: 'product_groups', collection: 'productGroups', id: 'g-holo', patch: { normalized_title: 'purchasing remote b' }, expectedText: 'purchasing remote b' },
    { route: '/japan-packages', readyText: 'React Japan Package A', table: 'japan_packages', collection: 'japanPackages', id: 'jp-react-1', patch: { title: 'Japan List Remote B' }, expectedText: 'Japan List Remote B' },
    { route: '/japan-packages/jp-react-1', readyText: '包裹基本資訊', table: 'japan_packages', collection: 'japanPackages', id: 'jp-react-1', patch: { title: 'Japan Detail Remote B' }, expectedText: 'Japan Detail Remote B' },
    { route: '/outbound-shipments', readyText: 'React Outbound A', table: 'outbound_shipments', collection: 'outboundShipments', id: 'out-react-1', patch: { title: 'Outbound List Remote B' }, expectedText: 'Outbound List Remote B' },
    { route: '/outbound-shipments/out-react-1', readyText: '出庫清單', table: 'outbound_shipments', collection: 'outboundShipments', id: 'out-react-1', patch: { title: 'Outbound Detail Remote B' }, expectedText: 'Outbound Detail Remote B' },
  ];
  for (const pageCase of pageCases) await exercisePage(pageCase);

  // Private Orders and Sales Orders/Items drive real Purchase Management DOM consumers.
  {
    const session = await boot('/purchase-records/g-closed');
    const { page } = session;
    try {
      await page.getByText('私下登記紀錄', { exact: true }).click();
      await waitText(page, 'Core Fixture');
      await emitPatch(page, 'private_orders', 'privateOrders', 'po-closed', { customer_name: 'Private Remote B' });
      await waitText(page, 'Private Remote B');
      coverage.push({ route: '/purchase-records/:id', table: 'private_orders/private_order_items', reactDom: 'PASS', targetedRefresh: 'PASS' });
    } finally { await closeSession(session); }
  }
  {
    const session = await boot('/purchase-records/g-holo');
    const { page } = session;
    try {
      const totalCard = page.getByText('訂單總金額', { exact: true }).locator('xpath=../..');
      await totalCard.getByText('1,000', { exact: true }).waitFor();
      await emitPatch(page, 'sales_orders', 'salesOrders', 'so-react-1', { buyer_name: 'Sales Remote B' });
      await emitPatch(page, 'sales_order_items', 'salesOrderItems', 'soi-react-1', { amount: 9000 });
      await totalCard.getByText('9,000', { exact: true }).waitFor();
      coverage.push({ route: '/purchase-records/:id', table: 'sales_orders/sales_order_items', reactDom: 'PASS', targetedRefresh: 'PASS' });
    } finally { await closeSession(session); }
  }

  // /purchasing: Batch and Item INSERT / UPDATE / DELETE visibly converge without F5.
  {
    const session = await boot('/purchasing');
    const { page } = session;
    try {
      await page.locator('.summary-card').first().click();
      const gapValue = page.locator('.detail-stat-card .stat-value').first();
      await gapValue.waitFor();
      const initialGap = Number(await gapValue.innerText());
      const expectGap = async value => page.waitForFunction(expected => Number(document.querySelector('.detail-stat-card .stat-value')?.textContent) === expected, value);

      const item = { id: 'bi-react-event', purchase_batch_id: 'b-holo', product_variant_id: 'v-holo', quantity: 1, cost: 1000, note: '', updated_at: '2026-09-07T12:00:00.000Z' };
      await page.evaluate(async row => window.__P0_REACT_HARNESS__.emitUpsert('purchase_batch_items', row, 'INSERT'), item);
      await expectGap(initialGap - 1);
      await emitPatch(page, 'purchase_batch_items', 'purchaseBatchItems', item.id, { quantity: 2 });
      await expectGap(initialGap - 2);
      await page.evaluate(id => window.__P0_REACT_HARNESS__.emitDelete('purchase_batch_items', id), item.id);
      await expectGap(initialGap);

      const orphanItem = { ...item, id: 'bi-react-header', purchase_batch_id: 'b-react-header', quantity: 2 };
      await page.evaluate(async row => window.__P0_REACT_HARNESS__.emitUpsert('purchase_batch_items', row, 'INSERT'), orphanItem);
      await expectGap(initialGap);
      const batch = { id: 'b-react-header', product_group_id: 'g-holo', name: 'Batch Insert B', date: '2026-09-07', note: '', created_at: '2026-09-07T12:00:00.000Z', updated_at: '2026-09-07T12:00:00.000Z' };
      await page.evaluate(async row => window.__P0_REACT_HARNESS__.emitUpsert('purchase_batches', row, 'INSERT'), batch);
      await expectGap(initialGap - 2);
      await emitPatch(page, 'purchase_batches', 'purchaseBatches', batch.id, { product_group_id: 'g-vspo' });
      await expectGap(initialGap);
      await emitPatch(page, 'purchase_batches', 'purchaseBatches', batch.id, { product_group_id: 'g-holo' });
      await expectGap(initialGap - 2);
      await page.evaluate(id => window.__P0_REACT_HARNESS__.emitDelete('purchase_batches', id), batch.id);
      await expectGap(initialGap);
      const result = await snap(page);
      assert.equal(result.metrics.fullPulls, 0);
      coverage.push({ route: '/purchasing', table: 'purchase_batches/purchase_batch_items INSERT UPDATE DELETE', reactDom: 'PASS', targetedRefresh: 'PASS' });
    } finally { await closeSession(session); }
  }

  // Modal draft, Focus, Visibility, Reconnect, Cancel and Close all use real UI lifecycle.
  {
    const session = await boot('/purchasing');
    const { page } = session;
    try {
      await page.locator('.summary-card').first().click();
      await page.getByRole('button', { name: '新增採購批次' }).click();
      const modal = page.locator('#purchase-batch-modal');
      const nameInput = modal.locator('input').first();
      await nameInput.fill('USER-DRAFT');
      await emitPatch(page, 'product_groups', 'productGroups', 'g-holo', { title: 'Modal Remote B', normalized_title: 'modal remote b' });
      assert.equal(await nameInput.inputValue(), 'USER-DRAFT');
      await page.evaluate(() => window.__P0_REACT_HARNESS__.focus());
      await page.evaluate(() => window.__P0_REACT_HARNESS__.visibility('hidden'));
      await page.evaluate(() => window.__P0_REACT_HARNESS__.visibility('visible'));
      await page.evaluate(() => window.__P0_REACT_HARNESS__.offline());
      await page.evaluate(() => {
        const h = window.__P0_REACT_HARNESS__;
        h.mutateServerRow('product_groups', { ...h.server.productGroups.find(row => row.id === 'g-holo'), title: 'Reconnect Remote B', normalized_title: 'reconnect remote b' });
        h.online();
      });
      assert.equal(await nameInput.inputValue(), 'USER-DRAFT');
      await modal.getByRole('button', { name: '取消' }).click();
      await waitText(page, 'reconnect remote b');
      let result = await snap(page);
      assert.ok(result.metrics.editingCatchUps >= 1);
      assert.equal(result.metrics.fullPulls, 0);
      assert.equal(result.writes, 0);

      await page.getByRole('button', { name: '新增採購批次' }).click();
      await modal.locator('input').first().fill('USER-DRAFT-CLOSE');
      await emitPatch(page, 'product_groups', 'productGroups', 'g-holo', { title: 'Close Remote B', normalized_title: 'close remote b' });
      assert.equal(await modal.locator('input').first().inputValue(), 'USER-DRAFT-CLOSE');
      await modal.locator('button').first().click();
      await waitText(page, 'close remote b');
      result = await snap(page);
      assert.ok(result.metrics.editingCatchUps >= 2);
    } finally { await closeSession(session); }
  }

  // Save success closes the actual modal and immediately catches up its pending remote change.
  {
    const session = await boot('/purchasing');
    const { page } = session;
    try {
      await page.locator('.summary-card').first().click();
      await page.getByRole('button', { name: '新增採購批次' }).click();
      const modal = page.locator('#purchase-batch-modal');
      await modal.locator('input').first().fill('USER-SAVE');
      await modal.locator('input[inputmode="numeric"]').first().fill('1');
      await emitPatch(page, 'product_groups', 'productGroups', 'g-holo', { title: 'Save Catchup Remote B', normalized_title: 'save catchup remote b' });
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await modal.waitFor({ state: 'detached' });
      await waitText(page, 'save catchup remote b');
      const result = await snap(page);
      assert.equal(result.writes, 1, 'Actual modal save did not execute one atomic Batch+Items transaction');
      assert.ok(result.metrics.editingCatchUps >= 1);
    } finally { await closeSession(session); }
  }

  // Detail editor: remote refresh never resets its draft; Cancel catches up immediately.
  {
    const session = await boot('/outbound-shipments/out-react-1');
    const { page } = session;
    try {
      await page.getByRole('button', { name: '✏️' }).click();
      const input = page.locator('input').first();
      await input.fill('DETAIL-USER-DRAFT');
      await emitPatch(page, 'outbound_shipments', 'outboundShipments', 'out-react-1', { title: 'Detail Remote Catchup B' });
      assert.equal(await input.inputValue(), 'DETAIL-USER-DRAFT');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await waitText(page, 'Detail Remote Catchup B');
      assert.ok((await snap(page)).metrics.editingCatchUps >= 1);
    } finally { await closeSession(session); }
  }

  // Inline input: commit, local echo and second save run through the real Purchase Management UI.
  {
    const session = await boot('/purchase-records/g-holo');
    const { page } = session;
    try {
      await page.getByRole('button', { name: '🔒 已鎖定' }).click();
      const input = page.getByRole('textbox', { name: 'WACA 需求 SKU-HOLO' });
      await input.fill('20');
      await input.press('Enter');
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productVariants.find(row => row.id === 'v-holo').waca_manual_adjustment === 18);
      assert.equal(await input.inputValue(), '20');

      await page.evaluate(async () => {
        const h = window.__P0_REACT_HARNESS__;
        const canonical = h.server.productVariants.find(row => row.id === 'v-holo');
        await h.emitSelfEcho('product_variants', { ...canonical, waca_manual_adjustment: 16, updated_at: new Date().toISOString() });
      });
      assert.equal(await input.inputValue(), '20', 'Self echo rolled the real input back to 18');
      await input.fill('21');
      await input.press('Enter');
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productVariants.find(row => row.id === 'v-holo').waca_manual_adjustment === 19);
      assert.equal(await input.inputValue(), '21', 'Second save failed after self echo');

      await input.fill('77');
      await emitPatch(page, 'product_variants', 'productVariants', 'v-holo', { variant_name: 'Inline Remote Pending B' });
      assert.equal(await input.inputValue(), '77');
      await page.evaluate(() => window.__P0_REACT_HARNESS__.focus());
      assert.equal(await input.inputValue(), '77');
      await page.getByRole('button', { name: '✏️ 編輯中' }).click();
      await waitText(page, 'Inline Remote Pending B');
      const result = await snap(page);
      assert.ok(result.metrics.editingCatchUps >= 1);
      assert.equal(result.metrics.fullPulls, 0);
    } finally { await closeSession(session); }
  }

  // Duplicate events enter the actual mounted context once and coalesce to one refresh.
  {
    const session = await boot('/dashboard');
    const { page } = session;
    try {
      const before = await snap(page);
      await page.evaluate(async () => {
        const h = window.__P0_REACT_HARNESS__;
        const row = { ...h.server.productGroups.find(item => item.id === 'g-c108'), title: 'Duplicate Remote B', updated_at: new Date().toISOString() };
        await h.emitDuplicate('product_groups', row);
      });
      await waitText(page, 'Duplicate Remote B');
      const after = await snap(page);
      assert.equal(after.metrics.targetedRefreshes - before.metrics.targetedRefreshes, 1);
      assert.ok(after.metrics.dedupedEvents > before.metrics.dedupedEvents);
    } finally { await closeSession(session); }
  }

  assert.equal(supabaseRequests.length, 0, 'React acceptance harness contacted Supabase');
  assert.equal(consoleErrors.length, 0, `React acceptance harness console errors:\n${consoleErrors.join('\n')}`);
  assert.ok(coverage.some(entry => entry.route === '/dashboard'));
  assert.ok(coverage.some(entry => entry.route === '/purchasing'));

  console.log('PASS Dashboard actual React Realtime and freshness states');
  console.log('PASS /purchasing Batch + Item INSERT UPDATE DELETE actual DOM convergence');
  console.log('PASS page-level Realtime coverage across primary list/detail consumers');
  console.log('PASS Modal and detail Draft protection with Save/Cancel/Close catch-up');
  console.log('PASS Visibility, Focus and reconnect preserve Draft and catch up at edit end');
  console.log('PASS inline commit, self echo and second save actual React flow');
  console.log('PASS duplicate event dedupe and fullPulls = 0');
  console.log(`PASS coverage=${JSON.stringify(coverage)}`);
  console.log('PASS fixture Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
