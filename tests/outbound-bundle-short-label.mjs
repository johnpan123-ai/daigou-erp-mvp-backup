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
    ]);
    await dataProvider.saveBundleComponents(['v-bag', 'v-mask', 'v-stand'].map((id, i) => ({ id: `bc-${i}`, bundle_variant_id: 'v-set', component_variant_id: id })));
    await dataProvider.saveJapanPackages([{ id: 'jp-1', title: '合成包裹 01', status: 'arrived', arrived_at: '2026-10-20', created_at: at, updated_at: at }]);
    await dataProvider.saveJapanPackageItems([{ id: 'jpi-1', japan_package_id: 'jp-1', product_group_id: 'g-set', product_variant_id: 'v-set',
      product_title: listing, variant_name: '全套組', sku: 'G-SET-01', quantity: 2, checked: true, checked_at: at, created_at: at, updated_at: at }]);
    await dataProvider.saveOutboundShipments([{ id: 'ob-1', title: '合成出庫 01', status: 'received', received_at: at, created_at: at, updated_at: at }]);
    await dataProvider.saveOutboundShipmentItems([{ id: 'obi-1', outbound_shipment_id: 'ob-1', japan_package_item_id: 'jpi-1', product_group_id: 'g-set',
      product_variant_id: 'v-set', product_title: listing, variant_name: '全套組', sku: 'G-SET-01', quantity: 2, checked: false, created_at: at, updated_at: at }]);
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
  // Outer group/bundle context is unchanged.
  assert.ok((await page.locator('body').innerText()).includes('G-SET-01'), 'bundle SKU still shown');
  assert.deepEqual(pageErrors, []); assert.deepEqual(supabase, []);
  console.log(JSON.stringify({ result: 'PASS', desktop: results.desktop.rows, mobile: results.mobile.rows }));
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
  await Promise.race([new Promise(resolve => vite.once('exit', resolve)), sleep(2_000)]);
}
