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
  await page.getByRole('heading', { name: 'WACA 訂單整合' }).waitFor();

  for (const sourceName of sourceNames) {
    await page.getByLabel('選擇買動漫商品匯出檔').setInputFiles(join(downloads, sourceName));
    await page.getByText(new RegExp(sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).first().waitFor();
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認保存對照' }).click()]);
    await page.getByText(/已保存 .* 筆買動漫/).waitFor();
  }
  await page.getByLabel('選擇 WACA Excel').setInputFiles(join(downloads, 'waca資料.xlsx'));
  await page.getByRole('heading', { name: '匯入預覽：waca資料.xlsx' }).waitFor();
  const preview = await page.locator('.waca-metrics').last().innerText();
  assert.match(preview, /60\s+商品特徵/);
  assert.match(preview, /60\s+可自動配對特徵/);
  assert.match(preview, /0\s+未配對特徵/);
  assert.match(preview, /12\s+折扣忽略/);
  assert.match(await page.locator('.waca-equation').innerText(), /有效商品數量 111 = 已配對 111 \+ 待處理 0/);
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認匯入' }).click()]);
  await page.getByText(/匯入完成：新增 115/).waitFor();
  assert.match(await page.locator('[aria-label="WACA 目前驗收摘要"]').innerText(), /60\s+已配對特徵/);
  const quantityBefore = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  const quantityMapBefore = new Map(quantityBefore.map(row => [row.id, row.waca_auto_quantity ?? 0]));

  await page.getByLabel('選擇 WACA Excel').setInputFiles(join(downloads, 'waca資料.xlsx'));
  await page.getByRole('heading', { name: '匯入預覽：waca資料.xlsx' }).waitFor();
  assert.match(await page.locator('.waca-metrics').last().innerText(), /115\s+未變更/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認匯入' }).click()]);
  const backup = JSON.parse(readFileSync(await download.path(), 'utf8'));
  assert.equal(backup.wacaOrders.length, 71);
  assert.equal(backup.wacaItems.length, 115);
  assert.equal(backup.wacaMappings.length, 60);
  assert.equal(backup.myacgMasterLinks.length, 1267);
  assert.equal(backup.wacaImportBatches.length, 1);
  assert.equal(backup.productVariants.length, erp.productVariants.length, 'NEXT JSON export must retain raw variants');
  const workbenchBackup = await page.evaluate(async () => {
    const { collectWorkbenchBackupData } = await import('/src/lib/workbenchJsonBackup.ts');
    return collectWorkbenchBackupData(window.dataProvider);
  });
  assert.equal(workbenchBackup.productVariants.length, erp.productVariants.length);
  assert.equal(workbenchBackup.myacgMasterLinks.length, 1267);
  const quantityAfter = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.deepEqual(new Map(quantityAfter.map(row => [row.id, row.waca_auto_quantity ?? 0])), quantityMapBefore);

  const restoredContext = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW' });
  const restored = await restoredContext.newPage();
  await restored.goto(`${origin}/waca`);
  await restored.waitForFunction(() => Boolean(window.db));
  assert.equal(await restored.evaluate(async value => window.db.importData(JSON.stringify(value)), backup), true);
  await restored.reload();
  await restored.getByRole('heading', { name: 'WACA 訂單整合' }).waitFor();
  await restored.waitForFunction(() => document.querySelector('[aria-label="WACA 目前驗收摘要"] strong')?.textContent === '60');
  assert.match(await restored.locator('[aria-label="WACA 目前驗收摘要"]').innerText(), /60\s+已配對特徵/);
  const restoredVariants = await restored.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.deepEqual(new Map(restoredVariants.map(row => [row.id, row.waca_auto_quantity ?? 0])), quantityMapBefore);
  await restored.getByLabel('選擇 WACA Excel').setInputFiles(join(downloads, 'waca資料.xlsx'));
  await restored.getByRole('heading', { name: '匯入預覽：waca資料.xlsx' }).waitFor();
  assert.match(await restored.locator('.waca-metrics').last().innerText(), /115\s+未變更/);
  assert.deepEqual(errors, []);
  await restoredContext.close();
  await context.close();
  console.log('PASS real XLS UI: 3 MyACG sources, 60/60 features, 115/115 rows, repeat import, export, isolated restore, quantity parity');
} finally {
  if (browser) await browser.close();
  server.kill();
}
