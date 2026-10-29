import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// 出庫明細「套組內含實體商品」: short component name + SKU + ×N only (synthetic data).
const PORT = 4291;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = process.env.OUTBOUND_BUNDLE_SHOTS || '';
const vite = spawn(process.execPath, [VITE, '--mode', 'experimental', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LISTING = '【小河馬日本代購】預購 26年12月 Hololive 測試ちゃん 誕生日紀念2026 合成測試商品';
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
  await page.evaluate(async listing => {
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    const at = '2026-10-01T00:00:00.000Z';
    await dataProvider.saveProductGroups([{ id: 'g-set', title: listing, normalized_title: listing, purchase_date: '2026/10/01', priority: 'Medium',
      closing_date: '2026/12/01', release_month: '2026/12', has_official_site: false, product_url: '', listing_type: '日本代購', created_at: at, updated_at: at }]);
    await dataProvider.saveProductCategories([{ id: 'c-acrylic', product_group_id: 'g-set', title: '壓克力立牌', sort_order: 1 }]);
    await dataProvider.saveProductVariants([
      { id: 'v-set', product_group_id: 'g-set', product_title: listing, variant_name: '全套組', myacg_item_code: 'G-SET-01', sort_order: 0 },
      { id: 'v-bag', product_group_id: 'g-set', product_title: listing, variant_name: '斜背腰包', myacg_item_code: 'G-BAG-01', sort_order: 1 },
      { id: 'v-mask', product_group_id: 'g-set', product_title: listing, variant_name: '眼罩', myacg_item_code: 'G-MASK-01', sort_order: 2 },
      { id: 'v-stand', product_group_id: 'g-set', product_category_id: 'c-acrylic', product_title: listing, variant_name: 'A款', myacg_item_code: 'G-STAND-A', sort_order: 3 },
      { id: 'v-set2', product_group_id: 'g-set', product_title: listing, variant_name: '小套組', myacg_item_code: 'G-SET-02', sort_order: 4 },
      { id: 'v-mask2', product_group_id: 'g-set', product_title: listing, variant_name: '眼罩', myacg_item_code: 'G-MASK-02', sort_order: 5 },
    ]);
    await dataProvider.saveBundleComponents([
      ...['v-bag', 'v-mask', 'v-stand'].map((id, i) => ({ id: `bc-${i}`, bundle_variant_id: 'v-set', component_variant_id: id })),
      ...['v-bag', 'v-mask2'].map((id, i) => ({ id: `bc2-${i}`, bundle_variant_id: 'v-set2', component_variant_id: id })),
    ]);
    await dataProvider.saveJapanPackages([{ id: 'jp-1', title: '合成包裹 01', status: 'arrived', arrived_at: '2026-10-20', created_at: at, updated_at: at }]);
    await dataProvider.saveJapanPackageItems([{ id: 'jpi-1', japan_package_id: 'jp-1', product_group_id: 'g-set', product_variant_id: 'v-set',
      product_title: listing, variant_name: '全套組', sku: 'G-SET-01', quantity: 4, checked: true, checked_at: at, created_at: at, updated_at: at },
    { id: 'jpi-2', japan_package_id: 'jp-1', product_group_id: 'g-set', product_variant_id: 'v-set2',
      product_title: listing, variant_name: '小套組', sku: 'G-SET-02', quantity: 1, checked: true, checked_at: at, created_at: at, updated_at: at },
    { id: 'jpi-3', japan_package_id: 'jp-1', product_group_id: 'g-set', product_variant_id: 'v-bag',
      product_title: listing, variant_name: '斜背腰包', sku: 'G-BAG-01', quantity: 1, checked: true, checked_at: at, created_at: at, updated_at: at }]);
    await dataProvider.saveOutboundShipments([{ id: 'ob-1', title: '合成出庫 01', status: 'received', received_at: at, created_at: at, updated_at: at },
      { id: 'ob-2', title: '合成出庫 02（彙總）', status: 'received', received_at: at, created_at: at, updated_at: at }]);
    const line = (id, ship, jpi, variant, name, sku, quantity) => ({ id, outbound_shipment_id: ship, japan_package_item_id: jpi, product_group_id: 'g-set',
      product_variant_id: variant, product_title: listing, variant_name: name, sku, quantity, checked: false, created_at: at, updated_at: at });
    await dataProvider.saveOutboundShipmentItems([line('obi-1', 'ob-1', 'jpi-1', 'v-set', '全套組', 'G-SET-01', 2),
      line('obi-2', 'ob-2', 'jpi-1', 'v-set', '全套組', 'G-SET-01', 2), line('obi-3', 'ob-2', 'jpi-2', 'v-set2', '小套組', 'G-SET-02', 1),
      line('obi-4', 'ob-2', 'jpi-3', 'v-bag', '斜背腰包', 'G-BAG-01', 1)]);
  }, LISTING);

  const check = async label => {
    await page.goto(`${BASE_URL}/outbound-shipments/ob-1`, { waitUntil: 'domcontentloaded' });
    const toggle = page.getByRole('button', { name: /展開套組/u }).first();
    await toggle.waitFor();
    await toggle.click();
    const block = page.getByText('套組內含實體商品').first();
    await block.waitFor();
    const rows = await page.locator('[data-testid="outbound-bundle-component"]').allInnerTexts().catch(() => []);
    const text = await block.locator('..').innerText();
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await block.locator('..').locator('..').screenshot({ path: `${SHOTS}/${label}.png` }); await page.screenshot({ path: `${SHOTS}/${label}-page.png`, fullPage: false }); }
    return { rows, text };
  };
  const results = {};
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 900 }]]) {
    await page.setViewportSize(viewport);
    results[label] = await check(label);
    const text = results[label].text;
    assert.doesNotMatch(text, /【|小河馬日本代購|預購|誕生日紀念/u, `${label}: no storefront listing title in bundle components`);
    for (const expected of ['斜背腰包', 'SKU: G-BAG-01', '眼罩', 'SKU: G-MASK-01', '壓克力立牌｜A款', 'SKU: G-STAND-A']) assert.ok(text.includes(expected), `${label}: ${expected}`);
    assert.equal((text.match(/×2/gu) || []).length, 3, `${label}: each component shows ×2`);
  }
  assert.deepEqual(results.desktop.rows, results.mobile.rows, 'desktop and mobile show the same component lines');

  // 各單品品項: same short names; grouping/quantities keyed by SKU only.
  const summaryFor = async label => {
    await page.goto(`${BASE_URL}/outbound-shipments/ob-2`, { waitUntil: 'domcontentloaded' });
    const toggle = page.getByRole('button', { name: /各單品品項/u }).first();
    await toggle.waitFor(); await toggle.click();
    const rows = page.locator('[data-testid="outbound-physical-sku-summary"]');
    let texts;
    if (await rows.count()) texts = await rows.allInnerTexts();
    else { const panel = toggle.locator('..'); await panel.locator('div').first().waitFor(); texts = (await panel.innerText()).split('\n').filter(Boolean); }
    if (SHOTS) await toggle.locator('..').screenshot({ path: `${SHOTS}/summary-${label}.png` });
    return texts.map(text => text.replace(/\s+/gu, ' ').trim());
  };
  const summaries = {};
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 900 }]]) {
    await page.setViewportSize(viewport);
    summaries[label] = await summaryFor(label);
    assert.deepEqual(summaries[label], ['斜背腰包×4 SKU: G-BAG-01', '眼罩×2 SKU: G-MASK-01', '眼罩×1 SKU: G-MASK-02', '壓克力立牌｜A款×2 SKU: G-STAND-A'],
      `${label}: short names, same-name SKUs stay separate, same-SKU quantities summed (2 bundle + 1 bundle + 1 direct)`);
  }
  // Outer group/bundle context is unchanged.
  assert.ok((await page.locator('body').innerText()).includes('G-SET-01'), 'bundle SKU still shown');
  assert.deepEqual(pageErrors, []); assert.deepEqual(supabase, []);
  console.log(JSON.stringify({ result: 'PASS', desktop: results.desktop.rows, mobile: results.mobile.rows, summary: summaries }));
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
  await Promise.race([new Promise(resolve => vite.once('exit', resolve)), sleep(2_000)]);
}
