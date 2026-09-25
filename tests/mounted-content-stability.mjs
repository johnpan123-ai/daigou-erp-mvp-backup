import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.MOUNTED_CONTENT_STABILITY_PORT || '4296';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/tests/fixtures/cloud-p0-2-react-harness.html`;
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

for (let attempt = 0; attempt < 80; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
  try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
  if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const open = async (route, extra = '', width = 1366) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('simulated outbound confirmation failure')) errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${FIXTURE_URL}?route=${encodeURIComponent(route)}${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  return { context, page, errors };
};

const waitForLoadComplete = async (page, loadingText) => {
  await page.waitForFunction(text => !document.body.textContent?.includes(text), loadingText);
};

const assertBackgroundContinuity = async ({ route, rootTestId, loadingText, table, collection, id, patch, beforeAction }) => {
  const { context, page, errors } = await open(route);
  try {
    await waitForLoadComplete(page, loadingText);
    if (beforeAction) await beforeAction(page);
    const root = page.getByTestId(rootTestId);
    await root.waitFor();
    await root.evaluate((element, text) => {
      window.__MOUNTED_CONTENT_ROOT__ = element;
      window.__FULL_LOADING_SEEN__ = false;
      const observer = new MutationObserver(() => {
        if (document.body.textContent?.includes(text)) window.__FULL_LOADING_SEEN__ = true;
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, loadingText);
    const beforeLoads = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().pageLoads);
    await page.evaluate(({ table, collection, id, patch }) => {
      const harness = window.__P0_REACT_HARNESS__;
      harness.holdNextPageRead();
      const current = harness.server[collection].find(row => row.id === id) || { id };
      window.__BACKGROUND_REFRESH__ = harness.emitUpsert(table, {
        ...current,
        ...patch,
        id,
        updated_at: new Date().toISOString(),
      });
    }, { table, collection, id, patch });
    await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === true);
    assert.equal(await root.isVisible(), true, `${route} hid its usable content during refresh`);
    assert.equal(await page.getByText(loadingText, { exact: true }).count(), 0, `${route} returned to full-page loading`);
    assert.equal(await page.evaluate(testId => document.querySelector(`[data-testid="${testId}"]`) === window.__MOUNTED_CONTENT_ROOT__, rootTestId), true, `${route} remounted its content root`);
    await page.evaluate(async () => {
      window.__P0_REACT_HARNESS__.releasePageRead();
      await window.__BACKGROUND_REFRESH__;
    });
    await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === false);
    const afterLoads = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().pageLoads);
    assert.notDeepEqual(afterLoads, beforeLoads, `${route} did not perform its mounted authoritative reread`);
    assert.equal(await page.evaluate(() => window.__FULL_LOADING_SEEN__), false, `${route} briefly rendered full-page loading`);
    assert.equal(await page.evaluate(testId => document.querySelector(`[data-testid="${testId}"]`) === window.__MOUNTED_CONTENT_ROOT__, rootTestId), true, `${route} replaced its content root after refresh`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
};

try {
  // Cold starts retain their intentional full-page loading treatment.
  for (const coldCase of [
    { route: '/outbound-shipments/out-react-1', loading: '載入中...' },
    { route: '/outbound-shipments', loading: '載入中...' },
    { route: '/recent-purchases', loading: '載入近期採購資料中…' },
    { route: '/duplicate-variants', loading: '載入中…' },
    { route: '/unlisted-items', loading: '資料整理中...' },
  ]) {
    const { context, page, errors } = await open(coldCase.route, '&holdInitialPageRead=1');
    try {
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === true);
      assert.equal(await page.getByText(coldCase.loading, { exact: true }).isVisible(), true, `${coldCase.route} lost its cold-start loading state`);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.releasePageRead());
      await waitForLoadComplete(page, coldCase.loading);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  // Real Outbound receiving route: two consecutive confirmations stay mounted.
  {
    const { context, page, errors } = await open('/outbound-shipments/out-react-1', '&outboundReceiving=1');
    try {
      await page.getByText('點收進度 0/2', { exact: false }).waitFor();
      const root = page.getByTestId('outbound-shipment-detail-root');
      await root.evaluate(element => {
        window.__OUTBOUND_ROOT__ = element;
        window.__OUTBOUND_LOADING_SEEN__ = false;
        const observer = new MutationObserver(() => {
          if (document.body.textContent?.includes('載入中...')) window.__OUTBOUND_LOADING_SEEN__ = true;
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });

      for (let index = 0; index < 2; index += 1) {
        await page.evaluate(() => window.__P0_REACT_HARNESS__.holdNextOutboundSave());
        await page.getByRole('button', { name: /全部來源點收/ }).nth(index).click();
        await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().outboundSaveHeld === true);
        assert.equal(await root.isVisible(), true);
        assert.equal(await page.getByText('載入中...', { exact: true }).count(), 0);
        assert.equal(await page.getByTestId('outbound-receiving-row').nth(index).getAttribute('data-pending'), 'true');
        assert.match(await page.getByTestId('outbound-receiving-row').nth(index).innerText(), /確認中/);
        await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseOutboundSave());
        await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().outboundSaveHeld === false);
        await page.waitForFunction(() => !document.body.textContent?.includes('儲存中（'));
      }
      await page.getByText('點收進度 2/2', { exact: false }).waitFor();

      // Delayed Realtime echo/readback remains non-blocking and preserves scroll/root state.
      await page.evaluate(() => {
        document.body.style.minHeight = '2200px';
        window.scrollTo(0, 420);
        const harness = window.__P0_REACT_HARNESS__;
        harness.holdNextPageRead();
        const row = structuredClone(harness.server.outboundShipmentItems[0]);
        window.__OUTBOUND_ECHO__ = harness.emitUpsert('outbound_shipment_items', row);
      });
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === true);
      const scrollBefore = await page.evaluate(() => window.scrollY);
      assert.equal(await root.isVisible(), true);
      assert.equal(await page.getByText('載入中...', { exact: true }).count(), 0);
      await page.evaluate(async () => {
        window.__P0_REACT_HARNESS__.releasePageRead();
        await window.__OUTBOUND_ECHO__;
      });
      assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
      assert.equal(await page.evaluate(() => document.querySelector('[data-testid="outbound-shipment-detail-root"]') === window.__OUTBOUND_ROOT__), true);

      // A rejected confirmation preserves the mounted list and does not retry.
      const writesBeforeFailure = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.failNextOutboundSave());
      await page.getByRole('button', { name: /取消 .*全部來源點收/ }).first().click();
      await page.getByText(/點收狀態儲存失敗/).waitFor();
      await page.waitForFunction(() => !document.body.textContent?.includes('儲存中（'));
      const writesAfterFailure = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes);
      assert.equal(writesAfterFailure - writesBeforeFailure, 1, 'Rejected confirmation was dispatched more than once');
      assert.equal(await root.isVisible(), true);
      assert.equal(await page.getByText('載入中...', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.__OUTBOUND_LOADING_SEEN__), false);

      // Two explicit page rereads prove the page-level generation guard: the
      // older captured snapshot is released last but cannot overwrite the newer one.
      await page.evaluate(async () => {
        const provider = window.dataProvider;
        const harness = window.__P0_REACT_HARNESS__;
        window.__ORIGINAL_OUTBOUND_READ__ = provider.getOutboundShipments.bind(provider);
        let pageReadNumber = 0;
        provider.getOutboundShipments = async () => {
          const snapshot = await window.__ORIGINAL_OUTBOUND_READ__();
          pageReadNumber += 1;
          if (pageReadNumber === 1) {
            window.__OLD_OUTBOUND_READ_STARTED__ = true;
            await new Promise(resolve => { window.__RELEASE_OLD_OUTBOUND_READ__ = resolve; });
          }
          return snapshot;
        };
        const current = harness.server.outboundShipments[0];
        await harness.setCacheRows('outbound_shipments', [{ ...current, title: 'Old Delayed Outbound Title' }]);
      });
      const retryButton = page.getByRole('button', { name: '重新載入', exact: true });
      await retryButton.click();
      await page.waitForFunction(() => window.__OLD_OUTBOUND_READ_STARTED__ === true);
      await page.evaluate(async () => {
        const harness = window.__P0_REACT_HARNESS__;
        const current = harness.server.outboundShipments[0];
        await harness.setCacheRows('outbound_shipments', [{ ...current, title: 'Newest Canonical Outbound Title' }]);
      });
      await retryButton.click();
      await page.getByText('Newest Canonical Outbound Title', { exact: true }).waitFor();
      await page.evaluate(async () => {
        window.__RELEASE_OLD_OUTBOUND_READ__();
        await new Promise(resolve => setTimeout(resolve, 30));
        window.dataProvider.getOutboundShipments = window.__ORIGINAL_OUTBOUND_READ__;
      });
      assert.equal(await page.getByText('Newest Canonical Outbound Title', { exact: true }).isVisible(), true);
      assert.equal(await page.getByText('Old Delayed Outbound Title', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => document.querySelector('[data-testid="outbound-shipment-detail-root"]') === window.__OUTBOUND_ROOT__), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  for (const pageCase of [
    {
      route: '/outbound-shipments', rootTestId: 'outbound-shipments-list-root', loadingText: '載入中...',
      table: 'outbound_shipments', collection: 'outboundShipments', id: 'out-react-1', patch: { title: 'Mounted Outbound B' },
    },
    {
      route: '/recent-purchases', rootTestId: 'recent-purchases-page', loadingText: '載入近期採購資料中…',
      table: 'product_groups', collection: 'productGroups', id: 'g-holo', patch: { normalized_title: 'mounted recent b' },
    },
    {
      route: '/duplicate-variants', rootTestId: 'duplicate-variants-root', loadingText: '載入中…',
      table: 'product_variants', collection: 'productVariants', id: 'v-holo', patch: { variant_name: 'Mounted Duplicate B' },
    },
    {
      route: '/unlisted-items', rootTestId: 'unlisted-items-root', loadingText: '資料整理中...',
      table: 'product_groups', collection: 'productGroups', id: 'g-holo', patch: { normalized_title: 'mounted unlisted b' },
    },
  ]) await assertBackgroundContinuity(pageCase);

  console.log('PASS Outbound consecutive item confirmations keep the detail root mounted with row-scoped pending feedback');
  console.log('PASS slow save, delayed Realtime echo, rejected save, scroll, and stale readback never restore full-page loading');
  console.log('PASS five affected routes preserve cold-start loading but keep usable content mounted during background refresh');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
