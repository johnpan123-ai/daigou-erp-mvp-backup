// Purchase Records level 2 (product detail), Owner layout 2026-10-21: 編輯模式 shows the 商品基本資訊 card (官方結單日 /
// 發售月份 / 官網網址, saved with the same rules and path as level 1, no separate save / cancel); 鎖定模式 removes the card and
// shows 日本代購｜官網｜結單日｜發售月份 as plain text in the info line under the title. Isolated React harness (experimental provider, in-memory server, uuid fixtures, no Supabase).
// Port: PURCHASE_GROUP_BASIC_INFO_PORT (default 4725). Optional OUT=<dir> for screenshots.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.PURCHASE_GROUP_BASIC_INFO_PORT || '4725';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-p0-2-react-harness.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.OUT;
const LONG_TITLE = 'Hololive さくらみこ 2nd Album Blooming Cinderella 完全生產限定盤 特典付き 予約受付 アクリルスタンド 缶バッジ セット';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
if (OUT) mkdirSync(OUT, { recursive: true });
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; vite.stdout.on('data', c => { output += c; }); vite.stderr.on('data', c => { output += c; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = {};

const open = async (browser, width, editMode, height = 900) => {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(mode => {
    localStorage.setItem('erp_provider_mode', 'experimental');
    localStorage.setItem('purchase_management_edit_mode', mode ? 'true' : 'false');
  }, editMode);
  const page = await context.newPage();
  const errors = []; const supabase = []; const dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('.supabase.co/')) supabase.push(request.url()); });
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void (page.__dialogAnswer === false ? dialog.dismiss() : dialog.accept()); });
  await page.goto(`${BASE_URL}?route=${encodeURIComponent('/purchase-records/g-holo')}&uuidFixtures=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  await page.getByTestId('purchase-group-info-line').waitFor();
  return { context, page, errors, supabase, dialogs };
};
const groupWhere = (page, fn) => page.waitForFunction(fn, null, { timeout: 10000 });
const serverGroup = page => page.evaluate(() => {
  const g = window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo'));
  return { closing_date: g.closing_date, release_month: g.release_month, product_url: g.product_url };
});
const writes = page => page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes ?? 0);
const remoteGroupPatch = (page, patch) => page.evaluate(async value => {
  const h = window.__P0_REACT_HARNESS__;
  const row = { ...h.server.productGroups.find(item => item.id === h.fixtureId('g-holo')), ...value, updated_at: new Date().toISOString() };
  await h.emitUpsert('product_groups', row);
}, patch);
const openHeaderLink = async (context, page) => {
  const popupPromise = context.waitForEvent('page');
  await page.getByTestId('purchase-group-official-link').click();
  const popup = await popupPromise; await popup.close();
  return true;
};
const toggleMode = page => page.getByRole('button', { name: /^(✏️ 編輯中|🔒 已鎖定)$/u }).click();
const infoText = async page => (await page.getByTestId('purchase-group-info-line').innerText()).replace(/\s+/gu, ' ').trim();
const layout = page => page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
  const q = s => document.querySelector(s);
  const titleEl = q('[data-testid="purchase-group-detail-title"]');
  const title = box(titleEl); const header = box(titleEl.parentElement);
  const items = [...q('[data-testid="purchase-group-info-line"]').children].map(box);
  const card = q('[data-testid="purchase-group-basic-info"]'); const fields = card ? [...card.querySelectorAll('input')].map(box) : [];
  const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const all = [title, ...items, ...fields];
  const firstStat = [...document.querySelectorAll('.card')].map(box).sort((a, b) => a.top - b.top)[0];
  const lowest = Math.max(...all.map(b => b.bottom));
  return {
    titleUsesFullWidth: title.width >= header.width - 60, titleClipped: titleEl.scrollWidth > titleEl.clientWidth + 1 || titleEl.scrollHeight > titleEl.clientHeight + 1,
    anyOverlap: all.some((a, i) => all.some((b, j) => i < j && overlap(a, b))), infoRows: new Set(items.map(b => Math.round((b.top + b.bottom) / 8))).size,
    infoBelowTitle: items.every(b => b.top >= title.bottom - 0.5), cardPresent: !!card, inputCount: document.querySelectorAll('[data-testid="purchase-group-info-line"] input').length,
    statsBelowHeader: firstStat ? firstStat.top > lowest : null, pageOverflow: document.documentElement.scrollWidth > innerWidth,
  };
});

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    // ---- 鎖定模式 with empty values: no card, no inputs, 未設定 text (no fabricated dates) ----
    {
      const { context, page, errors } = await open(browser, 1366, false);
      await remoteGroupPatch(page, { closing_date: null, release_month: null, product_url: null });
      await page.getByTestId('purchase-group-official-link-unset').waitFor();
      result.lockedEmpty = { info: await infoText(page), card: await page.getByTestId('purchase-group-basic-info').count() };
      assert.equal(result.lockedEmpty.card, 0);
      assert.match(result.lockedEmpty.info, /官網：未設定 結單日：未設定 發售月份：未設定/u);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- 編輯模式 → edit → 鎖定模式 → 編輯模式 on the same page; same save path as level 1 ----
    const { context, page, errors, supabase, dialogs } = await open(browser, 1366, true);
    await remoteGroupPatch(page, { title: LONG_TITLE, normalized_title: LONG_TITLE });
    await page.getByText(LONG_TITLE).first().waitFor();
    await page.getByTestId('purchase-group-basic-info').waitFor();
    assert.equal(await page.getByRole('button', { name: /保存基本資訊|取消修改/u }).count(), 0, 'no separate save / cancel buttons');
    assert.equal(await page.getByTestId('purchase-group-closing-date-text').count(), 0, 'edit mode shows inputs, not text');
    await page.getByTestId('purchase-group-release-month').fill('2027-02'); await page.getByTestId('purchase-group-release-month').press('Enter');
    await groupWhere(page, () => window.__P0_REACT_HARNESS__.server.productGroups.find(r => r.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).release_month === '2027-02');
    await page.getByTestId('purchase-group-product-url').fill('javascript:alert(1)'); await page.getByTestId('purchase-group-product-url').press('Enter');
    await sleep(300);
    assert.equal(await page.getByTestId('purchase-group-official-link').count(), 0, 'no link for a non-http(s) URL');
    await page.getByTestId('purchase-group-product-url').fill('https://example.com/holo-official'); await page.getByTestId('purchase-group-product-url').press('Enter');
    await page.getByTestId('purchase-group-official-link').waitFor();
    const before = (await serverGroup(page)).closing_date;
    await page.getByTestId('purchase-group-closing-date').fill('2027/0');
    await page.getByTestId('purchase-group-release-month').focus(); await sleep(300);
    assert.equal((await serverGroup(page)).closing_date, before, 'incomplete closing date stays a draft');
    await page.getByTestId('purchase-group-closing-date').fill('20270215');
    await page.getByTestId('purchase-group-closing-date').press('Enter');
    await groupWhere(page, () => window.__P0_REACT_HARNESS__.server.productGroups.find(r => r.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).closing_date === '2027/02/15');
    result.saved = await serverGroup(page);
    assert.deepEqual(result.saved, { closing_date: '2027/02/15', release_month: '2027-02', product_url: 'https://example.com/holo-official' });
    const w1 = await writes(page);
    result.editHeaderLinkClickable = await openHeaderLink(context, page);
    assert.equal(await writes(page), w1, 'opening the link writes nothing');
    result.editLayout = await layout(page);
    assert.equal(result.editLayout.cardPresent, true); assert.equal(result.editLayout.anyOverlap, false); assert.equal(result.editLayout.titleClipped, false);
    assert.equal(result.editLayout.titleUsesFullWidth, true); assert.equal(result.editLayout.statsBelowHeader, true); assert.equal(result.editLayout.pageOverflow, false);
    if (OUT) await page.screenshot({ path: `${OUT}/pm-A-edit-1366.png`, clip: { x: 0, y: 0, width: 1366, height: 560 } });
    // Switch to 鎖定模式: card disappears, values appear as text, nothing lost, no write on switch.
    const w2 = await writes(page);
    await toggleMode(page);
    await page.getByTestId('purchase-group-basic-info').waitFor({ state: 'detached' });
    result.locked = { info: await infoText(page), writesOnSwitch: (await writes(page)) - w2, dialogs: dialogs.length, layout: await layout(page) };
    assert.match(result.locked.info, /日本代購 官網 結單日：2027\/02\/15 發售月份：2027\/02/u);
    assert.equal(result.locked.writesOnSwitch, 0); assert.equal(result.locked.dialogs, 0);
    const L = result.locked.layout;
    assert.equal(L.cardPresent, false); assert.equal(L.inputCount, 0); assert.equal(L.infoRows, 1, 'info items on one row at 1366');
    assert.equal(L.infoBelowTitle, true); assert.equal(L.anyOverlap, false); assert.equal(L.titleClipped, false); assert.equal(L.titleUsesFullWidth, true);
    assert.equal(L.statsBelowHeader, true); assert.equal(L.pageOverflow, false);
    assert.equal(await page.getByTestId('purchase-group-official-link').getAttribute('href'), 'https://example.com/holo-official');
    result.lockHeaderLinkClickable = await openHeaderLink(context, page);
    if (OUT) { await page.getByText('已鎖定數量欄位，避免誤觸').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {}); }
    if (OUT) await page.screenshot({ path: `${OUT}/pm-B-locked-1366.png`, clip: { x: 0, y: 0, width: 1366, height: 560 } });
    // Remote (level 1 / other tab) change shows up in 鎖定模式 text.
    await remoteGroupPatch(page, { release_month: '2027-03' });
    await page.getByText('發售月份：2027/03').waitFor();
    // Back to 編輯模式: inputs show the latest cloud values (nothing lost, no stale draft).
    await toggleMode(page);
    await page.getByTestId('purchase-group-basic-info').waitFor();
    result.reEdit = { closing: await page.getByTestId('purchase-group-closing-date').inputValue(), release: await page.getByTestId('purchase-group-release-month').inputValue(),
      url: await page.getByTestId('purchase-group-product-url').inputValue() };
    assert.deepEqual(result.reEdit, { closing: '2027/02/15', release: '2027-03', url: 'https://example.com/holo-official' });
    // Unsaved draft is protected from a remote change, and locking with an incomplete draft asks before discarding it.
    await page.getByTestId('purchase-group-closing-date').fill('2027/03');
    await remoteGroupPatch(page, { closing_date: '2027/04/01' });
    await sleep(800);
    result.draftProtected = await page.getByTestId('purchase-group-closing-date').inputValue();
    assert.equal(result.draftProtected, '2027/03');
    page.__dialogAnswer = false;
    await toggleMode(page); await sleep(300);
    assert.equal(dialogs.length, 1); assert.match(dialogs[0], /放棄未儲存/u);
    assert.equal(await page.getByTestId('purchase-group-closing-date').inputValue(), '2027/03', 'cancel keeps edit mode and the draft');
    page.__dialogAnswer = true;
    await toggleMode(page);
    await page.getByTestId('purchase-group-basic-info').waitFor({ state: 'detached' });
    await page.getByText('結單日：2027/04/01').waitFor();
    result.draftDiscardShowsCloud = true;
    assert.equal((await serverGroup(page)).closing_date, '2027/04/01', 'draft never overwrote the newer cloud value');
    // Level 1 shows the same values.
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records'));
    const level1Row = page.getByRole('row').filter({ hasText: 'Hololive' }).first();
    await level1Row.waitFor();
    result.level1 = (await level1Row.innerText()).replace(/\s+/gu, ' ');
    assert.match(result.level1, /結單 04\/01 發售：2027年03月 🔗 官網/u);
    assert.deepEqual(errors, []); assert.deepEqual(supabase, []);
    await context.close();
    // ---- Mobile 390 / 430: long title, both modes, natural wrapping, no overlap, no horizontal scroll ----
    for (const width of [390, 430]) {
      for (const edit of [true, false]) {
        const { context: c2, page: p2, errors: e2 } = await open(browser, width, edit, 1100);
        await remoteGroupPatch(p2, { title: LONG_TITLE, normalized_title: LONG_TITLE, closing_date: '2027/02/15', release_month: '2027-02', product_url: 'https://example.com/holo-official' });
        await p2.getByText(LONG_TITLE).first().waitFor();
        if (!edit) await p2.getByText('結單日：2027/02/15').waitFor();
        const l = await layout(p2);
        result[`m${width}${edit ? 'edit' : 'locked'}`] = l;
        assert.equal(l.cardPresent, edit); assert.equal(l.anyOverlap, false); assert.equal(l.titleClipped, false); assert.equal(l.pageOverflow, false);
        assert.equal(l.statsBelowHeader, true);
        if (OUT && width === 390) await p2.screenshot({ path: `${OUT}/pm-${edit ? 'A-edit' : 'B-locked'}-390.png`, clip: { x: 0, y: 0, width, height: 760 } });
        assert.deepEqual(e2, []);
        await c2.close();
      }
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 1));
} finally { vite.kill(); }
