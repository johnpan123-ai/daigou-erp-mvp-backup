import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4396';
const downloads = process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Downloads') : '';
const sourceNames = ['399375_2026-09-11.xls', '399375_2026-09-23 (1).xls', '399375_2026-09-27 (1).xls'];
if (!downloads || [...sourceNames, 'waca資料.xlsx', 'cloud-erp-snapshot-2026-09-26-162318.json']
  .some(name => !existsSync(join(downloads, name)))) {
  console.log('SKIP real WACA closure UI: source workbooks or ERP snapshot unavailable');
  process.exit(0);
}
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'next', '--host', '127.0.0.1',
  '--port', '4396', '--strictPort', '--configLoader', 'runner'],
{ env: { ...process.env, VITE_DEPLOYMENT_ENV: 'next' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (attempt === 79 || server.exitCode !== null) throw new Error(serverOutput);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW' });
  await context.addInitScript(() => {
    window.__wacaPerf = { transactions: 0, writes: 0, reactCommits: 0 };
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function countedTransaction(stores, mode, options) {
      window.__wacaPerf.transactions += 1;
      if (mode === 'readwrite') window.__wacaPerf.writes += 1;
      return originalTransaction.call(this, stores, mode, options);
    };
    const renderers = new Map();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers,
      inject(renderer) { const id = renderers.size + 1; renderers.set(id, renderer); return id; },
      onCommitFiberRoot() { window.__wacaPerf.reactCommits += 1; },
      onCommitFiberUnmount() {},
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/waca`);
  await page.waitForFunction(() => Boolean(window.db));
  const erp = JSON.parse(readFileSync(join(downloads, 'cloud-erp-snapshot-2026-09-26-162318.json'), 'utf8')).data;
  const seed = { ...Object.fromEntries(['inventory', 'salesOrders', 'salesOrderItems', 'productGroups',
    'productCategories', 'productVariants', 'purchaseBatches', 'purchaseBatchItems', 'privateOrders',
    'privateOrderItems', 'japanPackages', 'japanPackageItems', 'outboundShipments',
    'outboundShipmentItems', 'bundleComponents', 'importBatches'].map(key => [key, []])),
  productGroups: erp.productGroups, productVariants: erp.productVariants };
  assert.equal(await page.evaluate(async value => window.db.importData(JSON.stringify(value)), seed), true);
  await page.reload();
  await page.getByRole('heading', { name: 'WACA 匯入' }).waitFor();
  const navigation = page.locator('.sidebar-nav-container > a.nav-item');
  assert.deepEqual(await navigation.locator('.nav-label').allTextContents(),
    ['主頁', '買動漫匯入', 'WACA 匯入', '訂購紀錄表', '近期採購', '採購總表',
      '日本包裹管理', '出庫管理', '待下架商品', '重複品項管理', '設定']);
  assert.deepEqual(await navigation.evaluateAll(links => links.map(link => link.getAttribute('href'))),
    ['/dashboard', '/inventory', '/waca', '/purchase-records', '/recent-purchases', '/purchasing',
      '/japan-packages', '/outbound-shipments', '/unlisted-items', '/duplicate-variants', '/settings']);
  assert.match(await page.getByRole('link', { name: 'WACA 匯入' }).getAttribute('class'), /active/);
  await page.goto(`${origin}/inventory`);
  await page.getByRole('heading', { name: '買動漫匯入' }).waitFor();
  assert.match(await page.getByRole('link', { name: '買動漫匯入' }).getAttribute('class'), /active/);
  await page.goto(`${origin}/purchase-records`);
  await page.getByRole('heading', { name: '訂購紀錄表' }).waitFor();
  assert.match(await page.getByRole('link', { name: '訂購紀錄表' }).getAttribute('class'), /active/);
  await page.goto(`${origin}/waca`);
  await page.getByRole('heading', { name: 'WACA 匯入' }).waitFor();
  assert.match(await page.getByRole('link', { name: 'WACA 匯入' }).getAttribute('class'), /active/);
  await page.getByText('進階／維護工具').click();

  for (const sourceName of sourceNames) {
    await page.getByLabel('選擇買動漫商品匯出檔').setInputFiles(join(downloads, sourceName));
    await page.getByText(new RegExp(sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).first().waitFor();
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認保存對照' }).click()]);
    await page.getByText(/已保存 .* 筆買動漫/).waitFor();
  }
  await page.getByLabel('選擇 WACA Excel').setInputFiles(join(downloads, 'waca資料.xlsx'));
  await page.getByRole('heading', { name: '匯入預覽：waca資料.xlsx' }).waitFor();
  const preview = await page.getByLabel('WACA 匯入預覽摘要').innerText();
  assert.match(preview, /60\s+商品規格/);
  assert.match(preview, /60\s+已配對/);
  assert.match(preview, /0\s+待處理/);
  assert.match(preview, /12\s+折扣忽略/);
  assert.match(preview, /111\s+有效數量/);
  assert.equal(await page.locator('.waca-group-list details[open]').count(), 0);
  assert.equal(await page.locator('.waca-trace-row').count(), 0, 'large preview order traces stay unrendered while collapsed');
  assert.ok(await page.locator('.waca-group').count() > 0, 'first rebaseline must show ledger changes for ERP1 comparison');
  assert.equal(await page.getByLabel('顯示未變更商品').isChecked(), false);
  assert.equal(await page.locator('.waca-group > .waca-scroll > table > tbody > tr > td:nth-child(4)').evaluateAll(
    cells => cells.some(cell => cell.textContent.trim() === '0')), true,
  'ERP1-equal rows stay visible when the underlying ledger is changing from 0 to the imported quantity');
  const multiSkuGroup = page.locator('.waca-group').filter({ hasText: 'RAISE A SUILEN' }).first();
  await multiSkuGroup.locator('summary').click();
  await page.evaluate(() => { window.__wacaPerf.transactions = 0; window.__wacaPerf.writes = 0; });
  await multiSkuGroup.locator('.waca-detail-toggle').first().click();
  assert.equal(await multiSkuGroup.locator('.waca-trace-row').count(), 1, 'only the selected Variant trace renders');
  assert.deepEqual(await page.evaluate(() => ({ transactions: window.__wacaPerf.transactions, writes: window.__wacaPerf.writes })),
    { transactions: 0, writes: 0 }, 'expanding order trace must reuse preview memory without provider reads or writes');
  await multiSkuGroup.locator('.waca-detail-toggle').first().click();
  assert.equal(await multiSkuGroup.locator('.waca-trace-row').count(), 0);
  const skus = (await multiSkuGroup.locator('tbody td small:first-of-type').allTextContents()).map(value => value.replace('SKU ', ''));
  assert.deepEqual(skus, [...skus].sort(new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare));
  const previewTitles = await page.locator('.waca-group summary strong').allTextContents();
  assert.equal(previewTitles.some(title => /【小河馬日本代購】|預購\s*\d{2}年\d{1,2}月/u.test(title)), false);
  const canonical = erp.productGroups.find(group => (group.normalized_title || group.title)
    === 'Hololive 綺々羅々ヴィヴィ 誕生日記念2026');
  assert.ok(canonical);
  assert.ok(previewTitles.includes(canonical.normalized_title || canonical.title));
  assert.match((await page.locator('.waca-resolution-details').textContent()).slice(0, 300), /原始 WACA：預購 27年/);
  for (const width of [1366, 1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      `WACA preview overflows at ${width}px`);
  }
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認更新' }).click()]);
  await page.getByText(/WACA 更新完成：60 \/ 60/).waitFor().catch(async error => {
    console.log('WACA CONFIRM SCREEN', (await page.locator('main').innerText()).slice(0, 2500));
    throw error;
  });
  assert.match(await page.locator('[aria-label="WACA 目前驗收摘要"]').innerText(), /60\s+已配對特徵/);
  const measureTab = label => page.evaluate(async tabLabel => {
    const button = [...document.querySelectorAll('.waca-tabs button')].find(row => row.textContent.trim() === tabLabel);
    if (!button) throw new Error(`Missing WACA tab ${tabLabel}`);
    window.__wacaPerf.transactions = 0;
    window.__wacaPerf.writes = 0;
    window.__wacaPerf.reactCommits = 0;
    const start = performance.now();
    button.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
    await new Promise(resolve => setTimeout(resolve, 50));
    return { tab: tabLabel, elapsedMs,
      reads: window.__wacaPerf.transactions - window.__wacaPerf.writes,
      writes: window.__wacaPerf.writes, reactCommits: window.__wacaPerf.reactCommits };
  }, label);
  const firstTabMetrics = [];
  const repeatTabMetrics = [];
  for (const label of ['來源訂單', '商品對照', '匯入紀錄', '待處理 0', 'WACA 匯入']) firstTabMetrics.push(await measureTab(label));
  for (const label of ['來源訂單', '商品對照', '匯入紀錄', '待處理 0', 'WACA 匯入']) repeatTabMetrics.push(await measureTab(label));
  for (const metric of [...firstTabMetrics, ...repeatTabMetrics]) {
    assert.equal(metric.reads, 0, `${metric.tab} must reuse the loaded WACA read model`);
    assert.equal(metric.writes, 0, `${metric.tab} must not perform a business write`);
    assert.equal(metric.reactCommits, 1, `${metric.tab} should commit only the tab change`);
  }
  for (const metric of repeatTabMetrics) {
    assert.ok(metric.elapsedMs < 100, `${metric.tab} repeat tab switch took ${metric.elapsedMs}ms`);
  }
  console.log('WACA TAB PERF', JSON.stringify({ firstTabMetrics, repeatTabMetrics }));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  for (const label of ['來源訂單', '商品對照', '匯入紀錄', '待處理 0', 'WACA 匯入']) await measureTab(label);
  const coverage = await cdp.send('Profiler.takePreciseCoverage');
  await cdp.send('Profiler.stopPreciseCoverage');
  await cdp.detach();
  assert.ok(coverage.result.length > 0, 'V8 function coverage must be active during tab switches');
  const coreCalls = Object.fromEntries(['parseWacaWorkbook', 'importWacaRows', 'matchWacaItem',
    'recomputeWacaQuantities', 'reconcileWacaReadback'].map(name => {
    const functions = coverage.result.flatMap(script => script.functions).filter(fn => fn.functionName === name);
    return [name, functions.reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0)];
  }));
  assert.deepEqual(Object.values(coreCalls), [0, 0, 0, 0, 0], 'tab changes must not rerun WACA business calculations');
  console.log('WACA TAB CORE CALLS', JSON.stringify(coreCalls));
  await page.getByRole('button', { name: '商品對照' }).click();
  const mappingOptions = await page.locator('.waca-panel select option').allTextContents();
  assert.equal(mappingOptions.some(title => title.includes('【小河馬日本代購】') || /預購\s*27年/u.test(title)), false);
  await page.getByRole('button', { name: 'WACA 匯入' }).click();
  const quantityBefore = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  const quantityMapBefore = new Map(quantityBefore.map(row => [row.id, row.waca_auto_quantity ?? 0]));

  await page.getByLabel('選擇 WACA Excel').setInputFiles(join(downloads, 'waca資料.xlsx'));
  await page.getByRole('heading', { name: '匯入預覽：waca資料.xlsx' }).waitFor();
  assert.match(await page.locator('.waca-equation').innerText(), /未變更 115/);
  assert.equal(await page.locator('.waca-group').count(), 0, 'zero-change groups are hidden by default');
  await page.getByLabel('顯示未變更商品').check();
  assert.ok(await page.locator('.waca-group').count() > 0, 'unchanged toggle reveals audit detail');
  await page.getByLabel('顯示未變更商品').uncheck();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認更新' }).click()]);
  const backup = JSON.parse(readFileSync(await download.path(), 'utf8'));
  assert.equal(backup.wacaOrders.length, 71);
  assert.equal(backup.wacaItems.length, 115);
  assert.equal(backup.wacaMappings.length, 60);
  assert.equal(backup.myacgMasterLinks.length, 1267);
  assert.equal(backup.wacaImportBatches.length, 1);
  assert.equal(backup.wacaCutoverAudit.length, erp.productVariants.length);
  assert.equal(backup.wacaImportBatches[0].reconciliation.status, 'PASS');
  assert.equal(backup.productVariants.filter(row => Number(row.waca_manual_adjustment ?? 0) !== 0).length, 0);
  assert.equal(backup.productVariants.length, erp.productVariants.length, 'NEXT JSON export must retain raw variants');
  const workbenchBackup = await page.evaluate(async () => {
    const { collectWorkbenchBackupData } = await import('/src/lib/workbenchJsonBackup.ts');
    return collectWorkbenchBackupData(window.dataProvider);
  });
  assert.equal(workbenchBackup.productVariants.length, erp.productVariants.length);
  assert.equal(workbenchBackup.myacgMasterLinks.length, 1267);
  assert.equal(workbenchBackup.wacaCutoverAudit.length, erp.productVariants.length);
  const quantityAfter = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.deepEqual(new Map(quantityAfter.map(row => [row.id, row.waca_auto_quantity ?? 0])), quantityMapBefore);

  const restoredContext = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW' });
  const restored = await restoredContext.newPage();
  await restored.goto(`${origin}/waca`);
  await restored.waitForFunction(() => Boolean(window.db));
  assert.equal(await restored.evaluate(async value => window.db.importData(JSON.stringify(value)), backup), true);
  await restored.reload();
  await restored.getByRole('heading', { name: 'WACA 匯入' }).waitFor();
  await restored.waitForFunction(() => document.querySelector('[aria-label="WACA 目前驗收摘要"] strong')?.textContent === '60');
  assert.match(await restored.locator('[aria-label="WACA 目前驗收摘要"]').innerText(), /60\s+已配對特徵/);
  const restoredVariants = await restored.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.deepEqual(new Map(restoredVariants.map(row => [row.id, row.waca_auto_quantity ?? 0])), quantityMapBefore);
  await restored.getByLabel('選擇 WACA Excel').setInputFiles(join(downloads, 'waca資料.xlsx'));
  await restored.getByRole('heading', { name: '匯入預覽：waca資料.xlsx' }).waitFor();
  assert.match(await restored.locator('.waca-equation').innerText(), /未變更 115/);
  assert.deepEqual(errors, []);
  await restoredContext.close();
  await context.close();
  console.log('PASS real XLS UI: 3 MyACG sources, 60/60 features, 115/115 rows, repeat import, export, isolated restore, quantity parity');
} finally {
  if (browser) await browser.close();
  server.kill();
}
