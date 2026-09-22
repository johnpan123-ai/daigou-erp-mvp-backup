import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4268';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4268', '--strictPort'], { stdio: 'pipe' });
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
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on('dialog', dialog => dialog.type() === 'confirm' && dialog.message().startsWith('鎖定將放棄') ? dialog.accept() : dialog.dismiss());
  const liveRequests = [];
  await page.route('**/*.supabase.co/**', route => { liveRequests.push(route.request().url()); return route.abort(); });
  await page.goto(`${origin}/tests/fixtures/cloud-p0-2-react-harness.html?route=/purchase-records/g-holo`);
  await page.getByText('代購工作規格表', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: '🔒 已鎖定' }).click();
  const draft = page.getByRole('textbox', { name: 'WACA 需求 SKU-HOLO' });
  await draft.fill('27');
  // Real purchase item has no direct product_group_id. Its parent batch belongs to B.
  await page.evaluate(async () => {
    const h = window.__P0_REACT_HARNESS__;
    await h.emitUpsert('purchase_batches', { id: 'batch-unrelated', product_group_id: 'g-closed', name: 'Client B', date: '2026-09-22' });
    await h.emitUpsert('purchase_batch_items', { id: 'item-unrelated', purchase_batch_id: 'batch-unrelated', product_variant_id: 'v-closed', quantity: 2, cost: 10, note: 'Client B changed', version: 2 });
  });
  assert.equal(await page.getByRole('alert').filter({ hasText: '資料已被其他使用者更新' }).count(), 0, 'purchase item in B must not conflict with group A draft');
  assert.equal(await draft.inputValue(), '27');
  assert.equal(await page.evaluate(async () => (await import('/src/providers/dataProvider.ts')).dataProvider.checkIsStaleLive()), false, 'A save must remain unblocked');
  const unrelated = [
    ['private_order_items', { id: 'poi-other', private_order_id: 'po-closed', product_variant_id: 'v-closed', quantity: 2, amount: 20 }],
    ['product_variants', { id: 'category-only-other', product_group_id: null, product_category_id: 'c-closed', variant_name: 'B via category', myacg_item_code: 'B-CAT' }],
    ['inventory_items', { id: 'inv-b', inventory_key: 'inv-b', myacg_item_code: 'SKU-CLOSED', myacg_sold_quantity: 4 }],
    ['bundle_components', { id: 'bundle-b', bundle_variant_id: 'v-closed', component_variant_id: 'v-c108' }],
    ['sales_order_items', { id: 'soi-b', order_id: 'so-b', product_variant_id: 'v-closed', quantity: 4, amount: 20 }],
  ];
  for (const [table, row] of unrelated) {
    await page.evaluate(([table, row]) => window.__P0_REACT_HARNESS__.emitUpsert(table, row), [table, row]);
    assert.equal(await page.getByRole('alert').count(), 0, `${table}: unrelated relation must not conflict`);
    assert.equal(await draft.inputValue(), '27');
  }
  // Pause a real boundary targeted read: fresh A must stay writable while B loads.
  await page.evaluate(() => {
    const h = window.__P0_REACT_HARNESS__;
    h.holdNextTargetedRead();
    window.fixturePendingRead = h.emitUpsert('product_groups', { ...h.server.productGroups.find(r => r.id === 'g-closed'), title: 'B while A edits' });
  });
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().targetedReadHeld);
  const duringRead = await page.evaluate(async () => {
    const c = await import('/src/providers/cloud/cloudConnectivity.ts');
    c.assertCloudWriteAllowed();
    return c.getCloudConnectivitySnapshot().readStatus;
  });
  assert.equal(duringRead, 'fresh-online', 'background query must not globally revoke A readiness');
  await page.evaluate(async () => { window.__P0_REACT_HARNESS__.releaseTargetedRead(); await window.fixturePendingRead; });
  await page.evaluate(async () => {
    const h = window.__P0_REACT_HARNESS__;
    window.dispatchEvent(new Event('cloud-cross-tab-change'));
    await h.fallback('reconnect', ['products', 'purchases', 'privateOrders', 'inventory', 'bundles', 'salesOrders']);
    h.focus(); h.visibility('visible');
  });
  assert.equal(await page.getByRole('alert').count(), 0, 'focus/reconnect/cross-tab marker must not invent conflict');
  await draft.press('Enter');
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productVariants.find(r => r.id === 'v-holo').waca_manual_adjustment === 25);
  await draft.fill('28');
  await draft.press('Enter');
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productVariants.find(r => r.id === 'v-holo').waca_manual_adjustment === 26);
  await draft.fill('77');
  await page.evaluate(async () => {
    const h = window.__P0_REACT_HARNESS__;
    const row = h.server.productVariants.find(r => r.id === 'v-holo');
    await h.emitUpsert('product_variants', { ...row, version: 12, updated_by: 'same-owner', updated_at: new Date().toISOString() });
    await h.emitSelfEcho('product_variants', h.server.productVariants.find(r => r.id === 'v-holo'));
    await h.emitDuplicate('product_variants', h.server.productVariants.find(r => r.id === 'v-holo'));
  });
  assert.equal(await page.getByRole('alert').count(), 0, 'metadata/self echo/duplicate must remain quiet');
  assert.equal(await draft.inputValue(), '77');
  await page.evaluate(async () => {
    const h = window.__P0_REACT_HARNESS__;
    await h.emitUpsert('product_variants', { ...h.server.productVariants.find(r => r.id === 'v-holo'), variant_name: 'Same-owner true conflict', version: 13, updated_by: 'same-owner' });
  });
  assert.equal(await page.getByRole('alert').filter({ hasText: '資料已被其他使用者更新' }).count(), 1);
  assert.equal(await draft.inputValue(), '77');
  const baseline = await page.evaluate(async () => {
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    return (await cloudCacheDb.getProductVariants()).find(r => r.id === 'v-holo');
  });
  assert.equal(baseline.version, 12, 'real conflict must keep original CAS baseline');
  await draft.press('Enter');
  assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.server.productVariants.find(r => r.id === 'v-holo').waca_manual_adjustment), 26, 'stale save must not write 77');
  await page.getByRole('button', { name: '✏️ 編輯中' }).click();
  await page.getByText('Same-owner true conflict', { exact: false }).first().waitFor();
  await page.evaluate(async () => {
    const h = window.__P0_REACT_HARNESS__;
    await h.emitUpsert('product_variants', { ...h.server.productVariants.find(r => r.id === 'v-holo'), variant_name: 'Same-owner auto converged', version: 14, updated_by: 'same-owner' });
  });
  await page.getByText('Same-owner auto converged', { exact: false }).first().waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  // An unresolved purchase parent remains protected, but an unrelated resource
  // cannot implicate a shipment editor simply because its relation is unknown.
  const unknown = await page.evaluate(async () => {
    const m = await import('/src/providers/cloud/cloudDraftScope.ts');
    const relations = await m.readCloudDraftRelations();
    const row = { id: 'unresolved', purchase_batch_id: 'not-in-cache' };
    return {
      group: m.cloudRowAffectsDraft({ kind: 'groups', ids: ['g-holo'] }, 'purchase_batch_items', undefined, row, relations),
      shipment: m.cloudRowAffectsDraft({ kind: 'shipment', ids: ['out-react-1'] }, 'purchase_batch_items', undefined, row, relations),
    };
  });
  assert.deepEqual(unknown, { group: true, shipment: false });
  console.log('PASS purchase-management A draft / B batch-item: no conflict, draft and save readiness preserved');
  console.log('PASS category/parent/SKU/bundle/order resolution, metadata CAS, genuine conflict, stale save, second save, focus/reconnect, unknown relation scoped');

  // Real AppLayout at desktop and mobile widths, without a page reload.
  const assertLayout = async label => {
    const geometry = await page.evaluate(() => {
      const rect = selector => {
        const e = document.querySelector(selector); const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height, clientHeight: e.clientHeight, scrollHeight: e.scrollHeight };
      };
      return { viewport: innerHeight, body: document.documentElement.scrollHeight, frame: rect('.cloud-runtime-frame'), bar: rect('.environment-status-bar'), main: rect('.main-area'), header: rect('.app-header'), stack: rect('.cloud-status-stack') };
    });
    assert.ok(geometry.main.top >= geometry.bar.bottom - 1, `${label}: bar must not cover main area`);
    assert.ok(geometry.bar.top >= geometry.stack.bottom - 1, `${label}: status notices must not overlap environment bar`);
    assert.ok(geometry.main.bottom <= geometry.viewport + 1, `${label}: main must fit below reserved bar`);
    assert.ok(geometry.body <= geometry.viewport + 1, `${label}: no second document scroller`);
    return geometry;
  };
  for (const width of [1366, 1280, 390]) {
    await page.setViewportSize({ width, height: 768 });
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/dashboard'));
    await page.getByRole('heading', { name: '每日工作待辦' }).waitFor();
    const initial = await assertLayout(`${width} route`);
    await page.locator('.main-area').evaluate(e => { e.scrollTop = 350; });
    const scrolled = await assertLayout(`${width} scroll`);
    assert.equal(scrolled.bar.top, initial.bar.top, 'scroll must not move fixed status row');
    if (width < 768) assert.ok(scrolled.header.top >= scrolled.bar.bottom - 1, 'mobile sticky header must sit below bar');
    await page.evaluate(() => window.__P0_REACT_HARNESS__.offline());
    await page.getByRole('status').filter({ hasText: 'Offline' }).waitFor();
    await assertLayout(`${width} offline status`);
    await page.evaluate(() => window.__P0_REACT_HARNESS__.online());
    await page.getByRole('status').filter({ hasText: 'Offline' }).waitFor({ state: 'hidden' });
    const recovered = await assertLayout(`${width} recovered`);
    assert.equal(recovered.main.height, initial.main.height, 'status hide must restore exact height');
    await page.locator('.environment-status-bar').evaluate(e => { e.style.display = 'none'; });
    const hidden = await assertLayout(`${width} hidden environment`);
    assert.ok(hidden.main.height > recovered.main.height, 'no phantom environment spacer');
    await page.locator('.environment-status-bar').evaluate(e => { e.style.removeProperty('display'); });
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/outbound-shipments'));
    await page.getByRole('heading', { name: '出庫管理', exact: true }).waitFor();
    await assertLayout(`${width} route changed`);
    await page.screenshot({ path: `scratch/realtime-layout-${width}.png` });
  }
  console.log('PASS real AppLayout: 1366/1280/390, scroll, route change, status show/hide, no overlay/phantom height/document overflow');
  const relationFailure = await page.evaluate(async () => {
    const { CloudTargetedCache } = await import('/src/providers/cloud/cloudTargetedCache.ts');
    const c = await import('/src/providers/cloud/cloudConnectivity.ts');
    let queried = false;
    const cache = new CloudTargetedCache({
      prepareDraftProtection: async () => { throw Error('FIXTURE_RELATION_CACHE_FAILURE'); },
      query: async () => { queried = true; return []; },
    });
    let rejected = false;
    try { await cache.refreshWithResult({ reason: 'focus', resources: ['products'], changes: [] }); }
    catch { rejected = true; }
    let writeBlocked = false;
    try { c.assertCloudWriteAllowed(); } catch { writeBlocked = true; }
    return { rejected, queried, writeBlocked, fullPulls: window.__P0_REACT_HARNESS__.snapshot().metrics.fullPulls };
  });
  assert.deepEqual(relationFailure, { rejected: true, queried: false, writeBlocked: true, fullPulls: 0 });
  console.log('PASS relation read failure stays fail-closed; fullPulls=0, Live requests=0');
  assert.equal(liveRequests.length, 0);
} finally {
  await browser?.close();
  vite.kill();
}
