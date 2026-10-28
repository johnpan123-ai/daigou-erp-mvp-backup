import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { comparePurchaseRecordGroups, sortPurchaseRecordGroups } from '../src/lib/purchaseRecordsSort.ts';

// ---- Pure comparator: deterministic tie-breaker, no in-place mutation.
const normalizeTitle = title => title.replace(/^代理版\s*/u, '').replace(/\s+/gu, ' ').trim().toLowerCase();
const parseReleaseYm = raw => { const m = String(raw || '').match(/(\d{4})\D(\d{1,2})/u); return m ? { tier: 1, ym: Number(m[1]) * 12 + Number(m[2]) } : { tier: 2, ym: 0 }; };
const ctx = sortMode => ({ sortMode, isClosed: () => false, normalizeTitle, parseReleaseYm });
const same = Array.from({ length: 8 }, (_, i) => ({
  id: `g-${String((i * 5) % 8).padStart(2, '0')}`, title: `代理版 同日商品 ${String.fromCharCode(72 - i)}`,
  closing_date: '2026/12/15', release_month: '2026/12', created_at: '2026-08-01T00:00:00.000Z', proxy_agent: '',
}));
const dupTitle = [{ id: 'z-2', title: 'Same', closing_date: '2026/12/15' }, { id: 'z-1', title: 'Same', closing_date: '2026/12/15' }];
for (const mode of ['closing_asc', 'closing_name', 'closing_urgent', 'release_asc', 'created_desc']) {
  const expected = sortPurchaseRecordGroups([...same, ...dupTitle], ctx(mode)).map(g => g.id);
  for (let n = 0; n < 30; n++) {
    const shuffled = [...same, ...dupTitle].map(g => ({ g, k: Math.sin(n * 97 + g.id.length * 13 + g.id.charCodeAt(2)) })).sort((a, b) => a.k - b.k).map(x => x.g);
    assert.deepEqual(sortPurchaseRecordGroups(shuffled, ctx(mode)).map(g => g.id), expected, `${mode} must not depend on input order`);
  }
  // Targeted cache merge moves an edited row to the END of the collection.
  const edited = [...same.slice(0, 3), ...same.slice(4), { ...same[3], proxy_agent: '鉅霖' }];
  assert.deepEqual(sortPurchaseRecordGroups([...edited, ...dupTitle], ctx(mode)).map(g => g.id), expected, `${mode}: agent edit must not move rows`);
}
assert.ok(comparePurchaseRecordGroups(dupTitle[1], dupTitle[0], ctx('closing_asc')) < 0, 'identical keys fall back to unique id');
const input = [...same]; const snapshot = input.map(g => g.id);
sortPurchaseRecordGroups(input, ctx('closing_asc'));
assert.deepEqual(input.map(g => g.id), snapshot, 'shared input array must not be sorted in place');
console.log('PASS comparator is deterministic for every sort mode and never mutates input');

// ---- Browser: 代理版商品 + 只看需要採購 + 結單日（近到遠）, edit 5 agents in a row.
const PORT = 4288;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const vite = spawn(process.execPath, [VITE, '--mode', 'experimental', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TITLES = ['代理版 Hikari 立牌', '代理版 Aoi 掛軸', '代理版 Fuyu 徽章', '代理版 Beni 抱枕', '代理版 Gin 色紙', '代理版 Chika 杯墊', '代理版 Eri 吊飾', '代理版 Dai 海報'];
const LATER = '代理版 Later 月曆';

let browser;
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  const supabaseRequests = []; const pageErrors = [];
  page.on('request', request => { if (/\.supabase\.co\//iu.test(request.url())) supabaseRequests.push(request.url()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ titles, later }) => {
    localStorage.setItem('erp_sort_mode', 'closing_urgent');
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    const group = (id, title, closing) => ({ id, title, normalized_title: title, purchase_date: '2026/08/01', priority: 'Medium',
      closing_date: closing, release_month: '2027/01', has_official_site: false, product_url: '', listing_type: '代理版',
      source_type: '代理版', created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' });
    // Cache order deliberately differs from both title and id order.
    const groups = titles.map((title, i) => group(`pg-${String((i * 3) % 8)}`, title, '2026/12/15'));
    groups.splice(4, 0, group('pg-later', later, '2026/12/20'));
    await dataProvider.saveProductGroups(groups);
    await dataProvider.saveProductVariants(groups.map((g, i) => ({ id: `pv-${g.id}`, product_group_id: g.id, product_title: g.title,
      variant_name: '單品', myacg_item_code: `SORT-${i}`, sort_order: 0, waca_auto_quantity: 3 })));
  }, { titles: TITLES, later: LATER });

  const visibleOrder = () => page.evaluate(names => {
    const text = document.querySelector('main')?.innerText ?? document.body.innerText;
    return names.map(name => [name, text.indexOf(name)]).filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]).map(([name]) => name);
  }, [...TITLES, LATER]);
  const openView = async () => {
    await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^代理版商品/u }).click();
    const needs = page.getByLabel(/只看需要採購/u).first();
    if (!(await needs.isChecked())) await needs.check();
    await page.locator('select:has(option[value="closing_asc"]):visible').first().selectOption('closing_asc');
    await page.getByText(TITLES[0]).first().waitFor();
  };
  await openView();
  const expected = await visibleOrder();
  assert.equal(expected.length, 9);
  assert.equal(expected.at(-1), LATER, 'later closing date stays after the same-date block');

  const rowFor = title => page.getByRole('row').filter({ hasText: title });
  const editTargets = [expected[3], expected[0], expected[6], expected[2], expected[5]];
  const agents = ['鉅霖', '萬榮', '鉅霖', '萬榮', '鉅霖'];
  for (let i = 0; i < editTargets.length; i++) {
    const select = rowFor(editTargets[i]).locator('select:has(option[value="鉅霖"])');
    await select.selectOption(agents[i]);
    await page.waitForFunction(async ({ title, agent }) => {
      const { dataProvider } = await import('/src/providers/dataProvider.ts');
      return (await dataProvider.getProductGroups()).find(g => g.title === title)?.proxy_agent === agent;
    }, { title: editTargets[i], agent: agents[i] });
    assert.deepEqual(await visibleOrder(), expected, `edit #${i + 1}: other rows must not move after save`);
    assert.equal(await rowFor(editTargets[i]).locator('select:has(option[value="鉅霖"])').inputValue(), agents[i], 'edited row shows its own saved agent');
    // Realtime/targeted merge equivalent: authoritative cache now holds the edited row LAST.
    await page.evaluate(async title => {
      const { dataProvider } = await import('/src/providers/dataProvider.ts');
      const rows = await dataProvider.getProductGroups();
      const edited = rows.find(g => g.title === title);
      await dataProvider.saveProductGroups([...rows.filter(g => g !== edited), { ...edited, version: (edited.version ?? 1) + 1 }]);
    }, editTargets[i]);
    await openView();
    assert.deepEqual(await visibleOrder(), expected, `edit #${i + 1}: reordered cache + refresh must keep the same order`);
  }
  // Every other row's agent is untouched; no cross-row writes.
  const saved = await page.evaluate(async () => {
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    return Object.fromEntries((await dataProvider.getProductGroups()).map(g => [g.title, g.proxy_agent ?? '']));
  });
  for (const title of [...TITLES, LATER]) {
    const index = editTargets.indexOf(title);
    assert.equal(saved[title], index >= 0 ? agents[index] : '', `agent of ${title}`);
  }
  console.log('PASS 5 consecutive agent edits keep every row in place (save, reordered cache, refresh)');

  // Switching sort mode re-sorts by the new rule; switching back restores the same order.
  await page.locator('select:has(option[value="closing_asc"]):visible').first().selectOption('release_asc');
  await page.locator('select:has(option[value="closing_asc"]):visible').first().selectOption('closing_asc');
  assert.deepEqual(await visibleOrder(), expected);
  console.log('PASS explicit sort switches are deterministic');

  // Mobile viewport shows the same order.
  await page.setViewportSize({ width: 390, height: 2400 });
  await openView();
  assert.deepEqual(await visibleOrder(), expected, 'mobile must match desktop order');
  console.log('PASS mobile order matches desktop');

  assert.deepEqual(supabaseRequests, [], 'Experimental local regression must not call Supabase');
  assert.deepEqual(pageErrors, [], `Unexpected browser errors: ${JSON.stringify(pageErrors)}`);
  console.log('PASS Production/Preview Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
  await Promise.race([new Promise(resolve => vite.once('exit', resolve)), sleep(2_000)]);
}
