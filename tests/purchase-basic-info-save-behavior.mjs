// 官方結單日 / 發售月份 / 官網網址 save behaviour, Purchase Records level 1 + level 2 (shared rule, Owner 2026-10-21):
// Blur / Enter save once; Esc restores; unchanged = 0 writes; saving state without layout shift; failure keeps the draft;
// Stale / CAS rejection never overwrites; Realtime (other tab) update never overwrites a draft; Restore epoch barrier
// blocks an old draft; edit/lock switch never double-submits; level 1 <-> level 2 show the same stored row.
// Isolated React harness (experimental provider, in-memory server, uuid fixtures, no Supabase). Port: BASIC_INFO_SAVE_PORT (4728).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.BASIC_INFO_SAVE_PORT || '4728';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-p0-2-react-harness.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; vite.stdout.on('data', c => { output += c; }); vite.stderr.on('data', c => { output += c; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = {};

const H = fn => page => page.evaluate(fn);
const saves = H(() => window.__P0_REACT_HARNESS__.snapshot().writesByMethod.saveProductGroups ?? 0);
const serverGroup = H(() => {
  const h = window.__P0_REACT_HARNESS__; const g = h.server.productGroups.find(r => r.id === h.fixtureId('g-holo'));
  return { closing_date: g.closing_date, release_month: g.release_month, product_url: g.product_url };
});
const remotePatch = (page, patch) => page.evaluate(async value => {
  const h = window.__P0_REACT_HARNESS__;
  const row = { ...h.server.productGroups.find(item => item.id === h.fixtureId('g-holo')), ...value, updated_at: new Date().toISOString() };
  await h.emitUpsert('product_groups', row);
}, patch);
const raiseEpochBarrier = page => page.evaluate(async () => {
  const { raiseCloudCacheEpochBarrier } = await import('/src/providers/cloud/cloudCacheWriteFence.ts');
  raiseCloudCacheEpochBarrier(null);
});
const clickAway = page => page.locator('body').click({ position: { x: 5, y: 5 } });

const open = async (browser, route) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('erp_provider_mode', 'experimental'); localStorage.setItem('purchase_management_edit_mode', 'true'); });
  const page = await context.newPage();
  const errors = []; const dialogs = []; const supabase = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('.supabase.co/')) supabase.push(r.url()); });
  page.on('dialog', d => { dialogs.push(d.message()); void (page.__dialogAnswer === false ? d.dismiss() : d.accept()); });
  await page.goto(`${BASE_URL}?route=${encodeURIComponent(route)}&uuidFixtures=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  return { context, page, errors, dialogs, supabase };
};

// Per-level accessors.
const level1 = async page => {
  const row = page.getByRole('row').filter({ hasText: 'hololive active' }).first();
  await row.waitFor();
  if (!(await row.locator('input[data-field="release_month"]').count())) await page.getByTestId('purchase-records-edit-mode-toggle').click();
  const input = name => row.locator(`input[data-field="${name}"]`).first();
  await input('release_month').waitFor();
  return { input, error: () => row.locator('[data-testid="closing-date-save-error"], [data-testid="basic-info-save-error"]').allInnerTexts() };
};
const level2 = async page => {
  await page.getByTestId('purchase-group-basic-info').waitFor();
  const ids = { closing_date: 'purchase-group-closing-date', release_month: 'purchase-group-release-month', product_url: 'purchase-group-product-url' };
  return { input: name => page.getByTestId(ids[name]),
    error: async () => (await page.getByTestId('purchase-group-closing-date-error').count()) ? [await page.getByTestId('purchase-group-closing-date-error').innerText()] : [] };
};
const typeInto = async (page, input, text) => { await input.click(); await input.press('Control+A'); await input.press('Backspace'); await page.keyboard.type(text, { delay: 10 }); };

const scenarios = async (page, dialogs, L, label) => {
  const r = {};
  // Esc restores the authoritative value, zero writes.
  for (const field of ['closing_date', 'release_month', 'product_url']) {
    const before = (await serverGroup(page))[field] ?? '';
    const w0 = await saves(page);
    await typeInto(page, L.input(field), field === 'closing_date' ? '20291231' : 'esc-draft');
    await L.input(field).press('Escape');
    await sleep(300);
    assert.equal(await L.input(field).inputValue(), before, `${label} ${field}: Esc restores`);
    assert.equal(await saves(page), w0, `${label} ${field}: Esc writes nothing`);
  }
  r.esc = 'restored, 0 writes';
  // Saving state + Enter/Blur during an in-flight save: one write, no layout shift, draft kept until success.
  {
    const input = L.input('release_month');
    // Layout position in scroll-content coordinates: Playwright may scroll the
    // .main-area container to reach the input, which is not a layout shift.
    const contentBox = () => input.evaluate(el => {
      const rect = el.getBoundingClientRect(); let scrolled = window.scrollY;
      for (let node = el.parentElement; node; node = node.parentElement) scrolled += node.scrollTop;
      return { y: rect.top + scrolled, height: rect.height };
    });
    const box0 = await contentBox();
    await page.evaluate(() => window.__P0_REACT_HARNESS__.holdNextGroupSave());
    const w0 = await saves(page);
    await typeInto(page, input, '2028-01');
    await input.press('Enter');
    await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().groupSaveHeld);
    const saving = { attr: await input.getAttribute('data-saving'), busy: await input.getAttribute('aria-busy') };
    await clickAway(page); await input.click(); await input.press('Enter'); await clickAway(page); // more Blur / Enter while saving
    const box1 = await contentBox();
    await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseGroupSave());
    await page.waitForFunction(() => !window.__P0_REACT_HARNESS__.snapshot().groupSaveHeld);
    await sleep(300);
    r.saving = { saving, writes: (await saves(page)) - w0, shift: Math.abs(box1.y - box0.y) + Math.abs(box1.height - box0.height), stored: (await serverGroup(page)).release_month };
    assert.deepEqual(r.saving.saving, { attr: 'true', busy: 'true' });
    assert.equal(r.saving.writes, 1); assert.equal(r.saving.shift, 0); assert.equal(r.saving.stored, '2028-01');
    assert.equal(await input.getAttribute('data-saving'), null);
  }
  // Save failure: error shown, draft kept, nothing stored; retry saves once.
  {
    const input = L.input('product_url');
    const before = (await serverGroup(page)).product_url;
    await page.evaluate(() => window.__P0_REACT_HARNESS__.failNextGroupSave('error'));
    const w0 = await saves(page);
    await typeInto(page, input, 'https://example.com/fail-then-retry');
    await input.press('Enter'); await sleep(400);
    r.failure = { error: (await L.error()).join(' '), draft: await input.inputValue(), stored: (await serverGroup(page)).product_url };
    assert.match(r.failure.error, /儲存失敗/u); assert.equal(r.failure.draft, 'https://example.com/fail-then-retry'); assert.equal(r.failure.stored, before);
    await input.click(); await input.press('Enter');
    await page.waitForFunction(() => { const h = window.__P0_REACT_HARNESS__; return h.server.productGroups.find(x => x.id === h.fixtureId('g-holo')).product_url === 'https://example.com/fail-then-retry'; });
    r.failure.retryWrites = (await saves(page)) - w0; // failed attempt + retry
    assert.equal(r.failure.retryWrites, 2); assert.deepEqual(await L.error(), []);
    await clickAway(page);
  }
  // Stale / CAS rejection: alert, nothing stored, draft kept (never reported as saved).
  {
    const input = L.input('closing_date');
    const before = (await serverGroup(page)).closing_date;
    await page.evaluate(() => window.__P0_REACT_HARNESS__.failNextGroupSave('stale'));
    const d0 = dialogs.length;
    await typeInto(page, input, '20280808');
    await input.press('Enter'); await sleep(800);
    r.cas = { alert: dialogs.slice(d0).join(' | '), stored: (await serverGroup(page)).closing_date, draft: await input.inputValue(), error: (await L.error()).join(' ') };
    assert.match(r.cas.alert, /CAS 衝突模擬/u); assert.equal(r.cas.stored, before); assert.equal(r.cas.draft, '20280808'); assert.match(r.cas.error, /儲存未完成/u);
    await input.click(); await input.press('Escape'); await sleep(200);
  }
  // Realtime update from another tab while a draft is open: draft not overwritten; Blur does not overwrite the newer value.
  {
    const input = L.input('release_month');
    await typeInto(page, input, '2028-09');
    const w0 = await saves(page);
    await remotePatch(page, { release_month: '2030-12' });
    await sleep(900);
    const draftAfterRemote = await input.inputValue();
    await clickAway(page); await sleep(400);
    r.remote = { draftAfterRemote, writesOnBlur: (await saves(page)) - w0, stored: (await serverGroup(page)).release_month, error: (await L.error()).join(' ') };
    assert.equal(r.remote.draftAfterRemote, '2028-09', 'draft not overwritten by the remote update');
    assert.equal(r.remote.stored, '2030-12', 'newer remote value not overwritten on Blur');
    assert.equal(r.remote.writesOnBlur, 0, `${label}: Blur must not overwrite a newer remote value`);
    // Either the draft conflict check or the page's existing stale guard stops the write; both keep the newer value.
    r.remote.guard = /已在其他地方更新為「2030-12」/u.test(r.remote.error) ? 'draft-conflict' : /儲存未完成/u.test(r.remote.error) ? 'stale-guard' : 'none';
    assert.notEqual(r.remote.guard, 'none');
    await input.click(); await input.press('Escape'); await sleep(300);
    r.remote.afterEsc = await input.inputValue();
    assert.notEqual(r.remote.afterEsc, '2028-09', 'Esc drops the draft');
  }
  return r;
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
    // ---- Level 1 then level 2 scenarios (fresh page each, stale state from the CAS case does not leak) ----
    for (const [label, route, accessor] of [['level1', '/purchase-records', level1], ['level2', '/purchase-records/g-holo', level2]]) {
      const { context, page, errors, dialogs, supabase } = await open(browser, route);
      const L = await accessor(page);
      result[label] = await scenarios(page, dialogs, L, label);
      assert.deepEqual(errors, []); assert.deepEqual(supabase, []);
      await context.close();
    }
    // ---- Level 1 leaving edit mode (same protection as level 2) ----
    {
      const { context, page, errors, dialogs } = await open(browser, '/purchase-records');
      let L = await level1(page);
      const toggle = page.getByTestId('purchase-records-edit-mode-toggle');
      // Valid draft: the Blur caused by the toggle click saves it once; no dialog; no second write.
      await typeInto(page, L.input('release_month'), '2031-01');
      let w0 = await saves(page); let d0 = dialogs.length;
      await toggle.click(); await sleep(500);
      const valid = { writes: (await saves(page)) - w0, dialogs: dialogs.length - d0, stored: (await serverGroup(page)).release_month,
        leftEdit: (await page.locator('input[data-field="release_month"]').count()) === 0 };
      assert.deepEqual(valid, { writes: 1, dialogs: 0, stored: '2031-01', leftEdit: true });
      // Incomplete closing date: confirmation; cancel keeps edit mode and the draft; no write.
      L = await level1(page);
      const storedClosing = (await serverGroup(page)).closing_date;
      await typeInto(page, L.input('closing_date'), '2031/0');
      w0 = await saves(page); d0 = dialogs.length;
      page.__dialogAnswer = false;
      await toggle.click(); await sleep(400);
      const cancel = { dialogs: dialogs.length - d0, message: dialogs.at(-1), stillEditing: (await L.input('closing_date').count()) === 1,
        draft: await L.input('closing_date').inputValue(), writes: (await saves(page)) - w0 };
      assert.equal(cancel.dialogs, 1); assert.match(cancel.message, /離開編輯模式將放棄未儲存的商品資訊草稿/u);
      assert.equal(cancel.stillEditing, true); assert.equal(cancel.draft, '2031/0'); assert.equal(cancel.writes, 0);
      // Confirm: draft discarded, authoritative value shown again, no write.
      page.__dialogAnswer = true;
      await toggle.click(); await sleep(400);
      assert.equal(await page.locator('input[data-field="closing_date"]').count(), 0);
      L = await level1(page);
      const confirm = { writes: (await saves(page)) - w0, shown: await L.input('closing_date').inputValue(), stored: (await serverGroup(page)).closing_date };
      assert.deepEqual(confirm, { writes: 0, shown: storedClosing, stored: storedClosing });
      // A draft whose save failed is also protected (not silently dropped).
      await page.evaluate(() => window.__P0_REACT_HARNESS__.failNextGroupSave('error'));
      await typeInto(page, L.input('product_url'), 'https://example.com/failed-draft'); await L.input('product_url').press('Enter'); await sleep(400);
      d0 = dialogs.length; page.__dialogAnswer = false;
      await toggle.click(); await sleep(400);
      const failed = { dialogs: dialogs.length - d0, draft: await L.input('product_url').inputValue() };
      assert.deepEqual(failed, { dialogs: 1, draft: 'https://example.com/failed-draft' });
      result.level1ExitEdit = { valid, cancel, confirm, failed };
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- Restore epoch barrier: a draft started before it is never committed (both levels) ----
    for (const [label, route, accessor] of [['level1', '/purchase-records', level1], ['level2', '/purchase-records/g-holo', level2]]) {
      const { context, page, errors } = await open(browser, route);
      const L = await accessor(page);
      const input = L.input('product_url');
      const before = (await serverGroup(page)).product_url;
      await typeInto(page, input, 'https://example.com/pre-restore-draft');
      await raiseEpochBarrier(page);
      const w0 = await saves(page);
      await input.press('Enter'); await clickAway(page); await sleep(400);
      const r = { writes: (await saves(page)) - w0, stored: (await serverGroup(page)).product_url, error: (await L.error()).join(' ') };
      assert.equal(r.writes, 0); assert.equal(r.stored, before); assert.match(r.error, /重新同步（還原）/u);
      await input.click(); await input.press('Escape'); await sleep(200);
      await typeInto(page, input, 'https://example.com/post-restore');
      await input.press('Enter');
      await page.waitForFunction(() => { const h = window.__P0_REACT_HARNESS__; return h.server.productGroups.find(x => x.id === h.fixtureId('g-holo')).product_url === 'https://example.com/post-restore'; });
      r.newDraftSavedAfterBarrier = true;
      result[`epoch_${label}`] = r;
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- Level 2 <-> level 1 on the same stored row; half-typed URL never becomes the link; mode switches ----
    {
      const { context, page, errors, dialogs } = await open(browser, '/purchase-records/g-holo');
      let L = await level2(page);
      await typeInto(page, L.input('closing_date'), '20270707'); await L.input('closing_date').press('Enter');
      await typeInto(page, L.input('release_month'), '2027-07'); await L.input('release_month').press('Tab');
      await typeInto(page, L.input('product_url'), 'https://example.com/l2-saved'); await L.input('product_url').press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-testid="purchase-group-official-link"]')?.getAttribute('href') === 'https://example.com/l2-saved');
      // Half-typed URL: the link keeps the saved value until the draft is saved.
      await typeInto(page, L.input('product_url'), 'https://exa');
      const hrefWhileTyping = await page.getByTestId('purchase-group-official-link').getAttribute('href');
      assert.equal(hrefWhileTyping, 'https://example.com/l2-saved');
      // Link clickable in edit mode (opening it does not save or blur-commit anything new).
      await L.input('product_url').press('Escape');
      const popupPromise = context.waitForEvent('page'); await page.getByTestId('purchase-group-official-link').click(); await (await popupPromise).close();
      result.l2ToL1 = { stored: await serverGroup(page), hrefWhileTyping };
      assert.deepEqual(result.l2ToL1.stored, { closing_date: '2027/07/07', release_month: '2027-07', product_url: 'https://example.com/l2-saved' });
      // Edit -> lock with a valid draft: the Blur saves once, no discard dialog, no second submit.
      await typeInto(page, L.input('release_month'), '2027-08');
      const w0 = await saves(page); const d0 = dialogs.length;
      await page.getByRole('button', { name: /^(✏️ 編輯中|🔒 已鎖定)$/u }).click();
      await page.getByTestId('purchase-group-basic-info').waitFor({ state: 'detached' });
      await sleep(400);
      result.lockWithValidDraft = { writes: (await saves(page)) - w0, dialogs: dialogs.length - d0, info: (await page.getByTestId('purchase-group-info-line').innerText()).replace(/\s+/gu, ' ') };
      assert.equal(result.lockWithValidDraft.writes, 1); assert.equal(result.lockWithValidDraft.dialogs, 0);
      assert.match(result.lockWithValidDraft.info, /結單日：2027\/07\/07 發售月份：2027\/08/u);
      // Lock with an incomplete closing date: existing confirmation; cancel keeps edit mode + draft; confirm discards, 0 writes.
      await page.getByRole('button', { name: /^(✏️ 編輯中|🔒 已鎖定)$/u }).click();
      L = await level2(page);
      await typeInto(page, L.input('closing_date'), '2027/0');
      const w1 = await saves(page);
      page.__dialogAnswer = false;
      await page.getByRole('button', { name: /^(✏️ 編輯中|🔒 已鎖定)$/u }).click(); await sleep(300);
      assert.equal(await L.input('closing_date').inputValue(), '2027/0');
      page.__dialogAnswer = true;
      await page.getByRole('button', { name: /^(✏️ 編輯中|🔒 已鎖定)$/u }).click();
      await page.getByTestId('purchase-group-basic-info').waitFor({ state: 'detached' });
      result.lockWithIncompleteDraft = { writes: (await saves(page)) - w1, stored: (await serverGroup(page)).closing_date };
      assert.equal(result.lockWithIncompleteDraft.writes, 0); assert.equal(result.lockWithIncompleteDraft.stored, '2027/07/07');
      await page.getByRole('button', { name: /^(✏️ 編輯中|🔒 已鎖定)$/u }).click();
      // Level 1 shows the same stored row; edit there; level 2 shows it.
      await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records'));
      const row = page.getByRole('row').filter({ hasText: 'hololive active' }).first();
      await row.waitFor();
      result.l1Display = (await row.innerText()).replace(/\s+/gu, ' ').match(/結單 \S+ 發售：\S+ 🔗 官網/u)?.[0];
      assert.equal(result.l1Display, '結單 07/07 發售：2027年08月 🔗 官網');
      assert.equal(await row.locator('a', { hasText: '官網' }).getAttribute('href'), 'https://example.com/l2-saved');
      const L1 = await level1(page);
      await typeInto(page, L1.input('closing_date'), '20271010'); await L1.input('closing_date').press('Tab');
      await typeInto(page, L1.input('release_month'), '2027-10'); await L1.input('release_month').press('Enter');
      await typeInto(page, L1.input('product_url'), 'https://example.com/l1-saved'); await clickAway(page);
      await page.waitForFunction(() => { const h = window.__P0_REACT_HARNESS__; return h.server.productGroups.find(x => x.id === h.fixtureId('g-holo')).product_url === 'https://example.com/l1-saved'; });
      // Level 1 leave edit mode (existing toggle) with nothing pending: no extra write.
      const w2 = await saves(page);
      await page.getByTestId('purchase-records-edit-mode-toggle').click(); await sleep(400);
      assert.equal((await saves(page)) - w2, 0);
      await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records/' + window.__P0_REACT_HARNESS__.fixtureId('g-holo')));
      L = await level2(page);
      result.l1ToL2 = { closing: await L.input('closing_date').inputValue(), release: await L.input('release_month').inputValue(), url: await L.input('product_url').inputValue(),
        href: await page.getByTestId('purchase-group-official-link').getAttribute('href') };
      assert.deepEqual(result.l1ToL2, { closing: '2027/10/10', release: '2027-10', url: 'https://example.com/l1-saved', href: 'https://example.com/l1-saved' });
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 1));
} finally { vite.kill(); }
