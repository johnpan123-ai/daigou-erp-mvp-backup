// Write cost of 官方結單日 / 發售月份 / 官網網址 edits on Purchase Records level 1 (and level 2 when present).
// Counts product-group saves (each one = one Supabase upsert + one Realtime row event in Cloud), page reads and
// targeted reads while typing, on Blur, on Enter (+ the Blur it causes), and for an unchanged value.
// MEASURE_ONLY=1 reports without asserting (used to measure the previous behaviour on the base commit).
// Isolated React harness (experimental provider, in-memory server, uuid fixtures, no Supabase). Port: WRITE_COST_PORT (4727).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.WRITE_COST_PORT || '4727';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-p0-2-react-harness.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MEASURE_ONLY = process.env.MEASURE_ONLY === '1';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; vite.stdout.on('data', c => { output += c; }); vite.stderr.on('data', c => { output += c; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = {};

const counters = page => page.evaluate(() => {
  const s = window.__P0_REACT_HARNESS__.snapshot();
  return { groupSaves: s.writesByMethod?.saveProductGroups ?? s.writes, writes: s.writes,
    pageLoads: Object.values(s.pageLoads).reduce((a, b) => a + b, 0), targeted: s.targetedQueries ?? 0 };
});
const diff = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, b[k] - a[k]]));
const serverGroup = page => page.evaluate(() => {
  const h = window.__P0_REACT_HARNESS__; const g = h.server.productGroups.find(r => r.id === h.fixtureId('g-holo'));
  return { closing_date: g.closing_date, release_month: g.release_month, product_url: g.product_url };
});

const measure = async (page, input, text, finish) => {
  const c0 = await counters(page);
  await input.click(); await input.press('Control+A'); await input.press('Backspace');
  await page.keyboard.type(text, { delay: 15 });
  await sleep(400);
  const c1 = await counters(page);
  if (finish === 'blur') await page.locator('body').click({ position: { x: 5, y: 5 } });
  else if (finish === 'enter') { await input.press('Enter'); await page.locator('body').click({ position: { x: 5, y: 5 } }); }
  await sleep(600);
  const c2 = await counters(page);
  return { chars: text.length, whileTyping: diff(c0, c1), onFinish: diff(c1, c2), total: diff(c0, c2) };
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
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.addInitScript(() => { localStorage.setItem('erp_provider_mode', 'experimental'); localStorage.setItem('purchase_management_edit_mode', 'true'); });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => void d.accept());
    await page.goto(`${BASE_URL}?route=${encodeURIComponent('/purchase-records')}&uuidFixtures=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
    const row = page.getByRole('row').filter({ hasText: 'hololive active' }).first();
    await row.waitFor();
    await page.getByTestId('purchase-records-edit-mode-toggle').click();
    const field = name => row.locator(`input[data-field="${name}"]`).first();
    await field('release_month').waitFor();
    const L1 = {};
    L1.releaseMonthBlur = await measure(page, field('release_month'), '2027-02', 'blur');
    L1.productUrlBlur = await measure(page, field('product_url'), 'https://example.com/holo-l1', 'blur');
    L1.closingDateBlur = await measure(page, field('closing_date'), '20270215', 'blur');
    L1.releaseMonthEnterThenBlur = await measure(page, field('release_month'), '2027-03', 'enter');
    L1.productUrlEnterThenBlur = await measure(page, field('product_url'), 'https://example.com/holo-l1b', 'enter');
    L1.closingDateEnterThenBlur = await measure(page, field('closing_date'), '20270301', 'enter');
    L1.releaseMonthUnchanged = await measure(page, field('release_month'), '2027-03', 'blur');
    L1.productUrlUnchanged = await measure(page, field('product_url'), 'https://example.com/holo-l1b', 'blur');
    L1.closingDateUnchanged = await measure(page, field('closing_date'), '2027/03/01', 'blur');
    L1.saved = await serverGroup(page);
    result.level1 = L1;
    // Level 2 (product detail), when the basic-info card exists on this tree.
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records/' + window.__P0_REACT_HARNESS__.fixtureId('g-holo')));
    await sleep(1500);
    if (await page.getByTestId('purchase-group-basic-info').count()) {
      const f2 = id => page.getByTestId(id);
      const L2 = {};
      L2.releaseMonthBlur = await measure(page, f2('purchase-group-release-month'), '2027-04', 'blur');
      L2.productUrlBlur = await measure(page, f2('purchase-group-product-url'), 'https://example.com/holo-l2', 'blur');
      L2.closingDateBlur = await measure(page, f2('purchase-group-closing-date'), '20270410', 'blur');
      L2.releaseMonthEnterThenBlur = await measure(page, f2('purchase-group-release-month'), '2027-05', 'enter');
      L2.productUrlEnterThenBlur = await measure(page, f2('purchase-group-product-url'), 'https://example.com/holo-l2b', 'enter');
      L2.closingDateEnterThenBlur = await measure(page, f2('purchase-group-closing-date'), '20270511', 'enter');
      L2.releaseMonthUnchanged = await measure(page, f2('purchase-group-release-month'), '2027-05', 'blur');
      L2.productUrlUnchanged = await measure(page, f2('purchase-group-product-url'), 'https://example.com/holo-l2b', 'blur');
      L2.closingDateUnchanged = await measure(page, f2('purchase-group-closing-date'), '2027/05/11', 'blur');
      L2.saved = await serverGroup(page);
      result.level2 = L2;
    } else result.level2 = 'NOT PRESENT ON THIS TREE';
    result.errors = errors;
    if (!MEASURE_ONLY) {
      for (const [level, rows] of [['level1', result.level1], ['level2', result.level2]]) {
        for (const [name, m] of Object.entries(rows)) {
          if (name === 'saved') continue;
          assert.equal(m.whileTyping.groupSaves, 0, `${level}.${name}: zero writes while typing`);
          assert.equal(m.total.groupSaves, name.endsWith('Unchanged') ? 0 : 1, `${level}.${name}: one write per edit (0 when unchanged)`);
          assert.equal(m.total.pageLoads, 0, `${level}.${name}: no extra full page reads`);
        }
      }
      assert.deepEqual(result.level1.saved, { closing_date: '2027/03/01', release_month: '2027-03', product_url: 'https://example.com/holo-l1b' });
      assert.deepEqual(result.level2.saved, { closing_date: '2027/05/11', release_month: '2027-05', product_url: 'https://example.com/holo-l2b' });
      assert.deepEqual(errors, []);
    }
    await context.close();
  } finally { await browser.close(); }
  console.log(JSON.stringify({ result: MEASURE_ONLY ? 'MEASURED' : 'PASS', ...result }, null, 1));
} finally { vite.kill(); }
