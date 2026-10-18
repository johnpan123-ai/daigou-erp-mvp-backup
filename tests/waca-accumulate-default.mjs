// WACA UI v3 default 累加 (Owner decision 2026-10-18) on the real WacaIntegration page, isolated fixture (daily=1:
// takeover done, baseline = Restore 5 at 2026-10-16T02:20:45Z, ledger: W2509300001 G10 ERP1 history, W2509250401 G21 ERP1
// history, W2610170101 G11 counted by ERP2). Scenarios A-I of the work order, two commits through the reviewed client path
// (the fixture emulates the 073 RPC outcome; the real 073 RPC is covered by waca-counted-transition on isolated PostgreSQL).
// Port: WACA_ACCUMULATE_TEST_PORT (default 4723). No network; nothing outside the in-memory fixture is written.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
const port = process.env.WACA_ACCUMULATE_TEST_PORT || '4723'; const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', port, '--strictPort', '--configLoader', 'runner'],
  { env: { ...process.env, VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential', VITE_DEPLOYMENT_ENV: 'staging' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; vite.stdout.on('data', c => { log += c; }); vite.stderr.on('data', c => { log += c; });
const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一', '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
const A = '【小河馬日本代購】 預購 27年02月 代理版 GSC 換裝玩偶 BanG Dream! Morfonica';
const B = '【小河馬日本代購】 預購 26年12月 Hololive English 活動2周年記念 旋轉壓克力立牌';
const book = rows => { const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, XLSX.utils.aoa_to_sheet([headers.map(() => '訂單資訊'), headers, ...rows]), 'orders'); return XLSX.write(b, { type: 'buffer', bookType: 'xlsx' }); };
const base = [
  ['完成付款', 'W2509300001', '2026/09/30 10:00', 'GP-A', A, '倉田真白', '', 'G10', 1, 100],          // E: ERP1 history, unchanged
  ['完成付款', 'W2610190001', '2026/10/19 10:00', 'GP-A', A, '倉田真白', '', 'G10', 2, 200],          // A: new valid order +2
  ['完成付款', 'W2510010001', '2026/10/01 12:00', 'GP-A', A, '桐ヶ谷透子', '', 'G11', 1, 100],        // I: pre-takeover, unproven -> pending
  ['完成付款', 'W2610170101', '2026/10/17 09:00', 'GP-A', A, '桐ヶ谷透子', '', 'G11', 1, 100],        // counted by ERP2, unchanged
  ['完成付款', 'W2610190002', '2026/10/19 11:00', 'GP-B', B, 'Cecilia Immergreen', '', 'G20', 3, 300], // G/H: new order for KEEP check
  ['取消', 'W2509250401', '2026/09/25 15:00', 'GP-B', B, 'Gigi Murin', '', 'G21', 1, 100],             // F: ERP1 history cancelled
];
const norm = t => t.replace(/\s+/gu, ' ').trim();
let browser; const result = {};
try {
  for (let n = 0; n < 150; n++) { try { if ((await fetch(origin)).ok) break; } catch {} if (n === 149) throw new Error(log); await new Promise(r => setTimeout(r, 200)); }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('https://**/*', route => route.abort());
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/tests/fixtures/waca-ui-review.html?populated=1&daily=1&persist=1`);
  const ready = async () => {
    await page.waitForFunction(() => window.wacaUiFixture?.calls().reads > 0 && !document.body.textContent.includes('正在讀取 WACA 訂單資料'));
    await page.waitForFunction(() => document.querySelector('input[aria-label="選擇 WACA Excel"]')?.disabled === false);
  };
  const upload = async (name, rows) => {
    await ready();
    await page.getByLabel('選擇 WACA Excel').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: book(rows) });
    await page.getByRole('heading', { name: `匯入預覽：${name}` }).waitFor();
    await page.getByTestId('waca-review-summary').waitFor();
    await page.locator('.waca-review-filter').getByRole('button', { name: /^全部商品/u }).click();
    for (const s of await page.locator('.waca-group:not([open]) > summary').all()) await s.click();
  };
  const row = async sku => { const c = (await page.getByTestId(`waca-counted-row-${sku}`).locator('td').allInnerTexts()).map(norm); return [c[1], c[2], c[3], c[5]]; };
  const mode = sku => page.getByLabel(`更新方式 ${sku}`).inputValue();
  const commit = async () => {
    const before = (await page.evaluate(() => window.wacaUiFixture.calls())).countedCommits ?? 0;
    assert.equal(await page.getByRole('button', { name: '確認更新' }).isDisabled(), false);
    await page.getByRole('button', { name: '確認更新' }).click();
    await page.waitForFunction(n => (window.wacaUiFixture.calls().countedCommits ?? 0) > n || document.querySelector('.waca-error'), before);
    const calls = await page.evaluate(() => window.wacaUiFixture.calls());
    assert.equal(calls.countedCommits, before + 1, await page.locator('.waca-page').innerText());
    // The fixture has no realtime sync provider (post-commit targeted refresh may report that): reload the tab; the
    // emulated cloud state is kept by the fixture (persist=1).
    await page.waitForTimeout(500);
    await page.reload(); await ready();
    return calls.lastCounted;
  };

  // ---- Import 1: defaults, A, E, F, G, H, I ----
  await upload('waca-1.xlsx', base);
  result.defaults = await Promise.all(['G10', 'G11', 'G12', 'G20', 'G21', 'G30'].map(sku => page.getByLabel(`更新方式 ${sku}`).count().then(n => n ? mode(sku) : 'NOT_IMPORTED')));
  assert.deepEqual(result.defaults, ['ACCUMULATE', 'ACCUMULATE', 'NOT_IMPORTED', 'ACCUMULATE', 'ACCUMULATE', 'NOT_IMPORTED'], 'every imported spec starts as 累加');
  result.A_E = await row('G10'); assert.deepEqual(result.A_E, ['10', '12', '+2', ''], 'A: 10 -> 12; E: the ERP1-history order is not added again');
  result.I = await row('G11'); assert.deepEqual(result.I, ['4', '4', '±0', '接管前訂單 1 筆待確認待核對 1 件'], 'I: unproven pre-takeover order stays pending, not added');
  result.F = await row('G21'); assert.deepEqual(result.F, ['1', '1', '±0', 'ERP1 歷史訂單異動 1 筆'], 'F: ERP1-history cancellation is flagged, never deducted');
  result.G_default = await row('G20'); assert.deepEqual(result.G_default, ['2', '5', '+3', '']);
  await page.getByLabel('更新方式 G20').selectOption('KEEP');
  result.G = await row('G20'); assert.deepEqual(result.G, ['2', '2', '±0', '待核對 3 件本次暫不更新'], 'G: 維持 keeps the quantity although the source added 3');
  await page.getByLabel('更新方式 G10').selectOption('OVERWRITE');
  result.H = await row('G10'); assert.deepEqual(result.H, ['10', '3', '−7', '覆蓋會減少'], 'H: 覆蓋 = source result (1 + 2), decrease flagged');
  assert.equal(await page.getByRole('button', { name: '確認更新' }).isDisabled(), true, 'H: overwrite decrease still needs the acknowledgement');
  await page.getByTestId('waca-overwrite-ack').waitFor();
  // Choices survive recalculation: switching another spec does not reset G10 / G20 to the default.
  await page.getByLabel('更新方式 G11').selectOption('KEEP'); await page.getByLabel('更新方式 G11').selectOption('ACCUMULATE');
  result.choicesKept = [await mode('G10'), await mode('G20')]; assert.deepEqual(result.choicesKept, ['OVERWRITE', 'KEEP']);
  await page.getByLabel('更新方式 G10').selectOption('ACCUMULATE'); // G20 stays 維持 for this import
  const final1 = norm(await page.getByTestId('waca-final-confirm').innerText());
  assert.match(final1, /本次增加 \+2 件（1 個規格） 本次減少 0 件（0 個規格） 仍待核對 4 件/u);
  assert.match(final1, /維持 1 個規格：本次暫不更新，訂單會保存；下次匯入仍會重新判斷，不是永久排除。/u); assert.match(final1, /ERP1 歷史訂單異動 1 個規格：不會自動扣除/u);
  const c1 = await commit();
  assert.deepEqual(c1.p_plan.overwriteVariantIds, []);
  assert.deepEqual(c1.p_plan.expectedDisplay['variant-G10'], { before: 10, after: 12 });
  const items1 = Object.fromEntries(c1.p_snapshot.items.map(i => [i.orderKey.replace('WACA::', ''), [i.countedQuantity, i.countedReason]]));
  result.items1 = items1;
  assert.deepEqual(items1.W2610190001, [2, 'NEW_AFTER_BASELINE']); assert.deepEqual(items1.W2510010001, [0, 'PENDING_REVIEW'], 'I: pending kept with its reason');
  assert.deepEqual(items1.W2509250401, [0, 'BASELINE_INCLUDED']);
  assert.deepEqual(items1.W2509300001, [0, 'BASELINE_INCLUDED'], 'E: ERP1-history mark kept');
  assert.deepEqual(items1.W2610190002, [0, 'KEPT'], 'G: 維持 saves the order without counting it');
  result.afterCommit1 = await page.evaluate(() => Object.fromEntries(window.wacaUiFixture.variants().map(v => [v.myacg_item_code, v.waca_auto_quantity + v.waca_manual_adjustment])));
  assert.equal(result.afterCommit1.G10, 12); assert.equal(result.afterCommit1.G11, 4); assert.equal(result.afterCommit1.G21, 1); assert.equal(result.afterCommit1.G20, 2);

  // ---- B: the same file again -> nothing is added twice ----
  await upload('waca-1-again.xlsx', base);
  result.B = await row('G10'); assert.deepEqual(result.B.slice(0, 3), ['12', '12', '±0'], 'B: re-import does not add the same order again');
  result.B_G = await row('G20'); assert.deepEqual(result.B_G.slice(0, 3), ['2', '5', '+3'], 'G: 維持 is not permanent - the next import (default 累加) re-judges the kept order');
  result.B_I = await row('G11'); assert.deepEqual(result.B_I.slice(0, 3), ['4', '4', '±0'], 'I: still pending, still not added');

  // ---- C: the counted order is reduced by 1 (2 -> 1) ----
  const reduced = base.map(r => r[1] === 'W2610190001' ? [...r.slice(0, 8), 1, 100] : r);
  await upload('waca-2.xlsx', reduced);
  result.C = await row('G10'); assert.deepEqual(result.C, ['12', '11', '−1', '取消回沖 −1'], 'C: traceable reduction rolls back exactly 1');
  await page.getByLabel('查看 G10 來源訂單').click();
  result.C_trace = norm(await page.locator('.waca-trace-table tr', { hasText: 'W2610190001' }).first().innerText());
  assert.match(result.C_trace, /^W2610190001 2026\/10\/19 10:00 1 1 新訂單 已計入 來源數量／狀態變更已套用 原已認列 2 件，自動回沖 −1/u);
  const c2 = await commit();
  assert.deepEqual(c2.p_plan.expectedDisplay['variant-G10'], { before: 12, after: 11 });
  const item2 = c2.p_snapshot.items.find(i => i.orderKey === 'WACA::W2610190001');
  const hist2 = c2.p_snapshot.items.find(i => i.orderKey === 'WACA::W2509300001');
  if (hist2) assert.deepEqual([hist2.countedQuantity, hist2.countedReason], [0, 'BASELINE_INCLUDED'], 'E: ERP1-history mark survives re-import');
  result.D_history = await page.evaluate(() => window.wacaUiFixture.snapshot().items.filter(i => i.orderKey === 'WACA::W2509300001').map(i => [i.countedQuantity, i.countedReason]));
  assert.deepEqual(result.D_history, [[0, 'BASELINE_INCLUDED']]);
  result.item2 = [item2.countedQuantity, item2.countedReason]; assert.deepEqual(result.item2, [1, 'SOURCE_CHANGE_APPLIED'], 'C: rollback record kept');

  // ---- D: the same reduced file again -> not deducted twice; full cancellation of the counted order -> -1 once ----
  await upload('waca-2-again.xlsx', reduced);
  result.D = await row('G10'); assert.deepEqual(result.D.slice(0, 3), ['11', '11', '±0'], 'D: re-import does not deduct again');
  const cancelled = reduced.map(r => r[1] === 'W2610190001' ? ['取消', ...r.slice(1)] : r);
  await upload('waca-3.xlsx', cancelled);
  result.D_cancel = await row('G10'); assert.deepEqual(result.D_cancel, ['11', '10', '−1', '取消回沖 −1']);
  result.errors = errors; assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 1));
} finally { await browser?.close(); vite.kill(); }
