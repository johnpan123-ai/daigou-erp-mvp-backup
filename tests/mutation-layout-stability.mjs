import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.MUTATION_LAYOUT_STABILITY_PORT || '4298';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/tests/fixtures/cloud-p0-2-react-harness.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIAGNOSTIC = process.env.LAYOUT_DIAGNOSTIC === '1';
const TOLERANCE = 1;
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
const failures = [];
const requireStable = (label, before, during, after) => {
  const deltas = {
    pending: Math.abs(during - before),
    settled: Math.abs(after - before),
  };
  if (deltas.pending > TOLERANCE || deltas.settled > TOLERANCE) failures.push({ label, before, during, after, deltas });
  return deltas;
};
const open = async (route, extra, width) => {
  const context = await browser.newContext({ locale: 'zh-TW', viewport: { width, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  const errors = [];
  page.on('dialog', dialog => void dialog.accept());
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${FIXTURE_URL}?route=${encodeURIComponent(route)}${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().connectivity.readStatus !== 'loading');
  return { context, page, errors };
};
const rect = async (locator) => {
  const box = await locator.boundingBox();
  assert.ok(box, 'Expected visible geometry target');
  return box;
};

try {
  for (const width of [1366, 1280, 390]) {
    const { context, page, errors } = await open('/outbound-shipments/out-react-1', '&outboundReceiving=1', width);
    try {
      await page.getByText('點收進度 0/2', { exact: false }).waitFor();
      const rows = page.getByTestId('outbound-receiving-row');
      const main = page.locator('.main-area');
      const environmentBar = page.locator('.environment-status-bar');
      await main.evaluate(element => { element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight); });
      const firstIdle = await rect(rows.nth(0));
      const nextIdle = await rect(rows.nth(1));
      const infoIdle = await rect(page.getByTestId('outbound-save-status-slot').locator('..'));
      const toolbarIdle = await rect(page.getByTestId('outbound-background-status-slot').locator('..'));
      const groupIdle = await rect(page.getByTestId('outbound-group-header').first());
      const barIdle = await rect(environmentBar);
      const mainIdle = await rect(main);
      const scrollIdle = await main.evaluate(element => element.scrollTop);

      await page.evaluate(() => window.__P0_REACT_HARNESS__.holdNextOutboundSave());
      await page.getByRole('button', { name: /全部來源點收/ }).first().click();
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().outboundSaveHeld === true);
      const firstPending = await rect(rows.nth(0));
      const nextPending = await rect(rows.nth(1));
      const infoPending = await rect(page.getByTestId('outbound-save-status-slot').locator('..'));
      const toolbarPending = await rect(page.getByTestId('outbound-background-status-slot').locator('..'));
      const groupPending = await rect(page.getByTestId('outbound-group-header').first());
      const scrollPending = await main.evaluate(element => element.scrollTop);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseOutboundSave());
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().outboundSaveHeld === false);
      await page.waitForFunction(() => !document.body.textContent?.includes('儲存中（'));
      const firstSettled = await rect(rows.nth(0));
      const nextSettled = await rect(rows.nth(1));
      const infoSettled = await rect(page.getByTestId('outbound-save-status-slot').locator('..'));
      const toolbarSettled = await rect(page.getByTestId('outbound-background-status-slot').locator('..'));
      const groupSettled = await rect(page.getByTestId('outbound-group-header').first());
      const scrollSettled = await main.evaluate(element => element.scrollTop);

      const outbound = {
        width,
        rowHeight: [firstIdle.height, firstPending.height, firstSettled.height],
        nextRowTop: [nextIdle.y, nextPending.y, nextSettled.y],
        firstRowTop: [firstIdle.y, firstPending.y, firstSettled.y],
        info: [[infoIdle.y, infoIdle.height], [infoPending.y, infoPending.height], [infoSettled.y, infoSettled.height]],
        toolbar: [[toolbarIdle.y, toolbarIdle.height], [toolbarPending.y, toolbarPending.height], [toolbarSettled.y, toolbarSettled.height]],
        group: [[groupIdle.y, groupIdle.height], [groupPending.y, groupPending.height], [groupSettled.y, groupSettled.height]],
        scrollTop: [scrollIdle, scrollPending, scrollSettled],
      };
      requireStable(`${width} outbound row height`, firstIdle.height, firstPending.height, firstSettled.height);
      requireStable(`${width} outbound next-row top`, nextIdle.y, nextPending.y, nextSettled.y);
      requireStable(`${width} outbound scrollTop`, scrollIdle, scrollPending, scrollSettled);

      await page.evaluate(async () => {
        const connectivity = await import('/src/providers/cloud/cloudConnectivity.ts');
        connectivity.markCloudReadLoading('mutation-readback');
      });
      await page.getByRole('status').filter({ hasText: '雲端資料讀取中' }).waitFor();
      const barPending = await rect(environmentBar);
      const mainPending = await rect(main);
      await page.evaluate(async () => {
        const connectivity = await import('/src/providers/cloud/cloudConnectivity.ts');
        connectivity.markCloudReadFresh(1);
      });
      await page.getByRole('status').filter({ hasText: '雲端資料讀取中' }).waitFor({ state: 'hidden' });
      const barSettled = await rect(environmentBar);
      const mainSettled = await rect(main);
      const global = {
        width,
        environmentTop: [barIdle.y, barPending.y, barSettled.y],
        mainTop: [mainIdle.y, mainPending.y, mainSettled.y],
      };
      requireStable(`${width} environment bar top`, barIdle.y, barPending.y, barSettled.y);
      requireStable(`${width} main top`, mainIdle.y, mainPending.y, mainSettled.y);
      console.log(`GEOMETRY outbound ${JSON.stringify(outbound)}`);
      console.log(`GEOMETRY global ${JSON.stringify(global)}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  // Purchase Records uses the real agency quantity input. Metadata/pending changes
  // may disable the input, but cannot resize its row or move the following row.
  {
    const { context, page, errors } = await open('/purchase-records', '&proxyDemand=1', 1366);
    try {
      await page.getByRole('button', { name: /代理版商品/ }).click();
      await page.getByTestId('purchase-records-edit-mode-toggle').click();
      const input = page.getByTestId('proxy-purchased-quantity-g-proxy');
      const row = input.locator('xpath=ancestor::tr');
      const nextRow = row.locator('xpath=following-sibling::tr[1]');
      await input.fill('9');
      const rowIdle = await rect(row);
      const nextIdle = await rect(nextRow);
      const main = page.locator('.main-area');
      const scrollIdle = await main.evaluate(element => element.scrollTop);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.holdNextVariantPatch());
      await input.press('Enter');
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().variantPatchHeld === true);
      const rowPending = await rect(row);
      const nextPending = await rect(nextRow);
      const scrollPending = await main.evaluate(element => element.scrollTop);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseVariantPatch());
      await page.waitForFunction(() => !document.querySelector('[data-testid="proxy-purchased-quantity-g-proxy"]')?.disabled);
      const rowSettled = await rect(row);
      const nextSettled = await rect(nextRow);
      const scrollSettled = await main.evaluate(element => element.scrollTop);
      requireStable('purchase-records row height', rowIdle.height, rowPending.height, rowSettled.height);
      requireStable('purchase-records next-row top', nextIdle.y, nextPending.y, nextSettled.y);
      console.log(`GEOMETRY purchase-records ${JSON.stringify({ rowHeight: [rowIdle.height, rowPending.height, rowSettled.height], nextRowTop: [nextIdle.y, nextPending.y, nextSettled.y], scrollTop: [scrollIdle, scrollPending, scrollSettled] })}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  // Japan Package confirmation keeps the same content anchor and button box while
  // the true transaction promise is pending and after the canonical result commits.
  for (const width of [1366, 1280, 390]) {
    const { context, page, errors } = await open('/japan-packages/jp-react-1', '&partialReceiving=1', width);
    try {
      const idleButtonName = width < 768 ? '全部標記為已點收' : '確認點收包裹';
      const button = page.getByRole('button', { name: idleButtonName });
      await button.waitFor();
      await button.scrollIntoViewIfNeeded();
      const anchor = width < 768
        ? page.getByTestId('japan-package-detail-root')
        : page.getByText('包裹內商品清單', { exact: true });
      const buttonIdle = await rect(button);
      const anchorIdle = await rect(anchor);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.holdNextJapanPackageTransaction());
      await button.click();
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().japanPackageTransactionHeld === true);
      const buttonPending = await rect(page.getByRole('button', { name: '確認中…' }));
      const anchorPending = await rect(anchor);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseJapanPackageTransaction());
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().japanPackageTransactionHeld === false);
      const anchorSettled = await rect(anchor);
      requireStable(`${width} japan button height`, buttonIdle.height, buttonPending.height, buttonPending.height);
      requireStable(`${width} japan content anchor`, anchorIdle.y, anchorPending.y, anchorSettled.y);
      console.log(`GEOMETRY japan ${JSON.stringify({ width, buttonHeight: [buttonIdle.height, buttonPending.height], anchorTop: [anchorIdle.y, anchorPending.y, anchorSettled.y] })}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  // Mounted background status text is allowed to change, but its in-flow slot
  // cannot move the first usable content below the page header.
  for (const pageCase of [
    {
      route: '/recent-purchases',
      anchor: page => page.locator('.recent-purchases-toolbar'),
      table: 'product_groups', collection: 'productGroups', id: 'g-holo', patch: { normalized_title: 'layout recent refresh' },
    },
    {
      route: '/unlisted-items',
      anchor: page => page.locator('.stats-grid'),
      table: 'product_groups', collection: 'productGroups', id: 'g-holo', patch: { normalized_title: 'layout unlisted refresh' },
    },
    {
      route: '/duplicate-variants',
      anchor: page => page.getByText('判定條件：', { exact: false }).first(),
      table: 'product_variants', collection: 'productVariants', id: 'v-holo', patch: { variant_name: 'layout duplicate refresh' },
    },
  ]) {
    const { context, page, errors } = await open(pageCase.route, '', 390);
    try {
      const anchor = pageCase.anchor(page);
      await anchor.waitFor();
      const idle = await rect(anchor);
      const refreshInput = { table: pageCase.table, collection: pageCase.collection, id: pageCase.id, patch: pageCase.patch };
      await page.evaluate(({ table, collection, id, patch }) => {
        const harness = window.__P0_REACT_HARNESS__;
        harness.holdNextPageRead();
        const current = harness.server[collection].find(row => row.id === id) || { id };
        window.__LAYOUT_BACKGROUND_REFRESH__ = harness.emitUpsert(table, { ...current, ...patch, id, updated_at: new Date().toISOString() });
      }, refreshInput);
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === true);
      const pending = await rect(anchor);
      await page.evaluate(async () => {
        window.__P0_REACT_HARNESS__.releasePageRead();
        await window.__LAYOUT_BACKGROUND_REFRESH__;
      });
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().pageReadHeld === false);
      const settled = await rect(anchor);
      requireStable(`${pageCase.route} background anchor`, idle.y, pending.y, settled.y);
      console.log(`GEOMETRY background ${JSON.stringify({ route: pageCase.route, width: 390, anchorTop: [idle.y, pending.y, settled.y] })}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  if (failures.length > 0) {
    console.log(`LAYOUT VIOLATIONS ${JSON.stringify(failures)}`);
    if (!DIAGNOSTIC) assert.fail(`${failures.length} mutation layout stability violation(s)`);
  }
  console.log('PASS Outbound mutation lifecycle keeps row heights, next-row anchors, and scroll position stable');
  console.log('PASS Cloud read status keeps environment/header/main geometry stable at 1366/1280/390');
  console.log('PASS Purchase Records and Japan Package pending states retain stable true-route geometry');
  console.log('PASS Recent Purchases, Unlisted Items, and Duplicate Variants keep background status geometry stable');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
