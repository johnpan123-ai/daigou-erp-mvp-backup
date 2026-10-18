// WACA transition import UI (073 counted contract) on the real WacaIntegration page with an isolated
// synthetic Cloud transport (no network). ERP1-style history: G10 = 10, G2 = 3, ORDER_REBASELINE_REQUIRED,
// Restore epoch 5 at 2026-10-16T02:20:45Z. Verifies default OVERWRITE is flagged and blocks confirmation,
// per-variant / per-order choices change the projection, and the RPC receives exactly the reviewed plan.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';

// The legacy Cloud quantity path (first cutover zeroes waca_manual_adjustment) is refused at the provider.
const providerSource = readFileSync('src/providers/dataProvider.ts', 'utf8');
assert.match(providerSource, /if \(updateAutoQuantity\) throw new Error\('WACA_LEGACY_QUANTITY_COMMIT_DISABLED'\);/u);
assert.doesNotMatch(readFileSync('src/pages/WacaIntegration.tsx', 'utf8'), /commitWacaSnapshot\(/u);

const origin = 'http://127.0.0.1:4396';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging',
  '--host', '127.0.0.1', '--port', '4396', '--strictPort', '--configLoader', 'runner'],
{ env: { ...process.env, VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential', VITE_DEPLOYMENT_ENV: 'staging' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += chunk; });
vite.stderr.on('data', chunk => { output += chunk; });
let browser;
try {
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (n === 99 || vite.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('https://**/*', route => route.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/tests/fixtures/waca-cloud-ui-parity.html?populated=1&history=1`);
  await page.waitForFunction(() => window.wacaUiFixture?.calls().reads > 0 && !document.body.textContent.includes('正在讀取 WACA 訂單資料'));
  await page.getByTestId('waca-transition-notice').waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="選擇 WACA Excel"]')?.disabled === false);
  const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一', '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
  const title = '【小河馬日本代購】 預購 27年02月 代理版 GSC 換裝玩偶 BanG Dream! Morfonica';
  const sheet = XLSX.utils.aoa_to_sheet([headers.map(() => '訂單資訊'), headers,
    ['完成付款', 'ORDER-OLD', '2026/09/30 10:00', 'GP-A', title, '規格10', '', 'G10', 2, 200],
    ['完成付款', 'ORDER-NEW', '2026/10/17 09:00', 'GP-A', title, '規格2', '', 'G2', 2, 200]]);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'orders');
  await page.getByLabel('選擇 WACA Excel').setInputFiles({ name: 'transition.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
  await page.getByTestId('waca-counted-summary').waitFor();
  assert.equal(await page.locator('.waca-group[open]').count(), 1, 'UI v3: a needs-review group opens on a new preview');
  const cells = async sku => (await page.getByTestId(`waca-counted-row-${sku}`).locator('td').allInnerTexts()).map(t => t.replace(/\s+/gu, ' ').trim());
  // UI v3 row: [規格, 目前, 更新後, 差異, 更新方式, 需確認, 來源訂單]; source / counted detail lives in the expansion.
  // Default 累加 (Owner decision 2026-10-18): the old-dated order is uncertain (not counted), the new one adds 2.
  let g10 = await cells('G10'), g2 = await cells('G2');
  assert.equal(await page.getByLabel('更新方式 G10').inputValue(), 'ACCUMULATE'); assert.equal(await page.getByLabel('更新方式 G2').inputValue(), 'ACCUMULATE');
  assert.deepEqual([g10[1], g10[2], g10[3]], ['10', '10', '±0']); assert.match(g10[5], /接管前訂單 1 筆待確認/u); assert.match(g10[5], /待核對 2 件/u);
  assert.deepEqual([g2[1], g2[2], g2[3]], ['3', '5', '+2']);
  await page.getByLabel('查看 G2 來源訂單').click();
  assert.match((await page.getByTestId('waca-calc-G2').innerText()).replace(/\s+/gu, ' '), /目前 3 來源訂單合計 2 件 本次實際計入 \+2 接管後新訂單 2 件 累加後 5（\+2）/u);
  await page.getByLabel('收合 G2 來源訂單').click();
  assert.equal(await page.getByTestId('waca-overwrite-ack').count(), 0, 'no risky overwrite by default');
  assert.equal(await page.getByRole('button', { name: '確認更新' }).isDisabled(), false, 'default accumulate needs no overwrite acknowledgement');
  // 覆蓋 (manual): 10 -> 2 and 3 -> 2 are flagged; confirmation is blocked until acknowledged (protection unchanged).
  await page.getByLabel('更新方式 G10').selectOption('OVERWRITE');
  await page.getByLabel('更新方式 G2').selectOption('OVERWRITE');
  g10 = await cells('G10'); g2 = await cells('G2');
  assert.deepEqual([g10[1], g10[2], g10[3], g10[5]], ['10', '2', '−8', '覆蓋會減少']);
  assert.deepEqual([g2[1], g2[2], g2[3], g2[5]], ['3', '2', '−1', '覆蓋會減少']);
  assert.equal(await page.getByRole('button', { name: '確認更新' }).isDisabled(), true, 'risky overwrite blocks confirmation');
  await page.getByTestId('waca-overwrite-ack').waitFor();
  // Back to 累加 for both (the Owner choice is kept, never silently reset).
  await page.getByLabel('更新方式 G10').selectOption('ACCUMULATE');
  await page.getByLabel('更新方式 G2').selectOption('ACCUMULATE');
  g10 = await cells('G10'); g2 = await cells('G2');
  assert.equal(g10[2], '10'); assert.equal(g2[2], '5'); assert.equal(g2[3], '+2');
  assert.equal(await page.getByRole('button', { name: '確認更新' }).isDisabled(), false, 'no risky overwrite left');
  // Per-order decision: the old-dated order is confirmed as a new order -> 12.
  await page.getByLabel('查看 G10 來源訂單').click();
  await page.getByLabel('確認訂單 ORDER-OLD').selectOption('COUNT_AS_NEW');
  g10 = await cells('G10'); assert.equal(g10[2], '12');
  // KEEP preview check on G2 then back to ACCUMULATE (choice must affect the projection, not only the label).
  await page.getByLabel('更新方式 G2').selectOption('KEEP');
  g2 = await cells('G2'); assert.equal(g2[2], '3'); assert.match(g2[5], /待核對 2 件/u);
  await page.getByLabel('更新方式 G2').selectOption('ACCUMULATE');
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  assert.equal((await page.evaluate(() => window.wacaUiFixture.calls())).commits ?? 0, 0, 'preview writes nothing');
  await page.getByRole('button', { name: '確認更新' }).click();
  await page.waitForFunction(() => window.wacaUiFixture.calls().lastCounted || document.querySelector('.waca-error'));
  const calls = await page.evaluate(() => window.wacaUiFixture.calls());
  assert.equal(calls.countedCommits, 1); assert.equal(await page.locator('.waca-error').count(), 0, await page.locator('.waca-page').innerText());
  const plan = calls.lastCounted.p_plan;
  assert.equal(plan.contract, 'waca-counted-import-v1'); assert.equal(plan.restoreEpoch, 5); assert.deepEqual(plan.overwriteVariantIds, []);
  assert.deepEqual(plan.expectedDisplay, { 'variant-10': { before: 10, after: 12 }, 'variant-2': { before: 3, after: 5 } });
  const items = Object.fromEntries(calls.lastCounted.p_snapshot.items.map(i => [i.orderKey, [i.countedQuantity, i.countedReason]]));
  assert.deepEqual(items, { 'WACA::ORDER-OLD': [2, 'OWNER_CONFIRMED_NEW'], 'WACA::ORDER-NEW': [2, 'NEW_AFTER_BASELINE'] });
  await page.waitForFunction(() => /本次新計入 4 件/u.test(document.body.innerText) || document.querySelector('.waca-error'), null, { timeout: 15000 }).catch(() => {});
  // The fixture has no realtime sync provider: the existing post-commit targeted refresh is the only step it
  // cannot run. Everything before it (commit, receipt, reconciliation, preview equality) must have passed.
  const failure = await page.locator('.waca-error').count()
    ? (await page.locator('.waca-error details summary').click(), await page.locator('.waca-error').innerText()) : '';
  assert.ok(!failure || /WACA_TARGETED_REFRESH_UNAVAILABLE/u.test(failure), failure);
  const after = Object.fromEntries((await page.evaluate(() => window.wacaUiFixture.variants())).map(v => [v.myacg_item_code, [v.waca_auto_quantity, v.waca_manual_adjustment]]));
  assert.deepEqual(after, { G10: [2, 10], G2: [2, 3], G1: [0, 0] }, 'display G10 12, G2 5, history kept in manual');
  const savedState = (await page.evaluate(() => window.wacaUiFixture.snapshot())).cutoverState;
  assert.equal(savedState.mode, 'ORDER_DRIVEN_ACTIVE');
  await page.getByRole('button', { name: '重新讀取' }).click();
  await page.getByTestId('waca-transition-baseline').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', defaultAccumulate: true, manualOverwriteFlagged: true, confirmBlockedUntilAck: true,
    accumulate: 'G10 10 (1 uncertain pending), G2 3->5', ownerConfirmedOrder: 'G10 -> 12', keepPreview: 'G2 stays 3',
    rpcPlan: plan.expectedDisplay, countedItems: items, noOverflow: [1366, 390] }));
} finally { await browser?.close(); vite.kill(); }
