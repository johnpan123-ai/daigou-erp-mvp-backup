import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4194';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4194', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await context.newPage();
const supabaseRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const display = await import('/src/lib/japanPackageReceivingDisplay.ts');
    const rawName = '【小河馬日本代購】 預購 商品A';
    const middlePreorder = '商品A 預購特典 掛軸';
    const variants = Object.freeze([
      Object.freeze({ id: 'variant-a3', myacg_item_code: 'A003', product_group_id: 'group-1', variant_name: '商品C' }),
      Object.freeze({ id: 'variant-a1', myacg_item_code: 'A001', product_group_id: 'group-1', variant_name: '商品A' }),
      Object.freeze({ id: 'variant-a2-first', myacg_item_code: 'A002', product_group_id: 'group-1', variant_name: '商品B-1' }),
      Object.freeze({ id: 'variant-no-sku-1', myacg_item_code: '', product_group_id: 'group-1', variant_name: '無碼商品1' }),
      Object.freeze({ id: 'variant-a2-second', myacg_item_code: 'A002', product_group_id: 'group-1', variant_name: '商品B-2' }),
      Object.freeze({ id: 'variant-no-sku-2', product_group_id: 'group-1', variant_name: '無碼商品2' }),
    ]);
    const relations = Object.freeze(variants.map((variant, index) => Object.freeze({
      id: `relation-${index}`,
      bundle_variant_id: 'bundle-parent',
      component_variant_id: variant.id,
    })));
    const originalVariants = JSON.stringify(variants);
    const originalRelations = JSON.stringify(relations);
    const sorted = display.sortJapanPackageReceivingBundleComponentsBySku(variants);
    const variantIds = new Set(variants.map(variant => variant.id));
    const bundleIds = new Set(['bundle-parent']);

    return {
      normalized: display.normalizeJapanPackageReceivingName(rawName),
      normalizedDatedExample: display.normalizeJapanPackageReceivingName('【小河馬日本代購】 預購 26年11月 Hololive 商品A 掛軸'),
      originalRawName: rawName,
      middlePreorder: display.normalizeJapanPackageReceivingName(middlePreorder),
      middleReleaseMonth: display.normalizeJapanPackageReceivingName('Hololive 26年11月 預購特典 掛軸'),
      prefixedMiddlePreorder: display.normalizeJapanPackageReceivingName('【小河馬日本代購】 商品A 預購特典 掛軸'),
      lookalikePrefix: display.normalizeJapanPackageReceivingName('【其他日本代購】 預購 商品A'),
      childNameWithoutParentRepeat: display.getJapanPackageReceivingBundleComponentName({
        productTitle: '【小河馬日本代購】 預購 Hololive 父商品完整標題',
        variantTitle: '掛軸',
      }),
      categorizedChildName: display.getJapanPackageReceivingBundleComponentName({
        productTitle: 'Hololive 父商品完整標題',
        variantTitle: '標準版',
        categoryTitle: '角色A 掛軸',
      }),
      genericChildName: display.getJapanPackageReceivingBundleComponentName({
        productTitle: '【小河馬日本代購】 預購 商品A',
        variantTitle: '單品',
      }),
      sortedIds: sorted.map(variant => variant.id),
      inputCount: variants.length,
      outputCount: sorted.length,
      sameObjectIdentities: sorted.every(variant => variants.includes(variant)),
      variantsUnchanged: JSON.stringify(variants) === originalVariants,
      relationsUnchanged: JSON.stringify(relations) === originalRelations,
      missingBundleRelations: relations.filter(relation => !bundleIds.has(relation.bundle_variant_id)).length,
      missingVariantRelations: relations.filter(relation => !variantIds.has(relation.component_variant_id)).length,
      unknownProductRisk: variants.filter(variant => variant.product_group_id !== 'group-1').length,
    };
  });

  assert.equal(result.normalized, '商品A');
  assert.equal(result.normalizedDatedExample, 'Hololive 商品A 掛軸');
  assert.equal(result.originalRawName, '【小河馬日本代購】 預購 商品A');
  assert.equal(result.middlePreorder, '商品A 預購特典 掛軸');
  assert.equal(result.middleReleaseMonth, 'Hololive 26年11月 預購特典 掛軸');
  assert.equal(result.prefixedMiddlePreorder, '商品A 預購特典 掛軸');
  assert.equal(result.lookalikePrefix, '【其他日本代購】 預購 商品A');
  console.log('PASS fixed storefront prefix normalization is anchored and leaves DB/source names unchanged');

  assert.equal(result.childNameWithoutParentRepeat, '掛軸');
  assert.equal(result.categorizedChildName, '角色A 掛軸｜標準版');
  assert.equal(result.genericChildName, '商品A');
  console.log('PASS receiving bundle rows keep identifying child names without repeating the parent full title');

  assert.deepEqual(result.sortedIds, [
    'variant-a1', 'variant-a2-first', 'variant-a2-second', 'variant-a3',
    'variant-no-sku-1', 'variant-no-sku-2',
  ]);
  assert.equal(result.outputCount, result.inputCount);
  assert.equal(result.sameObjectIdentities, true);
  console.log('PASS SKU order is stable, same-SKU rows remain separate, and no-SKU rows remain last');

  assert.equal(result.variantsUnchanged, true);
  assert.equal(result.relationsUnchanged, true);
  assert.equal(result.missingBundleRelations, 0);
  assert.equal(result.missingVariantRelations, 0);
  assert.equal(result.unknownProductRisk, 0);
  console.log('PASS item count, Bundle/Variant identities, orphan delta, and Unknown Product risk remain unchanged');

  const pageSource = await readFile(new URL('../src/pages/JapanPackageDetail.tsx', import.meta.url), 'utf8');
  assert.equal((pageSource.match(/📦 套組內容/g) || []).length, 0, 'Redundant expanded-card headings remain');
  assert.equal((pageSource.match(/bundleComps\.map\(renderBundleComponent\)/g) || []).length, 3, 'A receiving layout lost its component rows');
  assert.ok((pageSource.match(/套組內容/g) || []).length >= 6, 'Expand/collapse structure labels were removed');
  assert.ok(pageSource.includes('handleToggleCheck'), 'Receiving check behavior is no longer wired');
  console.log('PASS all three receiving layouts keep expand/collapse structure without redundant inner headings');

  assert.deepEqual(supabaseRequests, []);
  console.log('PASS Preview/Production Supabase requests = 0; display regression performs no data writes');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
