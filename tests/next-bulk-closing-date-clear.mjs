import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4265;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const vite = spawn(process.execPath, [
  VITE,
  '--mode', 'next',
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--strictPort',
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const waitForVite = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
};

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const productionSupabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//i.test(request.url())) productionSupabaseRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const fixture = await page.evaluate(async () => {
    const clearing = await import('/src/lib/nextFieldTestClosingDate.ts');
    const rawProbe = await import('/src/lib/nextRawDbIntegrityProbe.ts');
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    const base = (id, closingDate, extra = {}) => ({
      id,
      purchase_date: '2026/08/19',
      priority: 'Medium',
      title: `Field Test ${id}`,
      normalized_title: `field test ${id}`,
      listing_type: '代理版',
      closing_date: closingDate,
      release_month: '2027/01',
      has_official_site: true,
      product_url: `https://example.invalid/${id}`,
      proxy_agent: '萬榮',
      show_in_purchase_list: false,
      created_at: '2026-08-19T00:00:00.000Z',
      updated_at: '2026-08-19T00:00:00.000Z',
      ...extra,
    });

    const original = [
      base('dated-a', '2026/09/01'),
      base('dated-b', '2026/09/02'),
      base('dated-c', '2026/09/03'),
      base('empty-d', ''),
      base('untouched-e', '2026/10/01', { proxy_agent: '鉅霖' }),
    ];
    await dataProvider.saveProductGroups(original);
    const variants = [{
      id: 'variant-a',
      product_group_id: 'dated-a',
      myacg_item_code: 'FIELD-TEST-A',
      product_title: 'Field Test dated-a',
      variant_name: '單一品項',
      waca_manual_adjustment: 4,
      purchased_manual_adjustment: 9,
      note: '',
      sort_order: 0,
    }];
    const batches = [{
      id: 'batch-a',
      product_group_id: 'dated-a',
      name: 'Field Test Batch',
      date: '2026-08-19',
      note: '',
      created_at: '2026-08-19T00:00:00.000Z',
    }];
    const batchItems = [{
      id: 'batch-item-a',
      purchase_batch_id: 'batch-a',
      product_variant_id: 'variant-a',
      quantity: 1,
      cost: 1000,
      note: '',
    }];
    await dataProvider.saveProductVariants(variants);
    await dataProvider.savePurchaseBatches(batches);
    await dataProvider.savePurchaseBatchItems(batchItems);
    const physicalBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');

    const case1 = clearing.createNextFieldTestClosingDateClearPlan(
      original,
      new Set(['dated-a', 'dated-b', 'dated-c']),
    );
    await dataProvider.saveProductGroups(case1.nextGroups);
    const rawAfterCase1 = await rawProbe.readNextRawCollections();
    clearing.assertNextFieldTestProductGroupsReadback(case1.nextGroups, rawAfterCase1.productGroups);
    const physicalAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const allPhysicalKeys = Array.from(new Set([...Object.keys(physicalBefore), ...Object.keys(physicalAfter)]));
    const nonGroupCollectionsUnchanged = allPhysicalKeys
      .filter(key => key !== 'erp_product_groups')
      .every(key => JSON.stringify(physicalBefore[key]) === JSON.stringify(physicalAfter[key]));
    const variantIdsBefore = variants.map(variant => variant.id).sort();
    const variantIdsAfter = rawAfterCase1.productVariants.map(variant => String(variant.id)).sort();
    const batchItemVariantOrphans = rawAfterCase1.purchaseBatchItems.filter(item => (
      item.product_variant_id
      && !new Set(rawAfterCase1.productVariants.map(variant => variant.id)).has(item.product_variant_id)
    )).length;

    const case2 = clearing.createNextFieldTestClosingDateClearPlan(
      original,
      new Set(['dated-a', 'dated-b', 'empty-d']),
    );
    const case3 = clearing.createNextFieldTestClosingDateClearPlan(original, new Set());

    let tamperRejected = false;
    try {
      clearing.assertNextFieldTestProductGroupsReadback(
        case1.nextGroups,
        case1.nextGroups.map(group => group.id === 'dated-a' ? { ...group, title: 'unexpected mutation' } : group),
      );
    } catch {
      tamperRejected = true;
    }

    return {
      original,
      case1,
      case2,
      case3,
      rawAfterCase1: rawAfterCase1.productGroups,
      nonGroupCollectionsUnchanged,
      variantIdsBefore,
      variantIdsAfter,
      batchItemVariantOrphans,
      tamperRejected,
      providerMode: localStorage.getItem('erp_provider_mode'),
      modeGate: {
        next: clearing.canUseNextFieldTestClosingDateClear('next'),
        test: clearing.canUseNextFieldTestClosingDateClear('test'),
        experimental: clearing.canUseNextFieldTestClosingDateClear('experimental'),
        local: clearing.canUseNextFieldTestClosingDateClear('local'),
        cloud: clearing.canUseNextFieldTestClosingDateClear('cloud'),
      },
    };
  });

  assert.equal(fixture.providerMode, 'next');
  assert.deepEqual(fixture.modeGate, {
    next: true,
    test: false,
    experimental: false,
    local: false,
    cloud: false,
  });
  assert.equal(fixture.case1.modifiedCount, 3);
  assert.equal(fixture.case1.alreadyEmptyCount, 0);
  assert.ok(fixture.case1.nextGroups.slice(0, 3).every(group => group.closing_date === ''));
  assert.deepEqual(fixture.case1.nextGroups[4], fixture.original[4], 'Unselected group must remain byte-for-byte unchanged');
  assert.equal(fixture.case2.modifiedCount, 2);
  assert.equal(fixture.case2.alreadyEmptyCount, 1);
  assert.equal(fixture.case3.modifiedCount, 0);
  assert.equal(fixture.case3.selectedCount, 0);
  assert.equal(fixture.tamperRejected, true, 'Readback validation must reject any non-closing-date mutation');
  assert.equal(fixture.nonGroupCollectionsUnchanged, true, 'All non-ProductGroup IndexedDB collections must remain unchanged');
  assert.deepEqual(fixture.variantIdsAfter, fixture.variantIdsBefore, 'Variant IDs must remain unchanged');
  assert.equal(fixture.batchItemVariantOrphans, 0, 'BatchItem to Variant orphan count must remain unchanged');

  await page.reload({ waitUntil: 'domcontentloaded' });
  const persisted = await page.evaluate(async () => {
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    return dataProvider.getProductGroups();
  });
  assert.ok(persisted.slice(0, 3).every(group => group.closing_date === ''), 'Cleared closing dates must persist after F5');
  assert.deepEqual(persisted[4], fixture.original[4], 'Other ProductGroup fields must remain unchanged after F5');
  assert.deepEqual(productionSupabaseRequests, [], 'Next field-test clear must not contact Production Supabase');

  console.log('PASS 3 dated ProductGroups clear only closing_date');
  console.log('PASS mixed selection reports modified 2 / already empty 1');
  console.log('PASS empty selection produces 0 changes');
  console.log('PASS action is available only in Next mode');
  console.log('PASS raw Next DB readback rejects unexpected field mutations');
  console.log('PASS Variant IDs and non-ProductGroup collections remain unchanged');
  console.log('PASS BatchItem to Variant orphan count remains unchanged');
  console.log('PASS F5 preserves cleared closing_date values');
  console.log('PASS Production Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
