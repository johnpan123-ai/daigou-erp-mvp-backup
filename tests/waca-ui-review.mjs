// Owner UI review for the WACA counted preview UI v3 (isolated fixture, no network, nothing written).
// Scenario 1 (daily=1): everyday import after the takeover. Scenario 2 (history=1): first takeover.
// Optional OUT=<dir> saves desktop/mobile screenshots. Port: WACA_UI_REVIEW_PORT (default 4722).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
const port = process.env.WACA_UI_REVIEW_PORT || '4722'; const origin = `http://127.0.0.1:${port}`; const out = process.env.OUT;
if (out) mkdirSync(out, { recursive: true });
const shot = (page, name, opts = { fullPage: true }) => out ? page.screenshot({ path: `${out}/${name}`, ...opts }) : null;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', port, '--strictPort', '--configLoader', 'runner'],
  { env: { ...process.env, VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential', VITE_DEPLOYMENT_ENV: 'staging' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; vite.stdout.on('data', c => { log += c; }); vite.stderr.on('data', c => { log += c; });
const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一', '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
const A = '【小河馬日本代購】 預購 27年02月 代理版 GSC 換裝玩偶 BanG Dream! Morfonica';
const B = '【小河馬日本代購】 預購 26年12月 Hololive English 活動2周年記念 旋轉壓克力立牌';
const C = '【小河馬日本代購】 預購 27年01月 GSC 黏土人 Hakos Baelz';
const rows = [
  ['完成付款', 'W2509300001', '2026/09/30 10:00', 'GP-A', A, '倉田真白', '', 'G10', 2, 200],
  ['取消', 'W2610170101', '2026/10/17 09:00', 'GP-A', A, '桐ヶ谷透子', '', 'G11', 1, 100],
  ['處理中', 'W2610170102', '2026/10/17 09:30', 'GP-A', A, '広町七深', '', 'G12', 1, 100],
  ['取消', 'W349FB2610172023', '2026/10/17 20:23', 'GP-B', B, 'Cecilia Immergreen', '', 'G20', 1, 100],
  ['完成付款', 'W2610180201', '2026/10/18 08:00', 'GP-B', B, 'Cecilia Immergreen', '', 'G20', 2, 200],
  ['完成付款', 'W2610180202', '2026/10/18 08:10', 'GP-B', B, 'Gigi Murin', '', 'G21', 1, 100],
  ['取消', 'W2509250401', '2026/09/25 15:00', 'GP-B', B, 'Gigi Murin', '', 'G21', 1, 100],
  ['完成付款', 'W2509200301', '2026/09/20 12:00', 'GP-C', C, '標準版', '', 'G30', 6, 600],
];
const sheet = XLSX.utils.aoa_to_sheet([headers.map(() => '訂單資訊'), headers, ...rows]);
const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'orders');
const xlsx = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
if (process.env.XLSX_OUT) XLSX.writeFile(book, process.env.XLSX_OUT);
const norm = t => t.replace(/\s+/gu, ' ').trim();
let browser; const result = {};
try {
  for (let n = 0; n < 150; n++) { try { if ((await fetch(origin)).ok) break; } catch {} if (n === 149) throw new Error(log); await new Promise(r => setTimeout(r, 200)); }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.route('https://**/*', route => route.abort());
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const open = async query => {
    await page.goto(`${origin}/tests/fixtures/waca-ui-review.html?${query}`);
    await page.waitForFunction(() => window.wacaUiFixture?.calls().reads > 0 && !document.body.textContent.includes('正在讀取 WACA 訂單資料'));
    await page.waitForFunction(() => document.querySelector('input[aria-label="選擇 WACA Excel"]')?.disabled === false);
    await page.getByLabel('選擇 WACA Excel').setInputFiles({ name: 'waca-orders-review.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx });
    await page.getByTestId('waca-review-summary').waitFor();
  };
  const titles = () => page.locator('.waca-group-title').allInnerTexts();
  const cells = async sku => (await page.getByTestId(`waca-counted-row-${sku}`).locator('td').allInnerTexts()).map(norm);
  const brief = async sku => { const c = await cells(sku); return [c[1], c[2], c[3], c[5]]; }; // current, after, diff, flags
  const summary = async () => norm(await page.getByTestId('waca-review-summary').innerText());
  const group = text => page.locator('.waca-group').filter({ hasText: text });
  const state = async text => norm(await group(text).getByTestId('waca-group-mode-state').innerText());

  // ===== Scenario 1: daily import after the takeover =====
  await open('populated=1&daily=1');
  const order0 = await titles(); result.order = order0;
  result.summary = await summary();
  result.filterButtons = (await page.locator('.waca-review-filter button').allInnerTexts()).map(norm);
  result.filterPressed = norm(await page.locator('.waca-review-filter button[aria-pressed="true"]').innerText());
  result.openGroups = await page.locator('.waca-group[open] .waca-group-title').allInnerTexts();
  result.groupARows = await group('Morfonica').locator('[data-testid^="waca-counted-row-"]').count();
  result.default = { G10: await brief('G10'), G11: await brief('G11'), G12: await brief('G12'), G21: await brief('G21') };
  result.defaultStates = [await state('Morfonica'), await state('Hololive')];
  assert.deepEqual(order0.length, 2, 'TODO filter shows the two needs-review groups');
  assert.match(result.summary, /^2 需要確認（項） \+4 預計增加（件） −1 預計減少（件）$/u);
  assert.deepEqual(result.filterButtons, ['待處理 2', '全部商品 3', '無需處理 1']); assert.equal(result.filterPressed, '待處理 2');
  assert.equal(result.openGroups.length, 2, 'needs-review groups open on a new preview'); assert.equal(result.groupARows, 3, 'all specs of an open group');
  // Default 累加 (Owner decision 2026-10-18).
  assert.deepEqual(result.default.G10, ['10', '10', '±0', 'ERP1 歷史訂單異動 1 筆']);
  assert.deepEqual(result.default.G11, ['4', '3', '−1', '取消回沖 −1'], 'recognized cancelled order rolls back exactly once');
  assert.deepEqual(result.default.G12, ['0', '1', '+1', '']); assert.deepEqual(result.default.G21, ['1', '2', '+1', 'ERP1 歷史訂單異動 1 筆']);
  assert.deepEqual(result.defaultStates, ['目前：累加', '目前：累加']);
  assert.equal(await page.getByRole('button', { name: '確認更新' }).isDisabled(), false, 'default accumulate has no risky overwrite');
  await shot(page, '01-desktop-default.png');

  // Group A: whole group 覆蓋 (stability: same order, same scroll, same open groups, focus kept).
  await group('Morfonica').scrollIntoViewIfNeeded(); await page.evaluate(() => scrollBy(0, 60)); await page.waitForTimeout(200);
  const scrollBefore = await page.evaluate(() => scrollY); const openBefore = await page.locator('.waca-group[open]').count();
  const overwriteA = group('Morfonica').getByRole('button', { name: '覆蓋', exact: true });
  await overwriteA.focus(); await overwriteA.click(); await page.waitForTimeout(250);
  result.stability = { sameOrder: JSON.stringify(await titles()) === JSON.stringify(order0), scrollBefore, scrollAfter: await page.evaluate(() => scrollY),
    openBefore, openAfter: await page.locator('.waca-group[open]').count(),
    focus: await page.evaluate(() => document.activeElement?.textContent === '覆蓋' && document.activeElement?.getAttribute('aria-pressed') === 'true') };
  result.overwrite = { G10: await brief('G10'), G11: await brief('G11'), G12: await brief('G12'), state: await state('Morfonica') };
  assert.deepEqual(result.stability, { ...result.stability, sameOrder: true, scrollAfter: scrollBefore, openAfter: openBefore, focus: true });
  assert.deepEqual(result.overwrite.G10, ['10', '2', '−8', '覆蓋會減少']); assert.deepEqual(result.overwrite.G11, ['4', '0', '−4', '覆蓋會減少']);
  assert.deepEqual(result.overwrite.G12, ['0', '1', '+1', '']); assert.equal(result.overwrite.state, '目前：覆蓋');
  assert.equal(await page.getByRole('button', { name: '確認更新' }).isDisabled(), true, 'overwrite decrease blocks confirmation until acknowledged');
  assert.equal(await group('Morfonica').count(), 1, 'a group never closes or hides by itself');
  await shot(page, '02-desktop-group-overwrite.png');

  // Mixed: one spec back to 累加.
  await page.getByLabel('更新方式 G11').selectOption('ACCUMULATE');
  result.mixed = { state: await state('Morfonica'), badge: norm(await group('Morfonica').getByTestId('waca-group-mode-badge').innerText()),
    pressed: await group('Morfonica').locator('.waca-group-mode button[aria-pressed="true"]').count(), G11: await brief('G11'),
    sameOrder: JSON.stringify(await titles()) === JSON.stringify(order0) };
  assert.deepEqual(result.mixed, { state: '目前：混合設定（各規格不同）', badge: '混合設定', pressed: 0, G11: ['4', '3', '−1', '取消回沖 −1'], sameOrder: true });
  await group('Morfonica').scrollIntoViewIfNeeded();
  await shot(page, '03-desktop-group-mixed.png', {});
  await group('Morfonica').getByRole('button', { name: '累加', exact: true }).click();
  assert.equal(await state('Morfonica'), '目前：累加');

  // Order detail: G11 (ERP2-recognized order cancelled -> rollback) and G21 (ERP1-history order cancelled -> manual).
  await page.getByLabel('查看 G11 來源訂單').click(); await page.getByLabel('查看 G21 來源訂單').click();
  const traceRow = async number => (await page.locator('.waca-trace-table tr', { hasText: number }).first().locator('td').allInnerTexts()).map(norm);
  result.detail = { calcG11: norm(await page.getByTestId('waca-calc-G11').innerText()), W2610170101: await traceRow('W2610170101'),
    W2509250401: await traceRow('W2509250401'), W2610180202: await traceRow('W2610180202'), G21: await brief('G21') };
  assert.match(result.detail.calcG11, /目前 4 來源訂單合計 0 件 本次實際計入 -1 已認列訂單取消回沖 −1 件 累加後 3（−1）/u);
  assert.deepEqual(result.detail.W2610170101.slice(1, 6), ['2026/10/17 09:00', '1', '0', '新訂單', '已取消｜不計入數量 原已認列 1 件，自動回沖 −1']);
  assert.deepEqual(result.detail.W2509250401.slice(2, 6), ['1', '0', 'ERP1 歷史／接管前', '已取消｜不計入數量 含在 ERP1 歷史，未自動扣除，需人工核對']);
  assert.match(result.detail.W2610180202[5], /^已計入 接管後新訂單$/u); assert.deepEqual(result.detail.G21, ['1', '2', '+1', 'ERP1 歷史訂單異動 1 筆']);
  assert.doesNotMatch(result.detail.W2610170101.join(' '), /已計入|覆蓋計入/u, 'no "counted" wording on a cancelled order');
  await group('Hololive').scrollIntoViewIfNeeded(); await page.waitForTimeout(150);
  await shot(page, '04-desktop-order-detail-cancelled.png', {});

  // Filters only change on the Owner's click; open state is kept across filters.
  await page.locator('.waca-review-filter').getByRole('button', { name: /^無需處理/u }).click();
  result.filterDone = await titles();
  await page.locator('.waca-review-filter').getByRole('button', { name: /^全部商品/u }).click();
  result.filterAll = (await titles()).length; result.openInAll = await page.locator('.waca-group[open]').count();
  await page.locator('.waca-review-filter').getByRole('button', { name: /^待處理/u }).click();
  assert.deepEqual(result.filterDone, ['GSC 黏土人 Hakos Baelz']); assert.equal(result.filterAll, 3); assert.equal(result.openInAll, 2, 'others stay collapsed');
  assert.deepEqual(await titles(), order0);

  // Final confirmation (not submitted): G10 back to 覆蓋 -> decrease must be acknowledged.
  await page.getByLabel('更新方式 G10').selectOption('OVERWRITE');
  const final = page.getByTestId('waca-final-confirm'); await final.scrollIntoViewIfNeeded();
  result.final = norm(await final.innerText());
  result.finalDisabled = await page.getByRole('button', { name: '確認更新' }).isDisabled();
  assert.match(result.final, /本次增加 \+4 件（3 個規格） 本次減少 −9 件（2 個規格）/u);
  assert.match(result.final, /ERP1 歷史訂單異動 1 個規格：不會自動扣除/u);
  assert.match(result.final, /以下數量會減少（含 ERP1 歷史數量） 代理版 GSC 換裝玩偶 BanG Dream! Morfonica｜倉田真白 10 → 2（−8）覆蓋 .*桐ヶ谷透子 4 → 3（−1）累加/u);
  assert.match(result.final, /整批一次寫入，不會只寫一部分/u); assert.ok(result.finalDisabled, 'acknowledgement still required');
  await page.evaluate(() => scrollBy(0, 200));
  await shot(page, '05-desktop-final-confirm.png', {});
  result.commitsDaily = (await page.evaluate(() => window.wacaUiFixture.calls())).countedCommits ?? 0;

  // Mobile: basic, no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  result.mobileNoOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await page.waitForTimeout(800);
  await page.locator('.waca-review-summary').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, '07-mobile.png', {});
  await page.setViewportSize({ width: 1440, height: 900 });

  // ===== Scenario 2: first takeover (ERP1 history, no baseline yet) =====
  await open('populated=1&history=1');
  result.firstSummary = await summary();
  result.firstG30Default = await brief('G30');
  assert.deepEqual(result.firstG30Default, ['6', '6', '±0', '接管前訂單 1 筆待確認待核對 6 件'], 'first takeover, default 累加: unproven history stays pending');
  assert.equal(await page.getByTestId('waca-overwrite-ack').count(), 0);
  // Owner chooses 覆蓋 for every group -> first-takeover protection is unchanged.
  for (const g of await page.locator('.waca-group').all()) await g.getByRole('button', { name: '覆蓋', exact: true }).click();
  result.firstG30 = await brief('G30');
  const final2 = page.getByTestId('waca-final-confirm'); await final2.scrollIntoViewIfNeeded();
  result.firstFinal = norm(await final2.innerText());
  assert.match(result.firstFinal, /首次接管覆蓋 6 個規格：需勾選下方確認/u); assert.match(result.firstFinal, /我已確認：以「覆蓋」更新的 6 個規格（尚未建立接管基準）/u);
  assert.deepEqual(result.firstG30, ['6', '6', '±0', '首次接管覆蓋（數量不變）']);
  await page.evaluate(() => scrollBy(0, 200));
  await shot(page, '06-desktop-final-confirm-first-takeover.png', {});
  result.errors = errors; result.commits = (await page.evaluate(() => window.wacaUiFixture.calls())).countedCommits ?? 0;
  assert.ok(result.mobileNoOverflow, 'no horizontal overflow at 390'); assert.deepEqual(result.errors, []);
  assert.equal(result.commitsDaily + result.commits, 0, 'preview writes nothing');
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 1));
} finally { await browser?.close(); vite.kill(); }
