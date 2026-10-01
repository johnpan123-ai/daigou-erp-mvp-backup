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
const { buildWacaCutoverAudit, reconcileWacaReadback, purchaseRecordsWacaQuantity } =
  await vite.ssrLoadModule('/src/waca/reconciliation.ts');
try {

const row = (value = {}) => ({
  orderStatus: '處理中', orderNumber: 'A', purchasedAt: '2026-08-01', productCode: 'GP-A',
  productTitle: 'Product', spec1: 'Red', spec2: '', specCode: 'G-RED', quantity: 1, subtotal: 100,
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
assert.equal(matchWacaItem(row({ productCode: 'G-RED', specCode: 'G-BLUE', spec1: 'Blue' }), master).candidate?.variantId, 'vb');
assert.equal(matchWacaItem(row({ productCode: 'GP-MISSING' }), master).candidate?.variantId, 'vr');
assert.equal(matchWacaItem(row({ specCode: 'G-MISSING' }), master).diagnostic, 'VARIANT_NOT_IN_ERP');
assert.equal(matchWacaItem(row({ spec1: 'Green' }), master).diagnostic, 'NAME_CONFLICT');
assert.equal(matchWacaItem(row({ specCode: '' }), master).resolution, 'SPEC_NAME_EXACT_UNIQUE');
assert.equal(matchWacaItem(row({ productTitle: 'Unrelated Figure' }), master).diagnostic, 'NAME_CONFLICT');
assert.equal(matchWacaItem(row({ productCode: 'GP-B', specCode: 'G-OTHER' }), master).candidate?.variantId, 'vo');
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
  row({ orderNumber: 'D', spec1: 'Blue', specCode: 'G-BLUE', quantity: 1 }),
  row({ orderNumber: 'D', productCode: 'coupon', productTitle: 'discount' }),
], repo, master, 'duplicate-and-multi-product');
assert.equal(repo.autoQuantities.get('vr'), 9);
assert.equal(repo.autoQuantities.get('vb'), 1);
assert.equal([...repo.items.values()].filter(item => item.orderKey === 'WACA::D').length, 2);
assert.equal(result.discountIgnored, 1);
result = importWacaRows([row({ orderNumber: 'D', orderStatus: '取消', quantity: 99 }), row({ orderNumber: 'D', quantity: 99 })], repo, master, 'status-conflict');
assert.deepEqual(result.statusConflicts, ['WACA::D']);
assert.equal(repo.autoQuantities.get('vr'), 9);
result = importWacaRows([row({ orderNumber: 'E', productCode: 'GP-MISSING', specCode: 'G-MISSING', quantity: 4 })], repo, master, 'mapping-missing');
assert.equal(result.unmatched, 1);
assert.equal(result.effectiveQuantity, result.matchedEffectiveQuantity + result.unmatchedPendingQuantity);
const feature = wacaFeature(row());
setWacaMapping(repo, {
  feature, myacgMainId: 'GP-A', myacgVariantId: 'G-BLUE', productVariantId: 'vb',
  method: 'MANUAL', confirmedAt: '2026-09-28', historicalProductTitle: 'Product',
  historicalVariantTitle: 'Blue', masterStatus: 'ACTIVE',
});
assert.equal(repo.autoQuantities.get('vr') ?? 0, 0);
assert.equal(repo.autoQuantities.get('vb'), 1);
assert.ok([...repo.items.values()].filter(item => item.feature === feature)
  .every(item => item.diagnostic === 'SPEC_CODE_CONFLICT'));
refreshWacaMasterStatus(repo, []);
assert.equal(repo.mappings.get(feature)?.masterStatus, 'MISSING_FROM_LATEST_MASTER');
assert.equal(repo.autoQuantities.get('vb'), 1);
importWacaRows([row({ orderNumber: 'A', quantity: 2 })], repo, [], 'later-without-B');
assert.equal(repo.orders.has('WACA::B'), true);
assert.equal(repo.autoQuantities.get('vb') ?? 0, 0);

const partialOrderRepo = createWacaRepository();
importWacaRows([row(), row({ spec1: 'Blue', specCode: 'G-BLUE' })], partialOrderRepo, master, 'both-items');
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
const audit = buildWacaCutoverAudit(variants.map(item => item.id === 'vr' ? { ...item, waca_auto_quantity: 10 } : item),
  new Map([['vr', 10]]), new Map([['vr', 9]]), '2026-09-28T00:00:00Z');
const historicalAudit = { ...audit[0], productVariantId: 'deleted-or-not-yet-imported-variant' };
const orphanCutover = { ...recovered, cutoverAudit: [historicalAudit] };
validateNextWacaSnapshot(orphanCutover, variants);
assert.deepEqual(repositoryFromSnapshot(orphanCutover, variants).autoQuantities, repo.autoQuantities);
assert.deepEqual(orphanCutover.cutoverAudit, [historicalAudit], 'historical audit is preserved');
assert.throws(() => validateNextWacaSnapshot({ ...orphanCutover,
  cutoverAudit: [{ ...historicalAudit, productVariantId: '' }] }, variants), /CUTOVER_AUDIT_INVALID/);
assert.throws(() => validateNextWacaSnapshot({ ...orphanCutover,
  cutoverAudit: [{ ...historicalAudit, newOrderDerivedQuantity: NaN }] }, variants), /CUTOVER_AUDIT_INVALID/);
assert.throws(() => validateNextWacaSnapshot({ ...recovered,
  items: [{ ...recovered.items[0], productVariantId: 'missing-active-variant' }] }, variants), /ORPHAN_VARIANT/);

// Orders can arrive before the catalogue. A later partial re-import resolves
// every saved order of the confirmed feature, without repeating the old file.
const pendingRepo = createWacaRepository();
const cap = row({ productCode: 'GP-CAP', specCode: 'G-CAP', productTitle: '胡桃誕生日記念', spec1: '棒球帽', orderNumber: 'CAP-1' });
const capMaster = [{ mainCode: 'GP-CAP', childCode: 'G-CAP', variantId: 'cap', productGroupId: 'cap-group',
  productTitle: cap.productTitle, variantTitle: '棒球帽', active: true }];
const firstPending = importWacaRows([cap], pendingRepo, [], 'cap-before-catalogue');
assert.equal(firstPending.unmatched, 1);
assert.equal(pendingRepo.items.size, 1);
assert.equal(pendingRepo.autoQuantities.get('cap') ?? 0, 0);
importWacaRows([cap], pendingRepo, capMaster, 'cap-after-catalogue');
assert.equal(pendingRepo.autoQuantities.get('cap'), 1, '胡桃棒球帽 becomes 1 after re-import');
for (let repeat = 0; repeat < 5; repeat++) {
  importWacaRows([cap], pendingRepo, capMaster, `cap-repeat-${repeat}`);
  assert.equal(pendingRepo.autoQuantities.get('cap'), 1);
}
const historicalPending = createWacaRepository();
importWacaRows([cap, { ...cap, orderNumber: 'CAP-2' }, { ...cap, orderNumber: 'CAP-CANCEL', orderStatus: '取消' },
  { ...cap, orderNumber: 'CAP-FAIL', orderStatus: '失敗' }], historicalPending, [], 'cap-history-pending');
importWacaRows([{ ...cap, orderNumber: 'CAP-2' }], historicalPending, capMaster, 'cap-partial-reimport');
assert.equal(historicalPending.autoQuantities.get('cap'), 2, 'saved effective orders are resolved, cancelled/failed stay zero');
assert.equal(historicalPending.orders.size, 4);
assert.ok([...historicalPending.items.values()].every(item => item.productVariantId === 'cap'));
assert.equal(historicalPending.importHistory.length, 2, 'backfill does not generate a synthetic import');
const ambiguousPending = createWacaRepository();
importWacaRows([cap], ambiguousPending, [capMaster[0], { ...capMaster[0], variantId: 'other-cap' }], 'ambiguous');
assert.equal(ambiguousPending.autoQuantities.size, 0, 'ambiguous products are never auto counted');
assert.equal(audit.find(item => item.productVariantId === 'vr').legacyWacaQuantity, 4,
  'stored order-derived auto is excluded from legacy, while unknown pre-cutover manual is audited');
const readback = {
  revision: 1, orders: [{ key: 'WACA::READBACK', orderNumber: 'READBACK', status: '處理中', purchasedAt: '' }],
  items: [{ key: 'WACA::READBACK::feature', orderKey: 'WACA::READBACK', feature: 'feature',
    productVariantId: 'vr', quantity: 2 }],
  mappings: [{ feature: 'feature', productVariantId: 'vr' }], batches: [], masterLinks: [], cutoverAudit: audit,
};
const readbackVariant = { ...variants[0], waca_auto_quantity: 2, waca_manual_adjustment: 0 };
assert.equal(reconcileWacaReadback(readback, [readbackVariant]).status, 'PASS');
const unmatchedReadback = structuredClone(readback);
unmatchedReadback.items.push({ ...unmatchedReadback.items[0], key: 'UNMATCHED-EFFECTIVE',
  feature: 'UNMATCHED-EFFECTIVE', productVariantId: '', quantity: 2 });
assert.equal(reconcileWacaReadback(unmatchedReadback, [readbackVariant]).status, 'FAIL');
assert.equal(reconcileWacaReadback(unmatchedReadback, [readbackVariant]).issues.at(-1).reason, 'UNMATCHED_SOURCE');
assert.equal(reconcileWacaReadback(readback, [readbackVariant]).total, 1);
assert.equal(purchaseRecordsWacaQuantity(readbackVariant, true), 2);
assert.equal(reconcileWacaReadback(readback, [{ ...readbackVariant, waca_auto_quantity: 3 }]).issues[0].difference, -1);
assert.equal(reconcileWacaReadback(readback, [{ ...readbackVariant, waca_manual_adjustment: 4 }]).status, 'PASS');
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
    if (matched.diagnostic === 'MASTER_EVIDENCE_MISSING') counts.mappingMissing += 1;
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
  if (!normalizeWacaText(known.specCode)) assert.equal(knownMatch.resolution, 'SPEC_NAME_EXACT_UNIQUE');
  else if (knownMatch.candidate) assert.equal(normalizeWacaText(knownMatch.candidate.childCode), normalizeWacaText(known.specCode));
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
    pendingCount: pending.length, matchedEffectiveQuantity: imported.matchedEffectiveQuantity,
    unmatchedPendingQuantity: imported.unmatchedPendingQuantity,
  }, null, 2));
}
} finally {
  await vite.close();
}
