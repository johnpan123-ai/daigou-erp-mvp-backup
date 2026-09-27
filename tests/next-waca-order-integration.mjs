import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, cacheDir: '.vite-cache', server: { middlewareMode: true }, appType: 'custom' });
const {
  createWacaRepository, importWacaRows, isWacaDiscount, matchWacaItem,
  normalizeWacaText, refreshWacaMasterStatus, setWacaMapping, wacaFeature,
} = await vite.ssrLoadModule('/src/waca/orderCore.ts');
const { parseWacaWorkbook } = await vite.ssrLoadModule('/src/waca/workbookParser.ts');
const { buildWacaMasterReference, linksFromMyAcgInventory, mergeMyAcgMasterLinks } =
  await vite.ssrLoadModule('/src/waca/masterReference.ts');
const { repositoryFromSnapshot, snapshotFromRepository, validateNextWacaSnapshot } =
  await vite.ssrLoadModule('/src/waca/nextStorage.ts');
try {

const row = (value = {}) => ({
  orderStatus: '處理中', orderNumber: 'A', purchasedAt: '2026-08-01', productCode: 'GP-A',
  productTitle: 'Product', spec1: 'Red', spec2: '', specCode: '', quantity: 1, subtotal: 100,
  ...value,
});
const master = [
  { mainCode: 'GP-A', childCode: 'G-RED', variantId: 'vr', productGroupId: 'g', productTitle: 'Product', variantTitle: 'Red', active: true },
  { mainCode: 'GP-A', childCode: 'G-BLUE', variantId: 'vb', productGroupId: 'g', productTitle: 'Product', variantTitle: 'Blue', active: true },
  { mainCode: 'GP-B', childCode: 'G-OTHER', variantId: 'vo', productGroupId: 'other', productTitle: 'Product', variantTitle: 'Red', active: true },
];
assert.equal(normalizeWacaText(' Ａ  b '), 'A B');
assert.notEqual(normalizeWacaText('2026 Limited'), normalizeWacaText('2027 Limited'));
assert.equal(matchWacaItem(row(), master).candidate?.variantId, 'vr');
assert.equal(matchWacaItem(row({ productCode: 'G-BLUE', spec1: 'Blue' }), master).candidate?.variantId, 'vb');
assert.equal(matchWacaItem(row({ productCode: 'GP-MISSING' }), master).diagnostic, 'MASTER_MAPPING_MISSING');
assert.equal(matchWacaItem(row({ productCode: 'GP-MISSING' }), master, true).diagnostic, 'PRODUCT_NOT_IN_MASTER');
assert.equal(matchWacaItem(row({ spec1: 'Green' }), master).diagnostic, 'VARIANT_NOT_MATCHED');
assert.equal(matchWacaItem(row({ spec1: '' }), master).diagnostic, 'MULTIPLE_VARIANT_CANDIDATES');
assert.equal(matchWacaItem(row({ productTitle: 'Unrelated Figure' }), master).diagnostic, 'NAME_CONFLICT');
assert.equal(matchWacaItem(row({ productCode: 'GP-B' }), master).candidate?.variantId, 'vo');
assert.equal(isWacaDiscount(row({ productCode: 'CoUpOn' })), true);
assert.equal(isWacaDiscount(row({ productTitle: 'HIPPOSEP60' })), true);
assert.equal(isWacaDiscount(row({ spec1: '小河馬09月份60元折扣券' })), true);

const repo = createWacaRepository();
repo.manualAdjustments.set('vr', 4);
let result = importWacaRows([row()], repo, master, 'aug');
assert.equal(result.inserted, 1);
assert.equal(repo.autoQuantities.get('vr'), 1);
for (let repeat = 0; repeat < 5; repeat += 1) {
  result = importWacaRows([row()], repo, master, `repeat-${repeat}`);
  assert.equal(result.unchanged, 1);
  assert.equal(repo.autoQuantities.get('vr'), 1);
}
result = importWacaRows([row({ quantity: 2 }), row({ orderNumber: 'B' })], repo, master, 'aug-sep-overlap');
assert.equal(result.updated, 1);
assert.equal(repo.autoQuantities.get('vr'), 3);
result = importWacaRows([row({ orderNumber: 'B', quantity: 2 }), row({ orderNumber: 'C' })], repo, master, 'sep-oct-overlap');
assert.equal(repo.autoQuantities.get('vr'), 5);
assert.equal(repo.orders.size, 3);
importWacaRows([row({ orderStatus: '取消', quantity: 2 })], repo, master, 'cancel');
assert.equal(repo.autoQuantities.get('vr'), 3);
importWacaRows([row({ orderStatus: '處理中', quantity: 2 })], repo, master, 'reactivate');
assert.equal(repo.autoQuantities.get('vr'), 5);
importWacaRows([row({ orderNumber: 'C', orderStatus: '失敗' })], repo, master, 'fail');
assert.equal(repo.autoQuantities.get('vr'), 4);
result = importWacaRows([
  row({ orderNumber: 'D', quantity: 2 }), row({ orderNumber: 'D', quantity: 3 }),
  row({ orderNumber: 'D', spec1: 'Blue', quantity: 1 }),
  row({ orderNumber: 'D', productCode: 'coupon', productTitle: 'discount' }),
], repo, master, 'duplicate-and-multi-product');
assert.equal(repo.autoQuantities.get('vr'), 9);
assert.equal(repo.autoQuantities.get('vb'), 1);
assert.equal([...repo.items.values()].filter(item => item.orderKey === 'WACA::D').length, 2);
assert.equal(result.discountIgnored, 1);
result = importWacaRows([row({ orderNumber: 'D', orderStatus: '取消', quantity: 99 }), row({ orderNumber: 'D', quantity: 99 })], repo, master, 'status-conflict');
assert.deepEqual(result.statusConflicts, ['WACA::D']);
assert.equal(repo.autoQuantities.get('vr'), 9);
result = importWacaRows([row({ orderNumber: 'E', productCode: 'GP-MISSING', quantity: 4 })], repo, master, 'mapping-missing');
assert.equal(result.mappingMissing, 1);
assert.equal(result.effectiveQuantity, result.matchedEffectiveQuantity + result.unmatchedPendingQuantity);
const feature = wacaFeature(row());
setWacaMapping(repo, {
  feature, myacgMainId: 'GP-A', myacgVariantId: 'G-BLUE', productVariantId: 'vb',
  method: 'MANUAL', confirmedAt: '2026-09-28', historicalProductTitle: 'Product',
  historicalVariantTitle: 'Blue', masterStatus: 'ACTIVE',
});
assert.equal(repo.autoQuantities.get('vr') ?? 0, 0);
assert.equal(repo.autoQuantities.get('vb'), 10);
refreshWacaMasterStatus(repo, []);
assert.equal(repo.mappings.get(feature)?.masterStatus, 'MISSING_FROM_LATEST_MASTER');
assert.equal(repo.autoQuantities.get('vb'), 10);
importWacaRows([row({ orderNumber: 'A', quantity: 2 })], repo, [], 'later-without-B');
assert.equal(repo.orders.has('WACA::B'), true);
assert.equal(repo.autoQuantities.get('vb'), 10);

const partialOrderRepo = createWacaRepository();
importWacaRows([row(), row({ spec1: 'Blue' })], partialOrderRepo, master, 'both-items');
const partialResult = importWacaRows([row()], partialOrderRepo, master, 'one-item-only');
assert.equal(partialOrderRepo.items.size, 2, 'an omitted historical line is not silently deleted');
assert.equal(partialResult.effectiveQuantity, 1, 'the current import equation covers only rows in that file');
assert.equal(partialResult.matchedEffectiveQuantity + partialResult.unmatchedPendingQuantity, 1);

const variants = master.map(item => ({
  id: item.variantId, product_group_id: item.productGroupId, myacg_item_code: item.childCode,
  product_title: item.productTitle, variant_name: item.variantTitle, note: '', sort_order: 0,
  waca_manual_adjustment: item.variantId === 'vr' ? 4 : 0,
}));
const initial = { revision: 2, orders: [], items: [], mappings: [], batches: [], masterLinks: [] };
const backup = snapshotFromRepository(initial, repo, []);
const serialized = JSON.stringify(backup);
const recovered = JSON.parse(serialized);
validateNextWacaSnapshot(recovered, variants);
const restored = repositoryFromSnapshot(recovered, variants);
assert.deepEqual(restored.autoQuantities, repo.autoQuantities);
assert.equal(restored.manualAdjustments.get('vr'), 4);
assert.throws(() => validateNextWacaSnapshot({ ...recovered, orders: [] }, variants), /ORPHAN_ORDER/);
assert.throws(() => validateNextWacaSnapshot({ ...recovered, items: [...recovered.items, recovered.items[0]] }, variants), /DUPLICATE/);
console.log('PASS WACA idempotency, overlap, transitions, coupon, scoped matching, remap, delist and isolated snapshot recovery');

const downloads = process.env.USERPROFILE ? `${process.env.USERPROFILE}/Downloads` : '';
const sample = process.env.WACA_SAMPLE_XLSX || `${downloads}/waca資料.xlsx`;
const source = process.env.WACA_MYACG_XLS || `${downloads}/399375_2026-09-23 (1).xls`;
const snapshotFile = process.env.WACA_ERP_SNAPSHOT || `${downloads}/cloud-erp-snapshot-2026-09-26-162318.json`;
if (!existsSync(sample) || !existsSync(source) || !existsSync(snapshotFile)) {
  console.log('SKIP real WACA sample: required source files unavailable');
} else {
  const waca = parseWacaWorkbook(readFileSync(sample));
  const erp = JSON.parse(readFileSync(snapshotFile, 'utf8')).data;
  const workbook = XLSX.read(readFileSync(source), { type: 'buffer' });
  const sourceRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '', raw: false });
  const inventoryRows = sourceRows.map(item => ({
    myacg_parent_code: String(item['主編號(多規格編號)'] || ''),
    myacg_item_code: String(item['子編號(商品編號)'] || ''),
    product_title: String(item['商品名稱'] || ''),
    raw_variant_name: String(item['規格/項目'] || ''),
  }));
  let links = linksFromMyAcgInventory(inventoryRows, erp.productVariants, source, '2026-09-23').links;
  links = mergeMyAcgMasterLinks([], links);
  const reference = buildWacaMasterReference(erp.productVariants, links);
  const productRows = waca.rows.filter(item => !isWacaDiscount(item));
  const features = new Map(productRows.map(item => [wacaFeature(item), item]));
  const counts = { auto: 0, unmatched: 0, multiple: 0, mappingMissing: 0, matchedRows: 0, pendingRows: 0 };
  const pending = [];
  for (const item of features.values()) {
    const matched = matchWacaItem(item, reference);
    if (matched.kind === 'AUTO_MATCH') counts.auto += 1;
    else if (matched.kind === 'MANUAL_REVIEW') counts.multiple += 1;
    else counts.unmatched += 1;
    if (matched.diagnostic === 'MASTER_MAPPING_MISSING') counts.mappingMissing += 1;
    if (matched.kind !== 'AUTO_MATCH') pending.push({
      code: item.productCode, spec1: item.spec1, spec2: item.spec2,
      reason: matched.diagnostic, candidates: matched.candidates.length,
    });
  }
  for (const item of productRows) {
    if (matchWacaItem(item, reference).kind === 'AUTO_MATCH') counts.matchedRows += 1;
    else counts.pendingRows += 1;
  }
  const known = productRows.find(item => item.productCode === 'GP00379558' && item.spec1 === '我們團長的壓克力立牌');
  assert.ok(known);
  const knownMatch = matchWacaItem(known, reference);
  assert.equal(knownMatch.candidate?.childCode, 'G07419745');
  const actualRepo = createWacaRepository();
  const imported = importWacaRows(waca.rows, actualRepo, reference, 'real-sample');
  assert.equal(imported.errors.length, 0);
  assert.equal(imported.effectiveQuantity, imported.matchedEffectiveQuantity + imported.unmatchedPendingQuantity);
  const beforeRepeat = new Map(actualRepo.autoQuantities);
  importWacaRows(waca.rows, actualRepo, reference, 'real-sample-repeat');
  assert.deepEqual(actualRepo.autoQuantities, beforeRepeat);
  console.log(JSON.stringify({
    realSample: true, rows: waca.rows.length, orders: imported.ordersTotal,
    discounts: imported.discountIgnored, features: features.size, counts, knownExample: knownMatch.candidate?.childCode,
    pending, matchedEffectiveQuantity: imported.matchedEffectiveQuantity,
    unmatchedPendingQuantity: imported.unmatchedPendingQuantity,
  }, null, 2));
}
} finally {
  await vite.close();
}
