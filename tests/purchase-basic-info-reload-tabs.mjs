// 官方結單日 / 發售月份 / 官網網址: browser refresh and two real tabs (same browser profile, shared IndexedDB), level 1 + level 2.
// Experimental local provider (persists in IndexedDB; no Supabase). Port: BASIC_INFO_TABS_PORT (4729).
// - level 2 save -> refresh -> level 1 and level 2 show the stored values;
// - tab B saves while tab A holds a draft of the same field: tab A's draft is not overwritten, and tab A's Blur / Enter does
//   not overwrite tab B's newer value (existing cross-tab stale guard); after reload tab A shows tab B's value.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = process.env.BASIC_INFO_TABS_PORT || '4729';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; vite.stdout.on('data', c => { output += c; }); vite.stderr.on('data', c => { output += c; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const GROUP = 'basic-info-group';
const result = {};

const stored = page => page.evaluate(async id => {
  const { dataProvider } = await import('/src/providers/dataProvider.ts');
  const g = (await dataProvider.getProductGroups()).find(row => row.id === id);
  return { closing_date: g.closing_date, release_month: g.release_month, product_url: g.product_url };
}, GROUP);
const typeInto = async (page, input, text) => { await input.click(); await input.press('Control+A'); await input.press('Backspace'); await page.keyboard.type(text, { delay: 10 }); };
// Level 2 in 編輯模式 (uses the page's own toggle when it opens locked).
const openLevel2Edit = async page => {
  await page.getByTestId('purchase-group-info-line').waitFor();
  if (!(await page.getByTestId('purchase-group-basic-info').count())) await page.getByRole('button', { name: /^(✏️ 編輯中|🔒 已鎖定)$/u }).click();
  await page.getByTestId('purchase-group-basic-info').waitFor();
};
const level1Row = page => page.getByRole('row').filter({ hasText: 'Basic Info Product' }).first();
const openLevel1Edit = async page => {
  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'domcontentloaded' });
  const tab = page.getByRole('button', { name: /^全部/u }).first();
  if (await tab.count()) await tab.click();
  await level1Row(page).waitFor();
  await page.getByTestId('purchase-records-edit-mode-toggle').click();
  await level1Row(page).locator('input[data-field="release_month"]').waitFor();
  return name => level1Row(page).locator(`input[data-field="${name}"]`).first();
};

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 99) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(100);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('purchase_management_edit_mode', 'true'));
    const errors = []; const supabase = []; const dialogs = [];
    const watch = page => {
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => { if (/\.supabase\.co\//iu.test(r.url())) supabase.push(r.url()); });
      page.on('dialog', d => { dialogs.push(d.message()); void d.accept(); });
      return page;
    };
    const tabA = watch(await context.newPage());
    await tabA.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await tabA.evaluate(async id => {
      const { dataProvider } = await import('/src/providers/dataProvider.ts');
      await dataProvider.saveProductGroups([{ id, title: 'Basic Info Product', normalized_title: 'Basic Info Product', purchase_date: '2026/10/01',
        priority: 'Medium', closing_date: '2099/12/31', release_month: '2099-12', has_official_site: true, product_url: 'https://example.com/seed',
        listing_type: '日本代購', source_type: 'direct', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }]);
      await dataProvider.saveProductVariants([{ id: `${id}-v`, product_group_id: id, product_title: 'Basic Info Product', variant_name: '單品', myacg_item_code: 'BASIC-INFO-1', sort_order: 0 }]);
    }, GROUP);

    // ---- Level 2 save, then a real browser refresh; level 1 and level 2 agree ----
    await tabA.goto(`${BASE_URL}/purchase-records/${GROUP}`, { waitUntil: 'domcontentloaded' });
    await openLevel2Edit(tabA);
    await typeInto(tabA, tabA.getByTestId('purchase-group-closing-date'), '20271111'); await tabA.getByTestId('purchase-group-closing-date').press('Enter');
    await typeInto(tabA, tabA.getByTestId('purchase-group-release-month'), '2027-11'); await tabA.getByTestId('purchase-group-release-month').press('Tab');
    await typeInto(tabA, tabA.getByTestId('purchase-group-product-url'), 'https://example.com/after-refresh'); await tabA.getByTestId('purchase-group-product-url').press('Enter');
    await tabA.waitForFunction(() => document.querySelector('[data-testid="purchase-group-official-link"]')?.getAttribute('href') === 'https://example.com/after-refresh');
    await tabA.reload({ waitUntil: 'domcontentloaded' });
    await openLevel2Edit(tabA);
    result.level2AfterRefresh = { closing: await tabA.getByTestId('purchase-group-closing-date').inputValue(), release: await tabA.getByTestId('purchase-group-release-month').inputValue(),
      url: await tabA.getByTestId('purchase-group-product-url').inputValue(), href: await tabA.getByTestId('purchase-group-official-link').getAttribute('href') };
    assert.deepEqual(result.level2AfterRefresh, { closing: '2027/11/11', release: '2027-11', url: 'https://example.com/after-refresh', href: 'https://example.com/after-refresh' });
    let field = await openLevel1Edit(tabA);
    result.level1AfterRefresh = { closing: await field('closing_date').inputValue(), release: await field('release_month').inputValue(), url: await field('product_url').inputValue() };
    assert.deepEqual(result.level1AfterRefresh, { closing: '2027/11/11', release: '2027-11', url: 'https://example.com/after-refresh' });
    // Level 1 save -> refresh -> level 2.
    await typeInto(tabA, field('release_month'), '2027-12'); await field('release_month').press('Enter');
    await tabA.waitForFunction(async id => { const { dataProvider } = await import('/src/providers/dataProvider.ts');
      return (await dataProvider.getProductGroups()).find(g => g.id === id)?.release_month === '2027-12'; }, GROUP);
    await tabA.goto(`${BASE_URL}/purchase-records/${GROUP}`, { waitUntil: 'domcontentloaded' });
    await tabA.reload({ waitUntil: 'domcontentloaded' });
    await openLevel2Edit(tabA);
    result.level2AfterLevel1Save = await tabA.getByTestId('purchase-group-release-month').inputValue();
    assert.equal(result.level2AfterLevel1Save, '2027-12');

    // ---- Two real tabs: B saves while A holds a draft of the same field ----
    await tabA.goto(`${BASE_URL}/purchase-records/${GROUP}`, { waitUntil: 'domcontentloaded' });
    await openLevel2Edit(tabA);
    const tabB = watch(await context.newPage());
    field = await openLevel1Edit(tabB);
    await typeInto(tabA, tabA.getByTestId('purchase-group-product-url'), 'https://example.com/tab-a-draft');
    await typeInto(tabB, field('product_url'), 'https://example.com/tab-b-saved'); await field('product_url').press('Enter');
    await tabB.waitForFunction(async id => { const { dataProvider } = await import('/src/providers/dataProvider.ts');
      return (await dataProvider.getProductGroups()).find(g => g.id === id)?.product_url === 'https://example.com/tab-b-saved'; }, GROUP);
    await sleep(800);
    const draftInA = await tabA.getByTestId('purchase-group-product-url').inputValue();
    const d0 = dialogs.length;
    await tabA.getByTestId('purchase-group-product-url').click(); await tabA.getByTestId('purchase-group-product-url').press('Enter'); await sleep(600);
    result.twoTabs = { draftInA, alertInA: dialogs.slice(d0).join(' | '), storedAfterAEnter: (await stored(tabA)).product_url,
      errorInA: (await tabA.getByTestId('purchase-group-closing-date-error').count()) ? await tabA.getByTestId('purchase-group-closing-date-error').innerText() : '' };
    assert.equal(result.twoTabs.draftInA, 'https://example.com/tab-a-draft', 'tab A draft not overwritten by tab B');
    assert.equal(result.twoTabs.storedAfterAEnter, 'https://example.com/tab-b-saved', "tab A's stale draft did not overwrite tab B's newer value");
    await tabA.reload({ waitUntil: 'domcontentloaded' });
    await openLevel2Edit(tabA);
    result.twoTabs.tabAAfterReload = await tabA.getByTestId('purchase-group-product-url').inputValue();
    assert.equal(result.twoTabs.tabAAfterReload, 'https://example.com/tab-b-saved');
    result.final = await stored(tabA);
    assert.deepEqual(errors, []); assert.deepEqual(supabase, []);
    await context.close();
  } finally { await browser.close(); }
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 1));
} finally { vite.kill(); }
