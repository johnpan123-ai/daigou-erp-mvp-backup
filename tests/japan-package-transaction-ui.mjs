import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.JAPAN_PACKAGE_TRANSACTION_TEST_PORT || '4287';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/japan-package-transaction.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/japan-package-transaction-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const open = async (context, scenario) => {
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.goto(`${BASE_URL}?scenario=${scenario}`, { waitUntil: 'networkidle' });
  await page.getByText('F3 Transaction Item', { exact: false }).first().waitFor();
  const checkbox = page.locator('.checklist-item-row input[type="checkbox"]').first();
  return { page, checkbox, dialogs };
};

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    {
      const { page, checkbox } = await open(context, 'success');
      const sort = page.getByRole('combobox', { name: '包裹內容排序' });
      assert.equal(await sort.inputValue(), 'sku', 'each detail opens in SKU order');
      for (const width of [1280, 1366]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page.evaluate(() => {
          const rect = selector => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`Missing ${selector}`);
            const { x, y, width: elementWidth, height } = element.getBoundingClientRect();
            return { x, y, width: elementWidth, height };
          };
          return {
            pageWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            header: rect('.checklist-group-header'),
            title: rect('.checklist-group-title-area'),
            copy: rect('.group-title-copy-action'),
            progress: rect('.group-progress-wrapper'),
            actions: rect('.group-bulk-actions'),
          };
        });
        assert.ok(geometry.pageWidth <= geometry.viewportWidth, `${width}px detail has no horizontal overflow`);
        assert.ok(geometry.copy.x > geometry.title.x, 'copy action sits beside the group title');
        assert.ok(geometry.progress.x > geometry.copy.x, 'progress follows the title and copy action');
        assert.ok(geometry.actions.x > geometry.progress.x, 'bulk actions follow progress');
        assert.ok(Math.abs(geometry.copy.y - geometry.actions.y) < 12, `${width}px group controls share one row`);
        assert.ok(geometry.header.height < 76, `${width}px group header stays compact`);
      }
      const groupHeader = page.locator('.checklist-group-header-main').first();
      await groupHeader.click();
      assert.ok((await page.locator('.checklist-group-header').first().textContent()).includes('▶'));
      await sort.selectOption('name');
      await sort.selectOption('similar-name');
      await sort.selectOption('order');
      await sort.selectOption('original');
      assert.ok((await page.locator('.checklist-group-header').first().textContent()).includes('▶'), 'sort must preserve expansion state');
      assert.equal((await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot())).transactionCalls, 0, 'sorting never dispatches receiving');
      await groupHeader.click();
      assert.equal(await checkbox.isChecked(), false, 'sorting preserves checkbox state');
      await checkbox.click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().rpcCalls === 1);
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().items[0].checked === true);
      const result = await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot());
      assert.equal(result.transactionCalls, 1);
      assert.equal(result.rpcCalls, 1);
      assert.equal(result.oldPackageWrites, 0);
      assert.equal(result.oldItemWrites, 0);
      assert.equal(result.packageRow.status, 'confirmed');
      assert.equal(await checkbox.isChecked(), true);
      await page.close();
    }
    {
      const { page, checkbox } = await open(context, 'stale');
      await checkbox.click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().transactionCalls === 1);
      const result = await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot());
      assert.equal(result.rpcCalls, 0);
      assert.equal(result.items[0].checked, false);
      assert.equal(await checkbox.isChecked(), false);
      await page.close();
    }
    {
      const { page, checkbox } = await open(context, 'offline');
      await checkbox.click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().transactionCalls === 1);
      const result = await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot());
      assert.equal(result.rpcCalls, 0);
      assert.equal(result.items[0].checked, false);
      await page.close();
    }
    {
      const { page, checkbox } = await open(context, 'pending');
      await checkbox.evaluate(element => { element.click(); element.click(); });
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().rpcCalls === 1);
      let result = await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot());
      assert.equal(result.transactionCalls, 1);
      assert.equal(result.rpcCalls, 1);
      assert.equal(new Set(result.idempotencyKeys).size, 1);
      await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.releasePending());
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().items[0].checked === true);
      result = await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot());
      assert.equal(result.transactionCalls, 1);
      await page.close();
    }
    {
      const { page } = await open(context, 'pending');
      const root = page.getByTestId('japan-package-detail-root');
      await root.evaluate(element => { window.__JAPAN_PACKAGE_DETAIL_ROOT__ = element; });
      const confirmButton = page.getByRole('button', { name: '確認點收包裹' });
      await confirmButton.click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().rpcCalls === 1);
      assert.equal(await root.getAttribute('aria-busy'), 'true');
      assert.equal(await page.getByRole('button', { name: '確認中…' }).isDisabled(), true);
      assert.equal(await page.getByText('F3 Transaction Item', { exact: false }).first().isVisible(), true);
      assert.equal(await page.getByText('載入包裹詳情中...', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => document.querySelector('[data-testid="japan-package-detail-root"]') === window.__JAPAN_PACKAGE_DETAIL_ROOT__), true);
      await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.releasePending());
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().items[0].checked === true);
      await page.waitForFunction(() => document.querySelector('[data-testid="japan-package-detail-root"]')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.evaluate(() => document.querySelector('[data-testid="japan-package-detail-root"]') === window.__JAPAN_PACKAGE_DETAIL_ROOT__), true);
      await page.close();
    }
    {
      const { page, checkbox, dialogs } = await open(context, 'server-rejected');
      await checkbox.click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().rpcCalls === 1);
      assert.equal((await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot())).items[0].checked, false);
      assert.ok(dialogs.some(message => message.includes('伺服器已拒絕')));
      await page.close();
    }
    {
      const { page, checkbox, dialogs } = await open(context, 'unknown');
      await checkbox.click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().rpcCalls === 1);
      await checkbox.click();
      await sleep(50);
      const result = await page.evaluate(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot());
      assert.equal(result.rpcCalls, 1, 'Unknown result must latch the action and prohibit duplicate dispatch');
      assert.equal(new Set(result.idempotencyKeys).size, 1);
      assert.ok(dialogs.some(message => message.includes('結果待查證')));
      await page.close();
    }
    {
      const { page, checkbox, dialogs } = await open(context, 'postcommit');
      await checkbox.click();
      await page.waitForFunction(() => window.__JAPAN_PACKAGE_TRANSACTION_TEST__.snapshot().items[0].checked === true);
      assert.equal(await checkbox.isChecked(), true);
      assert.ok(dialogs.some(message => message.includes('已提交') && message.includes('同步尚未完成')));
      await page.close();
    }
    console.log('PASS real JapanPackageDetail receiving UI dispatches one atomic command and commits canonical DOM state');
    console.log('PASS stale/offline pre-RPC keeps item unchanged; double activation is synchronously deduped');
    console.log('PASS unknown result latches duplicate dispatch; server rejection remains fail-closed');
    console.log('PASS committed-sync-pending retains successful canonical result');
    console.log('PASS package confirmation keeps the real detail list mounted and exposes a disabled pending state');
  } finally {
    await context.close();
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
