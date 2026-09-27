import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const origin = 'http://127.0.0.1:4395';
const vite = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', '--mode', 'next', '--host', '127.0.0.1',
  '--port', '4395', '--strictPort', '--configLoader', 'runner',
], { env: { ...process.env, VITE_DEPLOYMENT_ENV: 'next' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
vite.stdout.on('data', chunk => { serverOutput += chunk; });
vite.stderr.on('data', chunk => { serverOutput += chunk; });
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (attempt === 79 || vite.exitCode !== null) throw new Error(serverOutput);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({
    executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });
  const seed = Object.fromEntries([
    'inventory', 'salesOrders', 'salesOrderItems', 'productGroups', 'productCategories',
    'productVariants', 'purchaseBatches', 'purchaseBatchItems', 'privateOrders',
    'privateOrderItems', 'japanPackages', 'japanPackageItems', 'outboundShipments',
    'outboundShipmentItems', 'bundleComponents', 'importBatches',
  ].map(key => [key, []]));
  seed.productGroups.push({
    id: 'group-a', title: 'Product', purchase_date: '', priority: 'Low', closing_date: '',
    release_month: '', has_official_site: false, product_url: '', created_at: '', updated_at: '',
  });
  seed.productVariants.push({
    id: 'variant-a', product_group_id: 'group-a', myacg_item_code: 'G-RED',
    product_title: 'Product', variant_name: 'Red', raw_variant_name: 'Red', note: '',
    sort_order: 0, waca_auto_quantity: 0, waca_manual_adjustment: 4,
  });
  seed.inventory.push({
    myacg_item_code: 'G-RED', product_title: 'Product', raw_variant_name: 'Red',
    listing_type: '', final_price: 100, myacg_sold_quantity: 0,
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, locale: 'zh-TW' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/waca`);
  await page.waitForFunction(() => Boolean(window.db));
  assert.equal(await page.evaluate(async value => window.db.importData(JSON.stringify(value)), seed), true);
  await page.reload();
  await page.getByRole('heading', { name: 'WACA 訂單整合' }).waitFor();
  await page.getByRole('link', { name: 'WACA 訂單整合' }).waitFor();
  assert.match(await page.locator('body').innerText(), /NEXT SANDBOX/);

  const myacgHtml = '<table><tr><th>主編號(多規格編號)</th><th>子編號(商品編號)</th><th>商品名稱</th><th>規格/項目</th></tr><tr><td>GP-A</td><td>G-RED</td><td>Product</td><td>Red</td></tr></table>';
  await page.getByLabel('選擇買動漫商品匯出檔').setInputFiles({
    name: 'myacg-source.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(myacgHtml),
  });
  await page.getByText(/可保存 1 筆/).waitFor();
  const [firstBackup] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '確認保存對照' }).click(),
  ]);
  assert.ok(firstBackup.suggestedFilename().endsWith('.json'));
  await page.getByText(/已保存 1 筆買動漫/).waitFor();

  const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一',
    '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
  const wacaBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wacaBook, XLSX.utils.aoa_to_sheet([
    headers.map(() => '訂單資訊'), headers,
    ['處理中', 'A-001', '2026-09-28', 'GP-A', 'Product', 'Red', '', '', 2, 200],
  ]), 'WACA');
  const wacaBytes = XLSX.write(wacaBook, { type: 'buffer', bookType: 'xlsx' });
  const upload = async () => {
    await page.getByLabel('選擇 WACA Excel').setInputFiles({
      name: 'waca-sample.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: wacaBytes,
    });
    await page.getByRole('heading', { name: '匯入預覽：waca-sample.xlsx' }).waitFor();
  };
  await upload();
  assert.match(await page.locator('.waca-equation').innerText(), /有效商品數量 2 = 已配對 2 \+ 待處理 0/);
  assert.match(await page.locator('.waca-scroll').last().innerText(), /G-RED/);
  const [preImportBackup] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '確認匯入' }).click(),
  ]);
  assert.ok(preImportBackup.suggestedFilename().endsWith('.json'));
  await page.getByText(/匯入完成：新增 1/).waitFor();
  let variants = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.equal(variants.find(item => item.id === 'variant-a').waca_auto_quantity, 2);
  assert.equal(variants.find(item => item.id === 'variant-a').waca_manual_adjustment, 4);
  await page.goto(`${origin}/purchase-records`);
  const purchaseRow = page.getByRole('row').filter({ hasText: 'Product' }).first();
  await purchaseRow.waitFor();
  assert.match(await purchaseRow.innerText(), /\b6\b/, 'purchase record must show WACA auto 2 + manual 4');
  await page.goto(`${origin}/waca`);
  await page.getByRole('heading', { name: 'WACA 訂單整合' }).waitFor();

  await upload();
  assert.match(await page.locator('.waca-metrics').last().innerText(), /未變更\s+1/);
  const [repeatBackup] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '確認匯入' }).click(),
  ]);
  const backup = JSON.parse(readFileSync(await repeatBackup.path(), 'utf8'));
  assert.equal(backup.wacaOrders.length, 1);
  assert.equal(backup.wacaItems.length, 1);
  assert.equal(backup.wacaMappings.length, 1);
  assert.equal(backup.myacgMasterLinks.length, 1);
  assert.equal(backup.productVariants[0].waca_auto_quantity, 2);
  const workbenchBackup = await page.evaluate(async () => {
    const { collectWorkbenchBackupData } = await import('/src/lib/workbenchJsonBackup.ts');
    return collectWorkbenchBackupData(window.dataProvider);
  });
  assert.equal(workbenchBackup.wacaOrders.length, 1);
  assert.equal(workbenchBackup.wacaItems.length, 1);
  assert.equal(workbenchBackup.wacaMappings.length, 1);
  assert.equal(workbenchBackup.myacgMasterLinks.length, 1);
  variants = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.equal(variants.find(item => item.id === 'variant-a').waca_auto_quantity, 2);

  const restoredContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, locale: 'zh-TW' });
  const restored = await restoredContext.newPage();
  await restored.goto(`${origin}/waca`);
  await restored.waitForFunction(() => Boolean(window.db));
  assert.equal(await restored.evaluate(async value => window.db.importData(JSON.stringify(value)), backup), true);
  await restored.reload();
  await restored.getByRole('button', { name: '匯入紀錄' }).click();
  assert.match(await restored.locator('.waca-panel').innerText(), /waca-sample.xlsx/);
  const restoredVariants = await restored.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.equal(restoredVariants.find(item => item.id === 'variant-a').waca_auto_quantity, 2);
  assert.equal(restoredVariants.find(item => item.id === 'variant-a').waca_manual_adjustment, 4);
  assert.equal((await restored.evaluate(() => window.db.getProductGroups())).length, 1);
  assert.equal((await restored.evaluate(() => window.db.getInventory())).length, 1);
  const restoredWaca = await restored.evaluate(async () => (await import('/src/waca/nextStorage.ts')).readNextWacaSnapshot());
  assert.equal(restoredWaca.orders[0].status, '處理中');
  assert.equal(restoredWaca.mappings[0].productVariantId, 'variant-a');
  assert.equal(new Set(restoredWaca.items.map(item => item.key)).size, restoredWaca.items.length);

  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    window.__restoreWacaPut = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function injected(value, key) {
      if (key === 'erp_waca_items_v1') throw new Error('INJECTED_WACA_WRITE_FAILURE');
      return original.call(this, value, key);
    };
  });
  const changedBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(changedBook, XLSX.utils.aoa_to_sheet([
    headers.map(() => '訂單資訊'), headers,
    ['處理中', 'A-001', '2026-09-28', 'GP-A', 'Product', 'Red', '', '', 3, 300],
  ]), 'WACA');
  await page.getByLabel('選擇 WACA Excel').setInputFiles({
    name: 'changed.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(changedBook, { type: 'buffer', bookType: 'xlsx' }),
  });
  await page.getByRole('heading', { name: '匯入預覽：changed.xlsx' }).waitFor();
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認匯入' }).click()]);
  await page.getByText(/INJECTED_WACA_WRITE_FAILURE/).waitFor();
  await page.evaluate(() => window.__restoreWacaPut());
  variants = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.equal(variants.find(item => item.id === 'variant-a').waca_auto_quantity, 2);
  const afterFailure = await page.evaluate(async () => (await import('/src/waca/nextStorage.ts')).readNextWacaSnapshot());
  assert.equal(afterFailure.items[0].quantity, 2);

  const concurrent = await context.newPage();
  await concurrent.goto(`${origin}/waca`);
  await concurrent.getByRole('heading', { name: 'WACA 訂單整合' }).waitFor();
  await concurrent.getByLabel('選擇 WACA Excel').setInputFiles({
    name: 'concurrent.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(changedBook, { type: 'buffer', bookType: 'xlsx' }),
  });
  await concurrent.getByRole('heading', { name: '匯入預覽：concurrent.xlsx' }).waitFor();
  await Promise.all([concurrent.waitForEvent('download'), concurrent.getByRole('button', { name: '確認匯入' }).click()]);
  await concurrent.getByText(/匯入完成：新增 0、更新 1/).waitFor();
  await page.getByRole('button', { name: '確認匯入' }).click();
  await page.getByText(/WACA 資料已變更，請重新預覽檔案/).waitFor();
  await page.getByRole('button', { name: '重新讀取' }).click();
  await page.getByRole('button', { name: '來源訂單' }).click();
  assert.match(await page.locator('.waca-panel').innerText(), /A-001/);
  variants = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.equal(variants.find(item => item.id === 'variant-a').waca_auto_quantity, 3);
  assert.equal(variants.find(item => item.id === 'variant-a').waca_manual_adjustment, 4);
  await page.getByRole('button', { name: '商品對照' }).click();
  assert.match(await page.locator('.waca-panel').innerText(), /G-RED/);
  await page.getByRole('button', { name: '匯入紀錄' }).click();
  assert.match(await page.locator('.waca-panel').innerText(), /concurrent.xlsx/);
  await page.getByRole('button', { name: /待處理/ }).click();
  await page.locator('.waca-panel').waitFor();
  await page.getByRole('button', { name: 'WACA 匯入' }).click();

  for (const width of [1366, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `WACA page overflow at ${width}`);
  }
  assert.deepEqual(pageErrors, []);
  await concurrent.close();
  await restoredContext.close();
  await context.close();
  console.log('PASS NEXT WACA UI, all tabs, 1366/1280/390 geometry, dry run, idempotency, JSON backup/restore, rollback, multi-tab CAS and manual refresh');
} finally {
  if (browser) await browser.close();
  vite.kill();
}
