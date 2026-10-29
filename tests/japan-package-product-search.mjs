import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// 日本包裹管理: search packages by item name / SKU (synthetic data, local provider).
const PORT = 4293;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = process.env.PACKAGE_SEARCH_SHOTS || '';
const vite = spawn(process.execPath, [VITE, '--mode', 'experimental', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = []; const supabase = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (/\.supabase\.co\//iu.test(request.url())) supabase.push(request.url()); });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    const at = '2026-10-20T00:00:00.000Z';
    const pkg = (id, title, status, vendor, tracking, updated) => ({ id, title, vendor_name: vendor, carrier: 'ヤマト運輸 (Yamato)', tracking_number: tracking, status,
      ...(status === 'registered' ? {} : { arrived_at: '2026-10-21' }), created_at: at, updated_at: updated });
    const item = (id, packageId, title, variant, sku, quantity, checked) => ({ id, japan_package_id: packageId, product_title: title, variant_name: variant,
      sku, quantity, checked, ...(checked ? { checked_at: at } : {}), created_at: at, updated_at: at });
    await dataProvider.saveJapanPackages([
      pkg('jp-a', '合成包裹 A（10月預購）', 'registered', 'Booth', 'TEST-A-001', '2026-10-22T00:00:00.000Z'),
      pkg('jp-b', '合成包裹 B（點收完成）', 'registered', 'animate', 'TEST-B-002', '2026-10-21T00:00:00.000Z'),
      pkg('jp-c', '合成包裹 C（其他）', 'registered', '駿河屋', 'TEST-C-003', '2026-10-20T00:00:00.000Z'),
    ]);
    await dataProvider.saveJapanPackageItems([
      item('i-a1', 'jp-a', 'Hololive さくらみこ 誕生日記念2026 合成商品', '眼罩', 'G-MASK-01', 2, false),
      item('i-a2', 'jp-a', 'Hololive 兔田ぺこら 合成商品', '斜背腰包', 'G-BAG-01', 1, false),
      item('i-b1', 'jp-b', 'Hololive さくらみこ 誕生日記念2026 合成商品', '眼罩', 'G-MASK-01', 1, true),
      item('i-b2', 'jp-b', 'Hololive 宝鐘マリン 合成商品', '壓克力立牌', 'G-STAND-01', 1, true),
      item('i-b3', 'jp-b', 'Hololive 白上フブキ 合成商品', '徽章', 'G-BADGE-01', 3, true),
      item('i-b4', 'jp-b', 'Hololive 星街すいせい 合成商品', '色紙', 'G-CARD-01', 1, true),
      item('i-c1', 'jp-c', 'VSPO 合成商品', '毛巾', 'V-TOWEL-01', 1, false),
    ]);
    const packages = await dataProvider.getJapanPackages();
    await dataProvider.saveJapanPackages(packages.map(p => p.id === 'jp-b' ? { ...p, status: 'confirmed' } : p));
  });

  const open = async () => {
    await page.goto(`${BASE_URL}/japan-packages`, { waitUntil: 'domcontentloaded' });
    await page.getByText('合成包裹 A（10月預購）').first().waitFor();
    // Count cache reads from here on: typing must not reload package items.
    await page.evaluate(async () => {
      const { dataProvider } = await import('/src/providers/dataProvider.ts');
      const original = window.__packageSearchOriginalGetItems
        ?? dataProvider.getJapanPackageItems.bind(dataProvider);
      window.__packageSearchOriginalGetItems = original;
      window.__itemReads = 0;
      dataProvider.getJapanPackageItems = (...args) => { window.__itemReads++; return original(...args); };
    });
  };
  const search = page.locator('input[placeholder*="SKU"]:visible').first();
  const cards = () => page.locator(':is(.package-card, .mobile-package-card)');
  const visibleTitles = async () => (await cards().allInnerTexts()).map(text => (text.match(/合成包裹 [ABC]/u) || [''])[0]).filter(Boolean);
  const type = async value => { await search.fill(value); await sleep(250); };
  const statusChip = label => page.locator(':is(.chip, .mobile-wrap-chip):visible', { hasText: label }).first();

  const results = {};
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 900 }]]) {
    await page.setViewportSize(viewport);
    await open();
    assert.deepEqual(await visibleTitles(), ['合成包裹 A', '合成包裹 B', '合成包裹 C'].filter(t => t !== '合成包裹 B'), `${label}: default 已登記 tab`);
    // Route hydration may complete after the first visible row. Start the
    // measurement at the first search action, and never wrap the counter twice.
    await page.evaluate(() => { window.__itemReads = 0; });
    // 1. package name
    await type('合成包裹 B');
    assert.deepEqual(await visibleTitles(), ['合成包裹 B'], `${label}: package name across statuses`);
    assert.equal(await page.locator('[data-testid="package-search-matches"]').count(), 0, 'package-field match lists no items');
    // 2/4/5. item name in two packages, both statuses (current tab was 已登記)
    await type('眼罩');
    assert.deepEqual(await visibleTitles(), ['合成包裹 A', '合成包裹 B'], `${label}: item in two packages, registered + confirmed`);
    const matches = (await page.locator('[data-testid="package-search-match"]').allInnerTexts()).map(t => t.replace(/\s+/gu, ' ').trim());
    assert.deepEqual(matches, [
      'Hololive さくらみこ 誕生日記念2026 合成商品×2 規格：眼罩 SKU: G-MASK-01',
      'Hololive さくらみこ 誕生日記念2026 合成商品×1 規格：眼罩 SKU: G-MASK-01',
    ], `${label}: name, quantity, spec, SKU per package`);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${label}-search-item.png`, fullPage: label === 'mobile' }); }
    // 3. SKU, Japanese, English
    await type('g-mask-01'); assert.deepEqual(await visibleTitles(), ['合成包裹 A', '合成包裹 B'], `${label}: SKU (case-insensitive)`);
    await type('さくらみこ'); assert.deepEqual(await visibleTitles(), ['合成包裹 A', '合成包裹 B'], `${label}: Japanese name`);
    await type('Hololive');
    assert.deepEqual(await visibleTitles(), ['合成包裹 A', '合成包裹 B'], `${label}: English keyword`);
    const bMatches = page.locator(':is(.package-card, .mobile-package-card)', { hasText: '合成包裹 B' }).locator('[data-testid="package-search-match"]');
    assert.equal(await bMatches.count(), 3, `${label}: first 3 of 4 matches`);
    await page.locator(':is(.package-card, .mobile-package-card)', { hasText: '合成包裹 B' }).getByTestId('package-search-matches-toggle').click();
    assert.equal(await bMatches.count(), 4, `${label}: expand shows all matches`);
    assert.ok(page.url().endsWith('/japan-packages'), `${label}: expanding does not open the package`);
    // status filter applies to search results only
    await statusChip('已點收').click();
    assert.deepEqual(await visibleTitles(), ['合成包裹 B'], `${label}: status filter within search results`);
    await statusChip('全部').click();
    // 8. clearing restores the list's own tab (已登記)
    await type('');
    assert.deepEqual(await visibleTitles(), ['合成包裹 A', '合成包裹 C'], `${label}: cleared search restores 已登記`);
    assert.equal(await page.locator('[data-testid="package-search-matches"]').count(), 0);
    // 10. no item reload while typing. Capture before navigation because the
    // destination package detail legitimately reads its own item collection.
    await type('G-STAND-01');
    results[label] = { itemReadsWhileTyping: await page.evaluate(() => window.__itemReads) };
    assert.equal(results[label].itemReadsWhileTyping, 0, `${label}: typing must not re-read package items`);
    // 7. click a search result opens that package
    await page.locator(':is(.package-card, .mobile-package-card)', { hasText: '合成包裹 B' }).click({ position: { x: 20, y: 20 } });
    await page.waitForURL(url => url.pathname === '/japan-packages/jp-b');
  }
  // Package data unchanged by searching (read-only).
  const statuses = await page.evaluate(async () => {
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    return Object.fromEntries((await dataProvider.getJapanPackages()).map(p => [p.id, p.status]));
  });
  assert.deepEqual(statuses, { 'jp-a': 'registered', 'jp-b': 'confirmed', 'jp-c': 'registered' });
  assert.deepEqual(pageErrors, []); assert.deepEqual(supabase, []);
  console.log(JSON.stringify({ result: 'PASS', ...results }));
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
  await Promise.race([new Promise(resolve => vite.once('exit', resolve)), sleep(2_000)]);
}
