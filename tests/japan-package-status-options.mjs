// Japan package status simplification (Owner option A): daily choices are only 已登記 / 已點收; historical 已到小幫手家 /
// 有問題 stay stored, displayed, filterable and are never converted automatically. Isolated React harness (experimental
// provider, in-memory server, no Supabase). Port: JAPAN_PACKAGE_STATUS_TEST_PORT (default 4726). Optional OUT=<dir>.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.JAPAN_PACKAGE_STATUS_TEST_PORT || '4726';
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

const open = async (browser, route, width, status) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  const errors = []; const dialogs = []; const supabase = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('.supabase.co/')) supabase.push(request.url()); });
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void (page.__dialogAnswer === false ? dialog.dismiss() : dialog.accept()); });
  await page.goto(`${BASE_URL}?route=${encodeURIComponent(route)}${status ? `&packageStatus=${status}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().connectivity.readStatus !== 'loading');
  if (route.startsWith('/japan-packages/')) await page.getByText('快速切換：').first().waitFor();
  return { context, page, errors, dialogs, supabase };
};
const serverStatus = page => page.evaluate(() => window.__P0_REACT_HARNESS__.server.japanPackages.find(p => p.id === 'jp-react-1').status);
const statusOptions = async page => {
  const select = page.locator('select').filter({ has: page.locator('option[value="confirmed"]') }).first();
  if (!(await select.count())) await page.getByText('展開 ▼').first().click();
  return select.locator('option').allTextContents();
};
const quickButtons = page => page.locator('button').filter({ hasText: /^(已登記|已到小幫手家|已點收|有問題)$/u }).allInnerTexts();

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (const width of [1366, 390]) {
      // Daily package (registered): only the two daily quick choices; the form select offers only the two daily statuses.
      {
        const { context, page, errors, supabase } = await open(browser, '/japan-packages/jp-react-1', width);
        await page.getByTestId('japan-package-detail-root').waitFor();
        const buttons = await quickButtons(page);
        result[`daily${width}`] = { buttons };
        assert.deepEqual([...new Set(buttons)], ['已登記', '已點收']);
        const options = await statusOptions(page);
        result[`daily${width}`].options = options;
        assert.deepEqual(options, ['已登記', '已點收']);
        assert.equal(await page.getByTestId('japan-package-legacy-status-hint').count(), 0);
        if (OUT) await page.screenshot({ path: `${OUT}/status-daily-${width}.png`, clip: { x: 0, y: 0, width, height: width < 500 ? 900 : 520 } });
        assert.deepEqual(errors, []); assert.deepEqual(supabase, []);
        await context.close();
      }
      // Historical statuses: displayed as-is, hint shown, current kept selectable in the form, never converted automatically.
      for (const legacy of ['arrived', 'problem']) {
        const { context, page, errors, dialogs } = await open(browser, '/japan-packages/jp-react-1', width, legacy);
        await page.getByTestId('japan-package-detail-root').waitFor();
        const label = legacy === 'arrived' ? '已到小幫手家' : '有問題';
        const hint = norm(await page.getByTestId('japan-package-legacy-status-hint').first().innerText());
        const badge = await page.locator('.badge').filter({ hasText: label }).count();
        const options = await statusOptions(page);
        const row = { hint, badge, options, quick: [...new Set(await quickButtons(page))], storedBefore: await serverStatus(page) };
        assert.equal(row.storedBefore, legacy, 'historical status not converted on load');
        assert.ok(row.badge >= 1, 'historical status still displayed');
        assert.equal(hint, `目前為舊狀態「${label}」，請依實際情況改為已登記或已點收。`);
        assert.deepEqual(row.options, [`${label}（舊狀態）`, '已登記', '已點收']);
        assert.deepEqual(row.quick, ['已登記', '已點收']);
        if (legacy === 'problem') {
          // Leaving 有問題 needs an explicit confirmation; cancelling keeps it.
          page.__dialogAnswer = false;
          await page.locator('button').filter({ hasText: /^已點收$/u }).first().click();
          await sleep(500);
          row.afterCancel = await serverStatus(page);
          assert.equal(row.afterCancel, 'problem'); assert.equal(dialogs.length, 1); assert.match(dialogs[0], /目前為「有問題」/u);
          page.__dialogAnswer = true;
          await page.locator('button').filter({ hasText: /^已登記$/u }).first().click();
          await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.japanPackages.find(p => p.id === 'jp-react-1').status === 'registered');
          row.afterConfirm = await serverStatus(page);
          assert.equal(dialogs.length, 2);
          await page.waitForFunction(() => !document.querySelector('[data-testid="japan-package-legacy-status-hint"]'));
        } else {
          // 已到小幫手家 -> 已點收 is an ordinary explicit choice (no confirmation needed).
          await page.locator('button').filter({ hasText: /^已點收$/u }).first().click();
          await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.japanPackages.find(p => p.id === 'jp-react-1').status === 'confirmed');
          row.afterConfirm = await serverStatus(page);
          assert.equal(dialogs.length, 0);
        }
        if (OUT && width === 1366 && legacy === 'problem') await page.screenshot({ path: `${OUT}/status-after-legacy-${width}.png`, clip: { x: 0, y: 0, width, height: 520 } });
        result[`${legacy}${width}`] = row;
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
    // Legacy screenshot before any change, and the list: legacy filters only when such packages exist.
    {
      const { context, page } = await open(browser, '/japan-packages/jp-react-1', 1366, 'problem');
      await page.getByTestId('japan-package-legacy-status-hint').first().waitFor();
      if (OUT) await page.screenshot({ path: `${OUT}/status-legacy-problem-1366.png`, clip: { x: 0, y: 0, width: 1366, height: 520 } });
      await context.close();
    }
    for (const [status, expectLegacyChip] of [['registered', false], ['problem', true]]) {
      const { context, page, errors } = await open(browser, '/japan-packages', 1366, status === 'registered' ? undefined : status);
      await page.locator('.chips-row').first().waitFor();
      const chips = (await page.locator('.filter-group').filter({ hasText: '包裹狀態' }).locator('button').allInnerTexts()).map(norm);
      const stats = (await page.locator('.stat-label').allInnerTexts()).map(norm);
      result[`list-${status}`] = { chips, stats };
      assert.equal(chips.includes('有問題（舊）'), expectLegacyChip);
      assert.equal(chips.includes('已到小幫手家（舊）'), false);
      assert.equal(stats.includes('有問題（舊狀態）'), expectLegacyChip);
      if (expectLegacyChip) {
        await page.locator('.filter-group').filter({ hasText: '包裹狀態' }).getByRole('button', { name: '有問題（舊）' }).click();
        await page.getByText('React Japan Package A').first().waitFor();
        result[`list-${status}`].filterFindsLegacyPackage = true;
        if (OUT) await page.screenshot({ path: `${OUT}/status-list-legacy-1366.png`, clip: { x: 0, y: 0, width: 1366, height: 700 } });
      }
      // New package form: only daily statuses.
      const newButton = page.getByRole('button', { name: /登記新包裹/u }).first();
      assert.ok(await newButton.count(), 'new package button');
      {
        await newButton.click();
        const formOptions = await statusOptions(page);
        result[`list-${status}`].newFormOptions = formOptions;
        assert.deepEqual(formOptions, ['已登記', '已點收']);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 1));
} finally { vite.kill(); }
