// Real React page + isolated Cloud transport. No production requests/writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import { incidentRows } from './fixtures/waca-preview-incident.mjs';

const port = process.env.WACA_FILTER_TEST_PORT || '4736';
const origin = `http://127.0.0.1:${port}`;
const out = process.env.OUT;
if (out) mkdirSync(out, { recursive: true });
const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一', '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers.map(() => '訂單資訊'), headers, ...incidentRows]), 'orders');
const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1',
  '--port', port, '--strictPort', '--configLoader', 'runner'], { env: { ...process.env,
  VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential',
  VITE_DEPLOYMENT_ENV: 'staging' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; vite.stdout.on('data', c => { log += c; }); vite.stderr.on('data', c => { log += c; });
const norm = text => text.replace(/\s+/gu, ' ').trim();
let browser;
const result = {};
try {
  for (let n = 0; n < 150; n++) { try { if ((await fetch(origin)).ok) break; } catch {}
    if (n === 149 || vite.exitCode !== null) throw new Error(log); await new Promise(r => setTimeout(r, 200)); }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let externalRequests = 0;
  await context.route('https://**/*', route => { externalRequests++; return route.abort(); });
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Separate isolated uploads receive the same deterministic identity sequence and clock, so
  // request-parity also compares generated mapping provenance rather than omitting that field.
  await page.addInitScript(() => {
    let sequence = 0;
    Object.defineProperty(crypto, 'randomUUID', { value: () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` });
  });
  await page.clock.setFixedTime(new Date('2026-10-19T03:10:00Z'));
  const load = async (previewOnly = true, extra = '') => {
    await page.goto(`${origin}/tests/fixtures/waca-ui-review.html?populated=1&incident=1${previewOnly ? '&previewOnly=1' : ''}${extra}`);
    await page.waitForFunction(() => window.wacaUiFixture?.calls().reads > 0
      && document.querySelector('input[aria-label="選擇 WACA Excel"]')?.disabled === false);
    await page.getByLabel('選擇 WACA Excel').setInputFiles({ name: 'WACA-隔離重現-七項待核對.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
    await page.getByTestId('waca-review-summary').waitFor();
  };
  const summary = async () => norm(await page.getByTestId('waca-review-summary').innerText());
  const titles = () => page.locator('.waca-group-title').allInnerTexts();
  const visible = () => page.locator('[data-testid^="waca-counted-row-"]').count();
  const changed = () => page.getByLabel('只顯示有數量變化的規格', { exact: true });
  const pending = () => page.getByLabel('同時顯示需要核對的規格', { exact: true });
  await load();
  assert.equal(await changed().isChecked(), true); assert.equal(await pending().isChecked(), true);
  assert.equal(await visible(), 7); assert.equal(await page.locator('.waca-group').count(), 3);
  assert.equal(await page.getByTestId('waca-counted-row-G07654776').count(), 0, 'unimported unchanged sibling is hidden');
  assert.equal(await page.getByTestId('waca-counted-row-G07506675').count(), 0, 'unrecognized cancelled order with zero effect is not a review request');
  const originalSummary = await summary();
  assert.match(originalSummary, /^0 需要確認（項） \+8 預計增加（件） 0 預計減少（件）$/u);
  assert.match(norm(await page.getByTestId('waca-final-confirm').innerText()), /仍待核對 0 件/u);
  await page.getByTestId('waca-history-risk-notice').waitFor();
  result.initial = { summary: originalSummary, visible: await visible(), total: 34 };
  if (out) { await page.locator('.waca-review-summary').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/01-desktop-seven-specs.png`, fullPage: true }); }
  const order = await titles();
  await pending().uncheck(); assert.equal(await visible(), 7);
  assert.equal(await summary(), originalSummary, 'hiding reviews never changes the risk summary');
  await changed().uncheck(); assert.equal(await visible(), 34); assert.equal(await page.locator('.waca-group').count(), 4);
  assert.equal(await pending().isDisabled(), true); assert.equal(await summary(), originalSummary);
  if (out) { await page.locator('.waca-review-summary').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/02-desktop-all-specs.png`, fullPage: true }); }
  await changed().check(); await pending().check(); assert.equal(await visible(), 7); assert.deepEqual(await titles(), order);

  // Choosing a mode cannot hide its own control, change group order, lose focus or force a scroll.
  const baseball = page.locator('.waca-group').filter({ hasText: 'Hololive 甲子園2026' });
  const keep = baseball.getByRole('button', { name: '維持', exact: true });
  await keep.scrollIntoViewIfNeeded(); await keep.focus();
  const before = await page.evaluate(() => ({ y: scrollY, open: [...document.querySelectorAll('.waca-group[open] .waca-group-title')].map(e => e.textContent) }));
  await keep.click();
  assert.equal(await visible(), 7, 'KEEP preserves the initially reviewed specs');
  assert.deepEqual(await titles(), order); assert.equal(await keep.evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.waca-group[open] .waca-group-title')].map(e => e.textContent)), before.open);
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - before.y) <= 1, 'no forced scroll on mode switch');
  await baseball.getByRole('button', { name: '累加', exact: true }).click();
  await page.getByLabel('查看 G07654778 來源訂單').click();
  await page.getByLabel('確認訂單 AUDIT-ORDER-A').selectOption('PENDING');
  assert.match(await summary(), /^1 需要確認（項） \+7 預計增加（件） 0 預計減少（件）$/u);
  await page.getByLabel('確認訂單 AUDIT-ORDER-A').selectOption('COUNT_AS_NEW');
  assert.match(await summary(), /^0 需要確認（項） \+8 預計增加（件） 0 預計減少（件）$/u);
  assert.equal(await visible(), 7, 'a resolved pending spec stays in its original place');
  assert.deepEqual(await titles(), order);
  assert.equal(norm(await page.getByTestId('waca-counted-row-G07654778').locator('td').nth(5).innerText()), '', 'no stale pending warning after explicit confirmation');
  if (out) { await page.locator('.waca-review-summary').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/03-desktop-one-confirmed.png`, fullPage: true }); }
  await page.getByLabel('查看 G07595265 來源訂單').click();
  await page.getByLabel('確認訂單 AUDIT-ORDER-E').selectOption('COUNT_AS_NEW');
  const resolvedGroup = page.locator('.waca-group').filter({ hasText: '代理版 Pink Charm Rurudo' });
  assert.doesNotMatch(await resolvedGroup.locator('summary').innerText(), /需確認|留意/u, 'resolved group has no stale warning badge');
  assert.equal(await page.getByTestId('waca-counted-row-G07595265').count(), 1, 'resolved group stays visible/in place');
  assert.deepEqual(await titles(), order);
  await page.getByLabel('確認訂單 AUDIT-ORDER-E').selectOption('PENDING');
  await page.getByLabel('收合 G07595265 來源訂單').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const drawer = document.querySelector('.app-sidebar.mobile-hidden');
    return drawer && drawer.getBoundingClientRect().right <= 1;
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal overflow');
  if (out) { await page.locator('.waca-spec-filters').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/04-mobile-filters.png` }); }
  assert.equal((await page.evaluate(() => window.wacaUiFixture.calls())).commits, 0);
  result.modeAndScrollStable = true; result.confirmedRowStaysWithoutStaleWarning = true;

  // A mapped pending spec outside this file/group remains visible by default; unrelated no-op
  // specs are still hidden. The global risk count must survive explicitly hiding review rows.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await load(true, '&offFilePending=1');
  assert.equal(await page.getByTestId('waca-counted-row-OFF-FILE-SKU').count(), 1);
  assert.match(await page.getByTestId('waca-counted-row-OFF-FILE-SKU').innerText(), /本次未匯入（不變）/u);
  assert.match(await summary(), /^1 需要確認（項）/u);
  await pending().uncheck();
  assert.equal(await page.getByTestId('waca-counted-row-OFF-FILE-SKU').count(), 0);
  assert.match(await summary(), /^1 需要確認（項）/u);
  result.offFilePendingPreserved = true;
  await pending().check();
  await page.getByLabel('查看 OFF-FILE-SKU 來源訂單').click();
  await page.getByLabel('確認訂單 AUDIT-STORED-PENDING').selectOption('BASELINE_INCLUDED');
  assert.equal(await page.getByTestId('waca-counted-row-OFF-FILE-SKU').count(), 1, 'resolving an off-file review cannot remove its group');
  assert.equal(norm(await page.getByTestId('waca-counted-row-OFF-FILE-SKU').locator('td').nth(5).innerText()), '');
  await pending().uncheck();
  assert.equal(await page.getByTestId('waca-counted-row-OFF-FILE-SKU').count(), 1, 'explicitly edited off-file row retains its controls');
  result.offFileResolvedGroupStable = true;

  // Compare the actual client-to-provider request in two isolated runs. Filters must not change
  // orders, counted decisions, revision, epoch, mapping or the atomic plan. The deterministic
  // identity sequence/clock above also lets us compare the complete request including batches.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const committed = [];
  for (const toggle of [false, true]) {
    await load(false);
    if (toggle) { await pending().uncheck(); await changed().uncheck(); }
    assert.equal(await page.getByRole('button', { name: '確認更新', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '確認更新', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.wacaUiFixture.calls().lastCounted));
    const args = await page.evaluate(() => window.wacaUiFixture.calls().lastCounted);
    committed.push(args);
  }
  assert.deepEqual(committed[0], committed[1], 'filters cannot alter actual business request');
  assert.equal(committed[0].p_plan.restoreEpoch, 33); assert.equal(committed[0].p_expected_revision, 0);
  assert.equal(externalRequests, 0); assert.deepEqual(errors, []);
  result.actualRequestParity = true; result.externalRequests = externalRequests; result.productionWrites = 0;
  result.isolatedFixtureCommits = 2; result.errors = errors;
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 2));
} finally { await browser?.close(); vite.kill(); }
