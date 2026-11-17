// Purchase Records level 2 · 商品基本資訊 · 官方結單日: clicking the field or the calendar icon opens the calendar popover;
// a pick saves YYYY/MM/DD once through the existing draft/commit path; empty stays empty (no "today").
// Synthetic React harness (experimental mode), no Supabase. Port: CLOSING_DATE_PICKER_PORT (default 4726).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.CLOSING_DATE_PICKER_PORT || '4726';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-p0-2-react-harness.html`;
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; vite.stdout.on('data', c => { output += c; }); vite.stderr.on('data', c => { output += c; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = {};

const open = async (browser, width, height = 900, timezoneId = undefined) => {
  const context = await browser.newContext({ viewport: { width, height }, ...(timezoneId ? { timezoneId } : {}), ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript(() => {
    localStorage.setItem('erp_provider_mode', 'experimental');
    localStorage.setItem('purchase_management_edit_mode', 'true');
  });
  const page = await context.newPage();
  const errors = []; const supabase = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('.supabase.co/')) supabase.push(request.url()); });
  await page.goto(`${BASE_URL}?route=${encodeURIComponent('/purchase-records/g-holo')}&uuidFixtures=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  await page.getByTestId('purchase-group-closing-date').waitFor();
  return { context, page, errors, supabase };
};
const field = page => page.getByTestId('purchase-group-closing-date');
const serverClosing = page => page.evaluate(() => window.__P0_REACT_HARNESS__.server.productGroups
  .find(row => row.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).closing_date ?? null);
const writes = page => page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes ?? 0);
const remoteGroupPatch = (page, patch) => page.evaluate(async value => {
  const h = window.__P0_REACT_HARNESS__;
  const row = { ...h.server.productGroups.find(item => item.id === h.fixtureId('g-holo')), ...value, updated_at: new Date().toISOString() };
  await h.emitUpsert('product_groups', row);
}, patch);
const calendar = page => page.getByTestId('closing-date-calendar');
const calendarState = page => page.evaluate(() => {
  const el = document.querySelector('[data-testid="closing-date-calendar"]');
  if (!el) return null;
  return { month: el.querySelector('[data-testid="closing-date-calendar-month"]').textContent, selected: el.querySelector('button[aria-pressed="true"]')?.getAttribute('data-date') ?? null };
});
const closeByOutsideClick = async page => { await page.getByText('商品基本資訊').first().click(); await calendar(page).waitFor({ state: 'detached' }); };
// Navigate the popover to the month of `slash` (YYYY/MM/DD) and click that day.
const pick = async (page, slash) => {
  const [y, m] = slash.split('/').map(Number);
  for (let guard = 0; guard < 60; guard += 1) {
    const [vy, vm] = (await calendarState(page)).month.split('/').map(Number);
    const diff = (y * 12 + m) - (vy * 12 + vm);
    if (diff === 0) break;
    await calendar(page).getByRole('button', { name: diff > 0 ? '下個月' : '上個月' }).click();
  }
  const day = calendar(page).locator(`button[data-date="${slash}"]`);
  const box = await day.boundingBox();
  const onTop = await day.evaluate(el => { const b = el.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === el; });
  await day.click();
  return { onTop, inViewport: box.x >= 0 && box.x + box.width <= page.viewportSize().width };
};
const clickAt = async (page, xRatio) => { const box = await field(page).boundingBox(); await page.mouse.click(box.x + box.width * xRatio, box.y + box.height / 2); };

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (const [label, width] of [['desktop', 1366], ['mobile', 390]]) {
      const { context, page, errors, supabase } = await open(browser, width);
      const r = {};
      // Existing date: a click anywhere opens the calendar on that month with the date selected.
      await remoteGroupPatch(page, { closing_date: '2027/02/15' });
      await page.waitForFunction(() => document.querySelector('[data-testid="purchase-group-closing-date"]').value === '2027/02/15');
      r.opens = [];
      for (const x of [0.1, 0.5, 0.95]) { await clickAt(page, x); r.opens.push(await calendarState(page)); await closeByOutsideClick(page); }
      assert.deepEqual(r.opens, [0, 1, 2].map(() => ({ month: '2027/02', selected: '2027/02/15' })), `${label}: every click opens the calendar with the saved date`);
      // Pick a new day: YYYY/MM/DD, saved exactly once, popover closes, no extra write on blur.
      const w0 = await writes(page);
      await clickAt(page, 0.5);
      if (process.env.CLOSING_DATE_SHOTS) await page.screenshot({ path: `${process.env.CLOSING_DATE_SHOTS}/closing-date-calendar-${label}.png` });
      r.pickVisible = await pick(page, '2027/05/09');
      assert.deepEqual(r.pickVisible, { onTop: true, inViewport: true }, `${label}: calendar is not covered and fits the screen`);
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).closing_date === '2027/05/09');
      assert.equal(await field(page).inputValue(), '2027/05/09');
      assert.equal(await calendar(page).count(), 0, `${label}: closes after a pick`);
      await page.getByText('商品基本資訊').first().click(); await sleep(400);
      r.writesForPick = (await writes(page)) - w0;
      assert.equal(r.writesForPick, 1, `${label}: one write per pick (no duplicate on blur)`);
      // Picking the same day again writes nothing; re-editing to another day works.
      const w1 = await writes(page);
      await clickAt(page, 0.5); await pick(page, '2027/05/09'); await sleep(400);
      assert.equal((await writes(page)) - w1, 0, `${label}: unchanged pick does not write`);
      await clickAt(page, 0.5); await pick(page, '2028/01/31');
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).closing_date === '2028/01/31');
      // Empty value: calendar opens with nothing selected; clicking/closing never fills in today.
      await remoteGroupPatch(page, { closing_date: null });
      await page.waitForFunction(() => document.querySelector('[data-testid="purchase-group-closing-date"]').value === '');
      const w2 = await writes(page);
      await clickAt(page, 0.5); r.empty = await calendarState(page);
      assert.equal(r.empty.selected, null, `${label}: empty field opens with no day selected`);
      await field(page).press('Escape'); await sleep(300);
      assert.equal(await calendar(page).count(), 0, `${label}: Esc closes the calendar`);
      await clickAt(page, 0.5); await field(page).press('Enter'); await sleep(400);
      assert.equal(await field(page).inputValue(), '', `${label}: no date filled in automatically`);
      assert.equal(await serverClosing(page), null); assert.equal((await writes(page)) - w2, 0);
      // Click then type the shorthand (calendar open): typing goes to the field, never to "today".
      await clickAt(page, 0.5);
      await field(page).press('Control+A'); await page.keyboard.type('20271224', { delay: 10 }); await field(page).press('Enter');
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).closing_date === '2027/12/24');
      assert.equal(await calendar(page).count(), 0, `${label}: Enter closes the calendar`);
      // Calendar icon: opens the same calendar without moving focus into the text field (no phone keyboard
      // over the calendar); a second press or a tap outside closes it; a pick saves once.
      const icon = page.getByTestId('purchase-group-closing-date-calendar-button');
      await page.getByText('商品基本資訊').first().click(); await sleep(200);
      assert.equal(await icon.getAttribute('aria-label'), '開啟日曆選擇官方結單日');
      await icon.click();
      r.iconOpens = await calendarState(page);
      assert.deepEqual(r.iconOpens, { month: '2027/12', selected: '2027/12/24' }, `${label}: icon opens the calendar on the saved date`);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid ?? null) === 'purchase-group-closing-date', false, `${label}: icon does not focus the text field`);
      await icon.click(); await sleep(200);
      assert.equal(await calendar(page).count(), 0, `${label}: icon toggles the calendar closed`);
      await icon.click(); await page.getByText('商品基本資訊').first().click(); await sleep(200);
      assert.equal(await calendar(page).count(), 0, `${label}: tap outside closes the calendar`);
      const w3 = await writes(page);
      await icon.click(); await pick(page, '2027/12/30');
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).closing_date === '2027/12/30');
      await sleep(400); assert.equal((await writes(page)) - w3, 1, `${label}: icon pick writes once`);
      assert.equal(await field(page).inputValue(), '2027/12/30');
      // Manual entry still works next to the icon (full form).
      await field(page).click(); await field(page).press('Control+A'); await page.keyboard.type('2027/12/24'); await field(page).press('Enter');
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).closing_date === '2027/12/24');
      // Re-enter the page: saved value shown.
      const detailPath = await page.evaluate(() => location.pathname);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records'));
      await field(page).waitFor({ state: 'detached' });
      await page.evaluate(path => window.__P0_REACT_HARNESS__.navigate(path), detailPath);
      await field(page).waitFor();
      r.afterReEnter = await field(page).inputValue();
      r.supabase = supabase.length; r.errors = errors;
      assert.deepEqual(errors, []); assert.deepEqual(supabase, []);
      result[label] = r;
      await context.close();
    }
    // Time zones far from Taipei: the picked calendar day is stored as that same YYYY/MM/DD (no UTC shift).
    for (const timezoneId of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
      const { context, page, errors } = await open(browser, 1366, 900, timezoneId);
      await remoteGroupPatch(page, { closing_date: '2027/03/01' });
      await page.waitForFunction(() => document.querySelector('[data-testid="purchase-group-closing-date"]').value === '2027/03/01');
      await page.getByTestId('purchase-group-closing-date-calendar-button').click();
      assert.deepEqual(await calendarState(page), { month: '2027/03', selected: '2027/03/01' }, `${timezoneId}: saved day shown as is`);
      await pick(page, '2027/03/31');
      await page.waitForFunction(() => window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === window.__P0_REACT_HARNESS__.fixtureId('g-holo')).closing_date === '2027/03/31');
      assert.deepEqual(errors, []);
      result[timezoneId] = 'picked 2027/03/31 -> stored 2027/03/31';
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(result));
  console.log('PASS closing-date field and calendar icon open the calendar; manual entry kept; pick saves YYYY/MM/DD once; empty stays empty; no time-zone shift; desktop + mobile');
} finally { vite.kill('SIGTERM'); }
