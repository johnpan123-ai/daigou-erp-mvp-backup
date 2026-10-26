import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.JAPAN_PACKAGE_CREATE_UI_PORT || '4296';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/japan-package-create.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/japan-package-create-vite.config.mjs',
  '--configLoader', 'runner',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const open = async (browser, scenario, viewport) => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.goto(`${BASE_URL}?scenario=${scenario}`, { waitUntil: 'networkidle' });
  try {
    await page.getByRole('button', { name: '登記新包裹' }).click({ timeout: 8_000 });
  } catch (error) {
    throw new Error(`Japan package fixture did not render: ${await page.locator('body').innerText()}\n${output}`, { cause: error });
  }
  const title = page.getByPlaceholder('例如: 駿河屋 5月訂單包裹 / Booth 六月新娘周邊');
  await title.waitFor();
  return { context, page, title, dialogs };
};

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    {
      const { context, page, title } = await open(browser, 'success', { width: 1440, height: 1000 });
      await title.fill('羊周邊');
      await page.getByRole('button', { name: '儲存登記' }).click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot().rpcCalls === 1);
      await page.getByText('羊周邊', { exact: true }).waitFor();
      const result = await page.evaluate(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot());
      assert.equal(result.transactionCalls, 1);
      assert.equal(result.rpcCalls, 1);
      assert.equal(result.packages[0].title, '羊周邊');
      assert.equal(result.packages[0].status, 'registered');
      assert.equal(result.packages[0].carrier, 'ヤマト運輸 (Yamato)');
      await context.close();
    }
    {
      const { context, page, title } = await open(browser, 'success', { width: 1440, height: 1000 });
      await title.fill('中文・日本語 包裹');
      await page.getByPlaceholder('例如: Booth / 駿河屋 / animate').fill('アニメイト台北');
      await page.getByRole('combobox').nth(1).selectOption('custom');
      await page.getByPlaceholder('例如: 西濃運輸').fill('日本通運');
      await page.getByPlaceholder('追蹤單號').fill('JP-測試-123');
      await page.locator('input[type="date"]').nth(0).fill('2026-10-25');
      await page.locator('input[type="date"]').nth(1).fill('2026-10-26');
      await page.getByPlaceholder('輸入備註說明...').fill('全選用欄位測試');
      await page.getByRole('button', { name: '儲存登記' }).click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot().rpcCalls === 1);
      const row = (await page.evaluate(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot())).packages[0];
      assert.deepEqual({
        title: row.title, vendor: row.vendor_name, carrier: row.carrier, tracking: row.tracking_number,
        shipped: row.shipped_at, arrived: row.arrived_at, note: row.note,
      }, {
        title: '中文・日本語 包裹', vendor: 'アニメイト台北', carrier: '日本通運', tracking: 'JP-測試-123',
        shipped: '2026-10-25', arrived: '2026-10-26', note: '全選用欄位測試',
      });
      await context.close();
    }
    {
      const { context, page, title, dialogs } = await open(browser, 'offline', { width: 1440, height: 1000 });
      await title.fill('羊周邊');
      await page.getByRole('button', { name: '儲存登記' }).click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot().transactionCalls === 1);
      const result = await page.evaluate(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot());
      assert.equal(result.rpcCalls, 0);
      assert.equal(result.packages.length, 0);
      assert.equal(await title.inputValue(), '羊周邊');
      assert.ok(dialogs.some(message => message.includes('雲端資料目前不是可確認的最新狀態')));
      assert.ok(!dialogs.includes('儲存失敗，請重試！'));
      await context.close();
    }
    {
      const { context, page, title, dialogs } = await open(browser, 'classified', { width: 1440, height: 1000 });
      await title.fill('分類器回歸');
      await page.getByRole('button', { name: '儲存登記' }).click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot().transactionCalls === 1);
      const result = await page.evaluate(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot());
      assert.equal(result.rpcCalls, 1);
      assert.equal(result.packages.length, 0);
      assert.equal(await title.inputValue(), '分類器回歸');
      assert.ok(dialogs.includes('來源配置數量超過可用數量（已配置 3 件），操作未完成。'));
      await context.close();
    }
    {
      const { context, page, title } = await open(browser, 'pending', { width: 390, height: 844 });
      await title.fill('羊グッズ');
      const save = page.getByRole('button', { name: '儲存登記' });
      await save.evaluate(element => { element.click(); element.click(); });
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot().rpcCalls === 1);
      let result = await page.evaluate(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot());
      assert.equal(result.transactionCalls, 1);
      assert.equal(new Set(result.idempotencyKeys).size, 1);
      await page.evaluate(() => window.__JAPAN_PACKAGE_CREATE_TEST__.releasePending());
      await page.getByText('羊グッズ', { exact: true }).waitFor();
      result = await page.evaluate(() => window.__JAPAN_PACKAGE_CREATE_TEST__.snapshot());
      assert.equal(result.packages.length, 1);
      await context.close();
    }
    console.log('PASS desktop and mobile React UI create registered packages with Chinese/Japanese titles');
    console.log('PASS all visible optional fields preserve their values and successful rows render immediately');
    console.log('PASS double activation dispatches one idempotent command; offline failure sends no RPC and retains the form');
    console.log('PASS CLOUD_OFFLINE_WRITE_BLOCKED reason replaces the misleading generic retry alert');
    console.log('PASS other errors still use the existing bounded cloudMutationFailureMessage classifier');
  } finally {
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
