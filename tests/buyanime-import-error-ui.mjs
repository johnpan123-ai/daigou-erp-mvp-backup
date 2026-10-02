import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ configFile: 'tests/fixtures/inventory-cloud-import-vite.config.mjs',
  configLoader: 'runner', mode: 'staging', server: { host: '127.0.0.1', port: 4290, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  let networkWrites = 0;
  page.on('request', request => { if (new URL(request.url()).hostname.endsWith('.supabase.co')) networkWrites++; });
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.goto('http://127.0.0.1:4290/tests/fixtures/inventory-cloud-import.html');
  await page.waitForFunction(() => Boolean(window.__INVENTORY_CLOUD_IMPORT_TEST__));
  await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.completeBootstrap());
  const valid = '<table><tr><th>商品編號</th><th>商品名稱</th><th>規格</th></tr><tr><td>G-SYNTHETIC</td><td>Synthetic</td><td>A</td></tr></table>';
  const upload = async buffer => {
    const n = dialogs.length;
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(buffer) });
    for (let i = 0; i < 100 && dialogs.length === n; i++) await page.waitForTimeout(25);
    assert.equal(dialogs.length, n + 1);
    return dialogs.at(-1);
  };
  for (const [error, message] of [
    [{ code: '23505', message: 'duplicate key value violates unique constraint "inventory_items_inventory_key_key"' }, /雲端儲存失敗，資料未變更/u],
    [{ code: '42501', message: 'permission denied' }, /權限不足/u],
    [{ message: 'Failed to fetch' }, /儲存結果尚未確認.*勿重複匯入/u],
  ]) {
    await page.evaluate(value => window.__INVENTORY_CLOUD_IMPORT_TEST__.failNextImport(value), error);
    assert.match(await upload(valid), message);
    assert.ok(await page.getByText('匯入技術資訊', { exact: true }).isVisible());
    assert.equal(await page.locator('details').filter({ hasText: '匯入技術資訊' }).getAttribute('open'), null);
  }
  assert.match(await upload('<table><tr><th>Unknown</th></tr><tr><td>x</td></tr></table>'), /找不到必要欄位/u);
  assert.match(await upload('<table><tr><th>商品編號</th><th>商品名稱</th></tr></table>'), /資料內容驗證失敗/u);
  assert.equal((await page.evaluate(() => window.__INVENTORY_CLOUD_IMPORT_TEST__.snapshot())).upsertCalls, 0);
  assert.equal(networkWrites, 0);
  assert.ok(dialogs.every(text => !text.includes('請確認檔案格式是否正確')));
  console.log('PASS actual UI: unique/permission/network-unknown/missing-fields/empty-data classification; collapsed redacted diagnostics; no automatic retry, no writes');
} finally { await browser.close(); await server.close(); }
