import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWacaRepository, importWacaRows, isWacaDiscount, matchWacaItem,
  normalizeWacaText, refreshWacaMasterStatus, setWacaMapping, wacaDisplayQuantity, wacaFeature,
} from '../src/waca/orderCore.ts';
import { parseWacaWorkbook } from '../src/waca/workbookParser.ts';
import { buildWacaMasterReference } from '../src/waca/masterReference.ts';

const row = (overrides = {}) => ({
  orderStatus: '處理中', orderNumber: 'A', purchasedAt: '2026-09-26', productCode: 'MAIN',
  productTitle: 'Product', spec1: 'Red', spec2: '', specCode: '', quantity: 1, subtotal: 100,
  ...overrides,
});
const master = [
  { mainCode: 'MAIN', childCode: 'CHILD-RED', variantId: 'vr', productGroupId: 'g', productTitle: 'Product', variantTitle: 'Red', active: true },
  { mainCode: 'MAIN', childCode: 'CHILD-BLUE', variantId: 'vb', productGroupId: 'g', productTitle: 'Product', variantTitle: 'Blue', active: true },
];
assert.equal(normalizeWacaText(' Ａ  B '), 'A B');
assert.notEqual(normalizeWacaText('2026 Limited'), normalizeWacaText('2027 Limited'));
assert.equal(matchWacaItem(row(), master).candidate.variantId, 'vr');
assert.equal(matchWacaItem(row({ productCode: 'CHILD-BLUE', spec1: 'Blue' }), master).candidate.variantId, 'vb');
assert.equal(matchWacaItem(row({ productCode: 'MISSING' }), master).diagnostic, 'MASTER_NOT_FOUND');
assert.equal(matchWacaItem(row({ spec1: 'Green' }), master).diagnostic, 'SPEC_NOT_FOUND');
assert.equal(matchWacaItem(row({ productTitle: 'Unrelated Figure' }), master).diagnostic, 'NAME_CONFLICT');
assert.equal(matchWacaItem(row({ spec1: '' }), master).kind, 'MANUAL_REVIEW');
assert.equal(isWacaDiscount(row({ productCode: 'CoUpOn' })), true);
assert.equal(isWacaDiscount(row({ productTitle: 'HIPPOSEP60' })), true);
assert.equal(isWacaDiscount(row({ spec1: '小河馬09月份60元折扣券' })), true);

const repo = createWacaRepository();
repo.manualAdjustments.set('vr', 4);
let result = importWacaRows([row()], repo, master, 'batch-1');
assert.equal(result.inserted, 1);
assert.equal(repo.autoQuantities.get('vr'), 1);
assert.equal(wacaDisplayQuantity(repo, 'vr'), 5);
result = importWacaRows([row()], repo, master, 'batch-1-repeat');
assert.equal(result.unchanged, 1);
assert.equal(repo.autoQuantities.get('vr'), 1, 'same file never adds to prior quantity');
result = importWacaRows([row({ quantity: 2 }), row({ orderNumber: 'B' })], repo, master, 'overlap');
assert.equal(result.updated, 1);
assert.equal(repo.autoQuantities.get('vr'), 3, 'overlap upserts A and adds distinct B');
result = importWacaRows([row({ orderStatus: '取消', quantity: 2 })], repo, master, 'cancel');
assert.equal(repo.autoQuantities.get('vr'), 1);
assert.equal(result.cancelledOrders, 1);
result = importWacaRows([row({ orderStatus: '處理中', quantity: 2 })], repo, master, 'reactivate');
assert.equal(repo.autoQuantities.get('vr'), 3);
assert.equal(wacaDisplayQuantity(repo, 'vr'), 7, 'manual adjustment remains separate');
result = importWacaRows([row({ orderNumber: 'B', orderStatus: '失敗' })], repo, master, 'fail');
assert.equal(repo.autoQuantities.get('vr'), 2);
result = importWacaRows([row({ orderNumber: 'C', quantity: 2 }), row({ orderNumber: 'C', quantity: 3 })], repo, master, 'merge-duplicate-rows');
assert.equal(repo.autoQuantities.get('vr'), 7);
assert.equal([...repo.items.values()].filter(item => item.orderKey === 'WACA::C').length, 1);
result = importWacaRows([row({ orderNumber: 'C', quantity: 99, orderStatus: '取消' }), row({ orderNumber: 'C', quantity: 99 })], repo, master, 'conflict');
assert.deepEqual(result.statusConflicts, ['WACA::C']);
assert.equal(repo.autoQuantities.get('vr'), 7, 'conflicted order is untouched');
result = importWacaRows([row({ orderNumber: 'C' }), row({ orderNumber: 'C', productCode: 'coupon', orderStatus: '取消' })], repo, master, 'discount-conflict');
assert.deepEqual(result.statusConflicts, ['WACA::C'], 'discount row status still participates in whole-order conflict');
assert.equal(result.discountIgnored, 1);
assert.equal(repo.autoQuantities.get('vr'), 7);
result = importWacaRows([row({ orderNumber: 'D', productCode: 'MISSING', quantity: 4 })], repo, master, 'unmatched');
assert.equal(result.unmatchedPendingQuantity, 4);
assert.equal(result.effectiveQuantity, result.matchedEffectiveQuantity + result.unmatchedPendingQuantity);
const feature = wacaFeature(row());
setWacaMapping(repo, {
  feature, myacgMainId: 'MAIN', myacgVariantId: 'CHILD-BLUE', productVariantId: 'vb',
  method: 'MANUAL', confirmedAt: '2026-09-27', historicalProductTitle: 'Product',
  historicalVariantTitle: 'Blue', masterStatus: 'ACTIVE',
});
assert.equal(repo.autoQuantities.get('vb'), 7, 'manual remap recomputes all historical orders');
assert.equal(repo.autoQuantities.get('vr') ?? 0, 0);
refreshWacaMasterStatus(repo, []);
assert.equal(repo.mappings.get(feature).masterStatus, 'MISSING_FROM_LATEST_MASTER');
assert.equal(repo.autoQuantities.get('vb'), 7, 'master disappearance does not erase historical order counts');
importWacaRows([row({ orderNumber: 'A', quantity: 2 })], repo, [], 'later-without-B');
assert.equal(repo.orders.has('WACA::B'), true, 'missing order in later file is not cancellation');
assert.equal(repo.autoQuantities.get('vb'), 7);
console.log('PASS WACA isolated idempotency/status/discount/mapping/remap/conflict/missing-master contracts');

const sample = process.env.WACA_SAMPLE_XLSX || join(process.env.USERPROFILE || '', 'Downloads', 'waca資料.xlsx');
const myacgExport = process.env.WACA_MYACG_XLS || join(process.env.USERPROFILE || '', 'Downloads', '399375_2026-09-27.xls');
const snapshot = process.env.WACA_ERP_SNAPSHOT || join(process.env.USERPROFILE || '', 'Downloads', 'cloud-erp-snapshot-2026-09-26-162318.json');
if (!existsSync(sample) || !existsSync(myacgExport) || !existsSync(snapshot)) {
  console.log('SKIP real-sample regression: supply WACA_SAMPLE_XLSX, WACA_MYACG_XLS and WACA_ERP_SNAPSHOT');
} else {
  const parsed = parseWacaWorkbook(readFileSync(sample));
  assert.equal(parsed.sourceRowCount, 127);
  assert.equal(new Set(parsed.rows.map(item => item.orderNumber)).size, 71);
  assert.equal(parsed.rows.filter(isWacaDiscount).length, 12);
  const productRows = parsed.rows.filter(item => !isWacaDiscount(item));
  assert.equal(productRows.length, 115);
  const features = new Map(productRows.map(item => [wacaFeature(item), item]));
  assert.equal(features.size, 60);
  const snap = JSON.parse(readFileSync(snapshot, 'utf8')).data;
  const reference = buildWacaMasterReference(readFileSync(myacgExport), snap.productVariants);
  const counts = { matched: 0, unmatched: 0, multiple: 0 };
  const unmatchedDetails = [];
  const ambiguousDetails = [];
  for (const item of features.values()) {
    const match = matchWacaItem(item, reference);
    if (match.kind === 'AUTO_MATCH') counts.matched += 1;
    else if (match.kind === 'MANUAL_REVIEW') { counts.multiple += 1; ambiguousDetails.push({ code: item.productCode, spec1: item.spec1, spec2: item.spec2, candidates: match.candidates.length }); }
    else { counts.unmatched += 1; unmatchedDetails.push({ code: item.productCode, title: item.productTitle, spec1: item.spec1, spec2: item.spec2, reason: match.diagnostic, scopedChildren: match.candidates.length }); }
  }
  const actualRepo = createWacaRepository();
  const imported = importWacaRows(parsed.rows, actualRepo, reference, 'real-sample-isolated');
  assert.equal(imported.errors.length, 0);
  assert.equal(imported.effectiveQuantity, imported.matchedEffectiveQuantity + imported.unmatchedPendingQuantity);
  const firstAuto = new Map(actualRepo.autoQuantities);
  importWacaRows(parsed.rows, actualRepo, reference, 'real-sample-repeat');
  assert.deepEqual(actualRepo.autoQuantities, firstAuto, 'real Excel duplicate import must be quantity-idempotent');
  const rowMatch = productRows.filter(item => matchWacaItem(item, reference).kind === 'AUTO_MATCH').length;
  console.log(JSON.stringify({ realSample: true, rows: parsed.rows.length, orders: imported.ordersTotal,
    discounts: imported.discountIgnored, features: features.size, counts, rowMatch, ambiguousDetails, unmatchedDetails,
    matchedEffectiveQuantity: imported.matchedEffectiveQuantity,
    unmatchedPendingQuantity: imported.unmatchedPendingQuantity }, null, 2));
}
