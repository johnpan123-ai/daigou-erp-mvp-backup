// Japan package detail - mobile receiving checklist r2 (layout B) on the real React page, isolated harness (experimental provider,
// in-memory server, no Supabase). Widths 390 / 430 (+ desktop 1366 smoke). Port: JAPAN_PACKAGE_MOBILE_R2_PORT (default 4724).
// Optional OUT=<dir> saves screenshots; DESKTOP_HTML_OUT=<file> saves the desktop checklist markup for the base/r2 comparison.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.JAPAN_PACKAGE_MOBILE_R2_PORT || '4724';
const NAME = 'Hololive さくらみこ 2nd Album Blooming Cinderella 完全生產限定盤';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-p0-2-react-harness.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.OUT;
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
if (OUT) mkdirSync(OUT, { recursive: true });
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; vite.stdout.on('data', c => { output += c; }); vite.stderr.on('data', c => { output += c; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const norm = t => t.replace(/\s+/gu, ' ').trim();
const result = {};

const open = async (browser, width, isMobile) => {
  const context = await browser.newContext({ viewport: { width, height: isMobile ? 860 : 900 }, deviceScaleFactor: isMobile ? 2 : 1, isMobile, hasTouch: isMobile });
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  const errors = []; const supabase = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialogs = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.url().includes('.supabase.co/')) supabase.push(request.url()); });
  await page.goto(`${BASE_URL}?route=${encodeURIComponent('/japan-packages/jp-react-1')}&partialReceiving=1&receivingTitle=${encodeURIComponent(NAME)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().connectivity.readStatus !== 'loading');
  return { context, page, errors, supabase, dialogs };
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
    for (const width of process.env.DESKTOP_ONLY === '1' ? [] : [390, 430]) {
      const { context, page, errors, supabase, dialogs } = await open(browser, width, true);
      const group = page.locator('[data-testid^="mobile-receiving-group-"]').first();
      await group.waitFor();
      const title = group.getByTestId('mobile-receiving-group-title');
      const status = group.getByTestId('mobile-receiving-group-status');
      const geometry = await group.evaluate(element => {
        const titleEl = element.querySelector('[data-testid="mobile-receiving-group-title"]');
        const icon = titleEl.previousElementSibling.getBoundingClientRect();
        const rects = [...(() => { const r = document.createRange(); r.selectNodeContents(titleEl); return r.getClientRects(); })()];
        const copy = element.querySelector('[data-testid^="copy-japan-package-group-"]').getBoundingClientRect();
        const copyIcon = element.querySelector('[data-testid^="copy-japan-package-group-"] svg').getBoundingClientRect();
        return { text: titleEl.textContent, fontSize: Number(titleEl.dataset.fontSize), lines: new Set(rects.map(r => Math.round(r.top))).size,
          minTextLeft: Math.min(...rects.map(r => r.left)), iconRight: icon.right, clipped: titleEl.scrollWidth > titleEl.clientWidth + 1,
          copy: [Math.round(copy.width), Math.round(copy.height)], copyIcon: [Math.round(copyIcon.width), Math.round(copyIcon.height)],
          pageOverflow: document.documentElement.scrollWidth > innerWidth };
      });
      const collapsedStatus = norm(await status.innerText());
      const row = { geometry, collapsedStatus };
      assert.equal(geometry.text, NAME, 'full product name, never truncated');
      assert.ok(geometry.fontSize >= 13 && geometry.fontSize <= 16, `font size ${geometry.fontSize}`);
      assert.ok(geometry.minTextLeft >= geometry.iconRight, 'name never wraps under the package icon');
      assert.equal(geometry.clipped, false); assert.equal(geometry.pageOverflow, false);
      assert.ok(geometry.copy[0] >= 44 && geometry.copy[1] >= 44, 'copy touch target >= 44px');
      assert.ok(geometry.copyIcon[0] <= 20, 'copy shows a small icon only');
      assert.equal(collapsedStatus, '0/2 筆｜0/6 件 未點收');
      if (OUT) await page.screenshot({ path: `${OUT}/m${width}-1-collapsed.png` });
      // Copy never toggles the card.
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await group.locator('[data-testid^="copy-japan-package-group-"]').click();
      assert.equal(await group.getAttribute('aria-expanded') ?? await group.locator('[aria-expanded]').first().getAttribute('aria-expanded'), 'false');
      // Expand: every source row keeps its full name; date・batch is secondary.
      await title.click();
      await group.getByTestId('mobile-receiving-source-row').first().waitFor();
      const itemNames = await group.getByTestId('mobile-receiving-item-name').allInnerTexts();
      const sources = await group.getByTestId('mobile-receiving-item-source').allInnerTexts();
      const quantities = await group.getByTestId('mobile-receiving-item-quantity').allInnerTexts();
      row.expanded = { itemNames: itemNames.map(norm), sources: sources.map(norm), quantities };
      assert.equal(itemNames.length, 2);
      assert.deepEqual(quantities, ['×4', '×2']);
      assert.ok(sources.every(s => /2026-09-07・React Batch A/u.test(s)), JSON.stringify(sources));
      if (OUT) await page.screenshot({ path: `${OUT}/m${width}-2-expanded.png`, fullPage: true });
      // Check one record -> partial; group 點收剩餘 -> complete; 取消全部 -> none. Same save path (transaction calls).
      const before = (await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot())).japanPackageTransactionCalls ?? 0;
      await group.getByTestId('mobile-receiving-source-row').first().click();
      await page.waitForFunction(() => document.querySelector('[data-testid="mobile-receiving-group-status"]')?.dataset.status === 'partial');
      const s = norm(await status.innerText());
      row.partial = s;
      assert.equal(s, '1/2 筆｜4/6 件 部分完成');
      if (OUT) await page.screenshot({ path: `${OUT}/m${width}-3-partial.png`, fullPage: true });
      await group.getByRole('button', { name: '點收剩餘' }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="mobile-receiving-group-status"]')?.dataset.status === 'complete');
      row.complete = norm(await status.innerText());
      assert.equal(row.complete, '2/2 筆｜6/6 件 已完成');
      if (OUT) await page.screenshot({ path: `${OUT}/m${width}-4-complete.png`, fullPage: true });
      await group.getByRole('button', { name: '取消全部' }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="mobile-receiving-group-status"]')?.dataset.status === 'none');
      row.cleared = norm(await status.innerText());
      assert.equal(row.cleared, '0/2 筆｜0/6 件 未點收');
      const harness = await page.evaluate(() => {
        const snap = window.__P0_REACT_HARNESS__.snapshot();
        return { calls: snap.japanPackageTransactionCalls ?? 0,
          items: window.__P0_REACT_HARNESS__.server.japanPackageItems.filter(i => i.japan_package_id === 'jp-react-1').map(i => [i.id, i.checked, i.quantity, i.sku, i.purchase_batch_item_id]) };
      });
      row.confirmDialogs = dialogs.length; assert.equal(dialogs.length, 2, 'existing group confirm dialog kept');
      row.saves = harness.calls - before; row.serverItems = harness.items;
      assert.ok(row.saves >= 3, `receiving changes go through the existing transaction path (${row.saves})`);
      assert.deepEqual(harness.items.map(i => [i[0], i[1], i[2], i[3], i[4]]), [['jpi-react-1', false, 4, 'SKU-HOLO', 'bi-holo'], ['jpi-react-2', false, 2, 'SKU-HOLO-B', 'bi-react-2']], 'SKU / quantity / batch link unchanged');
      assert.deepEqual(supabase, [], 'no Supabase request'); assert.deepEqual(errors, []);
      result[`w${width}`] = row;
      await context.close();
    }
    // Desktop 1366: no mobile receiving markup; desktop header kept (markup can be compared with the base build).
    const { context, page, errors } = await open(browser, 1366, false);
    await page.getByTestId('japan-package-detail-root').waitFor();
    await page.waitForTimeout(500);
    result.desktop = { mobileGroups: await page.locator('[data-testid^="mobile-receiving-group-"]').count(),
      headerMain: await page.locator('.checklist-group-header-main').count() };
    assert.equal(result.desktop.mobileGroups, 0); assert.ok(result.desktop.headerMain >= 1);
    if (process.env.DESKTOP_HTML_OUT) writeFileSync(process.env.DESKTOP_HTML_OUT, await page.getByTestId('japan-package-detail-root').evaluate(e => e.innerHTML.replace(/\s+/gu, ' ')));
    if (OUT) await page.screenshot({ path: `${OUT}/d1366.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 1));
} finally { vite.kill(); }
