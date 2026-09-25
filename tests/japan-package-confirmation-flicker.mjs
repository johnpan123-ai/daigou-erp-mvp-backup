import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.JAPAN_PACKAGE_FLICKER_TEST_PORT || '4294';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-p0-2-react-harness.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const open = async (browser, route, width) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE_URL}?route=${encodeURIComponent(route)}&partialReceiving=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().connectivity.readStatus !== 'loading');
  return { context, page, errors };
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
      const { context, page, errors } = await open(browser, '/japan-packages/jp-react-1', 1366);
      try {
        await page.getByRole('button', { name: '確認點收包裹' }).waitFor();
        const root = page.getByTestId('japan-package-detail-root');
        await root.evaluate(element => {
          window.__FLICKER_ROOT__ = element;
          window.__LOADING_SEEN__ = false;
          const observer = new MutationObserver(() => {
            if (document.body.textContent?.includes('載入包裹詳情中...')) window.__LOADING_SEEN__ = true;
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });
        await page.getByRole('button', { name: '確認點收包裹' }).click();
        await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().japanPackageTransactionCalls === 1);
        await page.waitForFunction(() => !document.body.textContent?.includes('確認點收包裹'));
        assert.equal(await page.evaluate(() => document.querySelector('[data-testid="japan-package-detail-root"]') === window.__FLICKER_ROOT__), true);

        await page.evaluate(() => {
          const harness = window.__P0_REACT_HARNESS__;
          harness.holdNextPageRead();
          const row = structuredClone(harness.server.japanPackages.find(item => item.id === 'jp-react-1'));
          window.__ECHO_PROMISE__ = harness.emitUpsert('japan_packages', row);
        });
        await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === true);
        assert.equal(await page.getByText('包裹內商品清單', { exact: true }).isVisible(), true);
        assert.equal(await page.getByText('載入包裹詳情中...', { exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.__LOADING_SEEN__), false);
        assert.equal(await page.evaluate(() => document.querySelector('[data-testid="japan-package-detail-root"]') === window.__FLICKER_ROOT__), true);
        await page.evaluate(async () => {
          window.__P0_REACT_HARNESS__.releasePageRead();
          await window.__ECHO_PROMISE__;
        });
        await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === false);
        assert.equal(await page.evaluate(() => document.querySelector('[data-testid="japan-package-detail-root"]') === window.__FLICKER_ROOT__), true);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }

    {
      const { context, page, errors } = await open(browser, '/japan-packages', 1280);
      try {
        await page.getByText('React Japan Package A', { exact: true }).waitFor();
        const root = page.getByTestId('japan-packages-list-root');
        const search = page.getByPlaceholder('搜尋包裹名稱、寄件廠商、物流單號...');
        await search.fill('React');
        await root.evaluate(element => {
          window.__FLICKER_LIST_ROOT__ = element;
          window.__LIST_LOADING_SEEN__ = false;
          document.body.style.minHeight = '2200px';
          window.scrollTo(0, 400);
          const observer = new MutationObserver(() => {
            if (document.body.textContent?.includes('載入包裹資料中...')) window.__LIST_LOADING_SEEN__ = true;
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });
        const scrollBefore = await page.evaluate(() => window.scrollY);
        await page.evaluate(() => {
          const harness = window.__P0_REACT_HARNESS__;
          harness.holdNextPageRead();
          const current = harness.server.japanPackages.find(item => item.id === 'jp-react-1');
          window.__LIST_REFRESH_PROMISE__ = harness.emitUpsert('japan_packages', { ...current, title: 'React Japan Package B', updated_at: new Date().toISOString() });
        });
        await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === true);
        assert.equal(await page.getByText('React Japan Package A', { exact: true }).isVisible(), true);
        assert.equal(await page.getByText('載入包裹資料中...', { exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.__LIST_LOADING_SEEN__), false);
        assert.equal(await search.inputValue(), 'React');
        assert.equal(await page.evaluate(() => document.querySelector('[data-testid="japan-packages-list-root"]') === window.__FLICKER_LIST_ROOT__), true);
        await page.evaluate(async () => {
          window.__P0_REACT_HARNESS__.releasePageRead();
          await window.__LIST_REFRESH_PROMISE__;
        });
        await page.getByText('React Japan Package B', { exact: true }).waitFor();
        assert.equal(await search.inputValue(), 'React');
        assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
        assert.equal(await page.evaluate(() => document.querySelector('[data-testid="japan-packages-list-root"]') === window.__FLICKER_LIST_ROOT__), true);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
    console.log('PASS confirmation and delayed Realtime readback keep the real Japan Package detail list mounted');
    console.log('PASS list refresh preserves search, scroll, stable root identity, and visible rows at 1366/1280 widths');
    console.log('PASS no full-page loading replacement occurs after initial data is rendered');
  } finally {
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
