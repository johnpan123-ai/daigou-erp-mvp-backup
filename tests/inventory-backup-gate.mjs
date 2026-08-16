import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4193';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BACKUP_COLLECTIONS = [
  'inventory',
  'salesOrders',
  'salesOrderItems',
  'productGroups',
  'productCategories',
  'productVariants',
  'purchaseBatches',
  'purchaseBatchItems',
  'privateOrders',
  'privateOrderItems',
  'importBatches',
  'bundleComponents',
  'japanPackages',
  'japanPackageItems',
  'outboundShipments',
  'outboundShipmentItems',
];

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4193', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

const makeHtmlXls = (sku, title) => `<!doctype html>
<html><body><table>
  <tr><th>商品編號</th><th>商品名稱</th><th>規格</th><th>庫存</th><th>已售</th></tr>
  <tr><td>${sku}</td><td>${title}</td><td>測試規格</td><td>3</td><td>2</td></tr>
</table></body></html>`;

async function chooseImportFile(page, name, content) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '匯入主檔 XLS' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(content) });
}

async function readInventory(page) {
  return page.evaluate(() => window.dataProvider.getInventory());
}

async function waitForDialogText(messages, pattern) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const match = messages.find(message => pattern.test(message));
    if (match) return match;
    await sleep(50);
  }
  throw new Error(`Dialog not found: ${pattern}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await context.newPage();
const productionSupabaseRequests = [];
const unexpectedErrors = [];
const dialogMessages = [];

page.on('request', request => {
  if (request.url().includes('.supabase.co/')) productionSupabaseRequests.push(request.url());
});
page.on('console', message => {
  const text = message.text();
  if (message.type() === 'error'
    && !text.includes('[Import Backup ERROR]')
    && !text.includes('Test Sandbox blocked')) unexpectedErrors.push(text);
});
page.on('pageerror', error => unexpectedErrors.push(error.message));
page.on('dialog', async dialog => {
  dialogMessages.push(dialog.message());
  await dialog.accept();
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'test'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));
  await page.evaluate(() => window.dataProvider.clearData());
  await page.goto(`${BASE_URL}/inventory`, { waitUntil: 'networkidle' });

  assert.equal(await page.getByRole('button', { name: '匯出 JSON 備份' }).isVisible(), true);

  const manualDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出 JSON 備份' }).click();
  const manualDownload = await manualDownloadPromise;
  assert.match(manualDownload.suggestedFilename(), /^workbench-backup-\d{8}-\d{6}\.json$/);
  const manualPath = await manualDownload.path();
  assert.ok(manualPath, 'Manual backup should produce a local download');
  const manualJson = await readFile(manualPath, 'utf8');
  assert.ok(Buffer.byteLength(manualJson) > 2, 'Manual backup must not be empty');
  const manualData = JSON.parse(manualJson);
  assert.deepEqual(Object.keys(manualData), BACKUP_COLLECTIONS);
  for (const key of BACKUP_COLLECTIONS) assert.equal(Array.isArray(manualData[key]), true, `${key} must be an array`);

  const autoDownloadPromise = page.waitForEvent('download');
  await chooseImportFile(page, 'inventory-success.xls', makeHtmlXls('AUTO-BACKUP-SKU', '匯入成功測試'));
  const autoDownload = await autoDownloadPromise;
  assert.match(autoDownload.suggestedFilename(), /^workbench-before-xls-import-\d{8}-\d{6}\.json$/);
  const autoPath = await autoDownload.path();
  assert.ok(autoPath, 'Pre-import backup should produce a local download');
  const autoData = JSON.parse(await readFile(autoPath, 'utf8'));
  assert.deepEqual(autoData.inventory, [], 'Pre-import JSON must describe state before XLS import');

  await page.waitForFunction(async () => {
    const items = await window.dataProvider.getInventory();
    return items.some(item => item.myacg_item_code === 'AUTO-BACKUP-SKU');
  });
  await waitForDialogText(dialogMessages, /買動漫 Catalog 匯入結果/);
  assert.equal((await readInventory(page)).filter(item => item.myacg_item_code === 'AUTO-BACKUP-SKU').length, 1);
  assert.equal(dialogMessages.some(message => message.includes('買動漫 Catalog 匯入結果')), true, 'Successful backup should allow XLS import');

  const sourceBeforeFailure = await readInventory(page);
  await page.evaluate(() => {
    window.__originalCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = () => { throw new Error('forced backup download failure'); };
  });
  await chooseImportFile(page, 'inventory-must-not-import.xls', makeHtmlXls('BLOCKED-SKU', '不應匯入'));
  await waitForDialogText(dialogMessages, /備份失敗.*已中止 XLS 匯入/);
  const afterFailure = await readInventory(page);
  assert.deepEqual(afterFailure, sourceBeforeFailure, 'Backup failure must leave Inventory unchanged');
  assert.equal(afterFailure.some(item => item.myacg_item_code === 'BLOCKED-SKU'), false);
  assert.equal(dialogMessages.some(message => message.includes('備份失敗') && message.includes('已中止 XLS 匯入')), true);
  await page.evaluate(() => {
    URL.createObjectURL = window.__originalCreateObjectUrl;
    delete window.__originalCreateObjectUrl;
  });

  assert.deepEqual(productionSupabaseRequests, [], 'Inventory backup/import tests must not contact Production Supabase');
  assert.deepEqual(unexpectedErrors, []);

  const inventorySource = await readFile(new URL('../src/pages/Inventory.tsx', import.meta.url), 'utf8');
  const backupCall = inventorySource.indexOf('const backup = await createPreImportBackup()');
  const parseCall = inventorySource.indexOf('const parsedItems = await parseMyAcgFile(file)');
  assert.ok(backupCall >= 0 && parseCall > backupCall, 'Backup gate must run before XLS parsing');
  const backupCatch = inventorySource.slice(backupCall, parseCall);
  assert.match(backupCatch, /已中止 XLS 匯入/);
  assert.match(backupCatch, /return;/);
  assert.doesNotMatch(backupCatch, /continuing import/);

  console.log('PASS manual JSON backup is non-empty, parseable, and complete');
  console.log('PASS XLS import downloads a timestamped JSON of the pre-import state first');
  console.log('PASS successful backup permits XLS parsing and Test DB import');
  console.log('PASS forced backup failure aborts import and preserves Inventory');
  console.log('PASS existing rollback remains separate and Production Supabase requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
