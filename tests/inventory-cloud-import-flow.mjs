import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.INVENTORY_CLOUD_IMPORT_TEST_PORT || '4271';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/inventory-cloud-import.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/inventory-cloud-import-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const makeHtmlXls = (sku, title) => `<!doctype html><html><body><table>
<tr><th>商品編號</th><th>商品名稱</th><th>規格</th><th>庫存</th><th>已售</th><th>售價</th></tr>
<tr><td>${sku}</td><td>${title}</td><td>規格A</td><td>2</td><td>0</td><td>10</td></tr>
</table></body></html>`;

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(BASE_URL)).ok) break; } catch {}
    await sleep(250);
    if (attempt === 79) throw new Error(output);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW' });
    const page = await context.newPage();
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__INVENTORY_CLOUD_IMPORT_TEST__));
    const productCount = page.getByText('商品總數', { exact: true }).locator('..').locator('.kpi-card-value');
    const joinedCount = page.getByText('已加入訂購', { exact: true }).locator('..').locator('.kpi-card-value');
    const unjoinedCount = page.getByText('未加入訂購', { exact: true }).locator('..').locator('.kpi-card-value');
    await page.waitForFunction(() => document.body.innerText.includes('商品總數'));
    assert.equal(await productCount.innerText(), '501', 'The bounded bootstrap may expose the incomplete pre-authoritative cache');
    assert.deepEqual((await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot())).callOrder.slice(0, 2), ['groups', 'catalog-snapshot']);

    await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.completeBootstrap());
    await page.waitForFunction(() => document.body.innerText.includes('1469'));
    assert.equal(await productCount.innerText(), '1469', 'Incomplete cache 501 must converge to the mounted authoritative KPI 1469');
    assert.equal(await joinedCount.innerText(), '684', 'Joined KPI must be derived from the authoritative Inventory title set');
    assert.equal(await unjoinedCount.innerText(), '785', 'Unjoined KPI must be the authoritative complement');

    await page.evaluate(() => {
      window.__INVENTORY_CLOUD_IMPORT_TEST__.resetToServer500();
      window.__INVENTORY_CLOUD_IMPORT_TEST__.remount();
    });
    await page.waitForFunction(() => document.body.innerText.includes('500'));

    const importFile = async (name, sku, title) => {
      const expectedUpserts = (await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot())).upsertCalls + 1;
      const chooserPromise = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '匯入主檔 XLS' }).click();
      const chooser = await chooserPromise;
      await chooser.setFiles({ name, mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(makeHtmlXls(sku, title)) });
      await page.waitForFunction(expected => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot().upsertCalls === expected, expectedUpserts);
    };

    await importFile('new-unjoined.xls', 'NEW-UNJOINED-SKU', 'New Unjoined Product');
    await page.waitForFunction(() => document.body.innerText.includes('501'));
    await page.waitForFunction(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot().syncCalls === 0);
    assert.equal(dialogs.some(message => message.includes('維持「未加入」')), true, 'New unjoined catalog row must report the intentional no-sync outcome');

    await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.remount());
    await page.waitForFunction(() => document.body.innerText.includes('501'));
    assert.equal(await productCount.innerText(), '501', 'When the server truth is 501, the F5/remount equivalent must remain 501');

    await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.prepareLateStaleRead());
    const refreshButton = page.getByRole('button', { name: '重新整理' });
    await refreshButton.click();
    await page.waitForTimeout(20);
    await refreshButton.click();
    await page.waitForFunction(() => document.body.innerText.includes('600'));
    await page.waitForTimeout(200);
    assert.equal(await productCount.innerText(), '600', 'A late stale read must not overwrite the newest refresh');

    await importFile('existing-group.xls', 'EXISTING-SKU', 'Existing Product');
    await page.waitForFunction(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot().inventoryCount === 601);
    await page.waitForFunction(() => document.body.innerText.includes('601'));
    await page.waitForFunction(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot().syncCalls === 1);
    const partial = dialogs.find(message => message.includes('Catalog 主檔已寫入雲端'));
    assert.ok(partial, 'Committed inventory plus blocked follow-up must be reported as partial success');
    assert.match(partial, /本次不會自動重試/u);
    assert.doesNotMatch(partial, /匯入失敗/u);

    await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.failNextPostCommitGroupRead());
    await importFile('readback-failure.xls', 'READBACK-FAILURE-SKU', 'Readback Failure Product');
    await page.waitForFunction(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot().inventoryCount === 602);
    const readbackPartial = dialogs.find(message => message.includes('同步資格的雲端查驗未完成'));
    assert.ok(readbackPartial, 'A post-commit authoritative-read failure must not be reported as a wholly failed import');
    assert.doesNotMatch(readbackPartial, /匯入失敗/u);
    assert.deepEqual(await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot()), {
      callOrder: (await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot())).callOrder,
      inventoryCount: 602,
      syncCalls: 1,
      upsertCalls: 3,
    });
  } finally {
    await browser.close();
  }
} finally {
  vite.kill();
}

console.log('PASS Cloud catalog import preserves authoritative read order, skips impossible no-op sync, and reports committed partial state truthfully');
