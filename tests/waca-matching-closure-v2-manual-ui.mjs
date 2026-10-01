import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const origin = 'http://127.0.0.1:4397';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'next', '--host', '127.0.0.1',
  '--port', '4397', '--strictPort', '--configLoader', 'runner'],
{ env: { ...process.env, VITE_DEPLOYMENT_ENV: 'next' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (attempt === 79 || server.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW' });
  const page = await context.newPage();
  await page.goto(`${origin}/waca`);
  await page.waitForFunction(() => Boolean(window.db));
  const seed = Object.fromEntries(['inventory', 'salesOrders', 'salesOrderItems', 'productGroups',
    'productCategories', 'productVariants', 'purchaseBatches', 'purchaseBatchItems', 'privateOrders',
    'privateOrderItems', 'japanPackages', 'japanPackageItems', 'outboundShipments',
    'outboundShipmentItems', 'bundleComponents', 'importBatches'].map(key => [key, []]));
  seed.productGroups = [{ id: 'group-a', title: 'Product A' }];
  seed.productVariants = [
    { id: 'variant-red', product_group_id: 'group-a', myacg_item_code: 'G-RED',
      product_title: 'Product A', variant_name: 'Red', raw_variant_name: 'Red', waca_auto_quantity: 0, note: '', sort_order: 0 },
    { id: 'variant-blue', product_group_id: 'group-a', myacg_item_code: 'G-BLUE',
      product_title: 'Product A', variant_name: 'Blue', raw_variant_name: 'Blue', waca_auto_quantity: 0, note: '', sort_order: 1 },
  ];
  assert.equal(await page.evaluate(async value => window.db.importData(JSON.stringify(value)), seed), true);
  await page.reload();
  await page.getByRole('heading', { name: 'WACA 匯入' }).waitFor();
  await page.locator('.waca-master-import > summary').click();
  const html = '<table><tr><th>主編號(多規格編號)</th><th>子編號(商品編號)</th><th>商品名稱</th><th>規格/項目</th></tr>'
    + '<tr><td>GP-A</td><td>G-RED</td><td>Product A</td><td>Red</td></tr>'
    + '<tr><td>GP-A</td><td>G-BLUE</td><td>Product A</td><td>Blue</td></tr></table>';
  await page.getByLabel('選擇買動漫商品匯出檔').setInputFiles({ name: 'master.xls',
    mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(html) });
  await page.getByText(/可保存 2 筆/).waitFor();
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認保存對照' }).click()]);
  await page.getByText(/已保存 2 筆買動漫/).waitFor();
  const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一',
    '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    headers.map(() => '訂單資訊'), headers,
    ['處理中', 'O-1', '2026-09-28', 'GP-A', 'Product A', '', '', '', 1, 100],
    ['處理中', 'O-2', '2026-09-28', 'GP-Z', 'Missing Product', 'Unknown', '', '', 1, 100],
  ]), 'WACA');
  await page.getByLabel('選擇 WACA Excel').setInputFiles({ name: 'manual.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
  await page.getByRole('heading', { name: '匯入預覽：manual.xlsx' }).waitFor();
  assert.match(await page.locator('[aria-label="WACA 匯入預覽摘要"]').innerText(), /2\s+待處理/);
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認更新' }).click()]);
  await page.getByText(/WACA 訂單已保存/).waitFor();
  await page.getByRole('navigation', { name: 'WACA 功能' }).getByRole('button', { name: /待處理/ }).click();
  const ambiguous = page.locator('.waca-pending-card').filter({ hasText: 'WACA 商品：GP-A' });
  await ambiguous.waitFor();
  assert.match(await ambiguous.innerText(), /有 2 個可能規格/);
  await ambiguous.locator('details > summary').click();
  assert.match(await ambiguous.innerText(), /G-RED／買動漫規格 Red／\s*ERP ProductVariant variant-red/);
  assert.match(await ambiguous.innerText(), /G-BLUE／買動漫規格 Blue／\s*ERP ProductVariant variant-blue/);
  const missing = page.locator('.waca-pending-card').filter({ hasText: 'WACA 商品：GP-Z' });
  assert.match(await missing.innerText(), /找不到對應商品/);
  assert.match(await missing.innerText(), /找不到可安全確認的規格/);
  await ambiguous.locator('select').selectOption('variant-blue');
  await Promise.all([page.waitForEvent('download'), ambiguous.getByRole('button', { name: '確認對照' }).click()]);
  await page.getByText(/商品對照已保存/).waitFor();
  assert.match(await page.locator('[aria-label="WACA 目前驗收摘要"]').innerText(), /1\s+人工確認特徵/);
  assert.match(await page.locator('[aria-label="WACA 目前驗收摘要"]').innerText(), /1\s+待處理特徵/);
  const variants = await page.evaluate(() => window.db.getProductVariants({ raw: true }));
  assert.equal(variants.find(item => item.id === 'variant-blue').waca_auto_quantity, 1);
  assert.equal(variants.find(item => item.id === 'variant-red').waca_auto_quantity, 0);
  // Unproven parents are NEVER automatically searched across groups. A human
  // can explicitly select a group, then one of that group's variants, once.
  await missing.getByLabel('商品群組 GP-Z Unknown').selectOption('group-a');
  await missing.getByLabel('處理 GP-Z Unknown').selectOption('variant-red');
  await Promise.all([page.waitForEvent('download'), missing.getByRole('button', { name: '確認對照' }).click()]);
  await page.getByText(/商品對照已保存/).waitFor();
  const snapshot = await page.evaluate(async () => (await import('/src/waca/nextStorage.ts')).readNextWacaSnapshot());
  assert.equal(snapshot.items.find(item => item.productCode === 'GP-Z').resolution, 'MANUAL_CONFIRMED_MAPPING');
  await page.reload();
  await page.getByRole('button', { name: '來源訂單', exact: true }).click();
  assert.equal((await page.evaluate(() => window.db.getProductVariants({ raw: true }))).find(v => v.id === 'variant-red').waca_auto_quantity, 1);
  await context.close();
  console.log('PASS manual confirmation UI: scoped candidates, provenance, zero-candidate message, permanent mapping and quantity recompute');
} finally {
  if (browser) await browser.close();
  server.kill();
}
