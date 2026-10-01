import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { createWacaRepository, importWacaRows, matchWacaItem, wacaFeature, setWacaMapping, normalizeWacaText } =
    await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const { parseWacaWorkbook } = await vite.ssrLoadModule('/src/waca/workbookParser.ts');
  const { repositoryFromSnapshot, snapshotFromRepository } = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const title = 'VSPO！ぶいすぽっ！胡桃のあ 胡桃の日記念2026';
  const row = (specCode, spec1, quantity = 1, overrides = {}) => ({ orderStatus: '處理中',
    orderNumber: 'NOAH', purchasedAt: '2026-10-01', productCode: 'G07592374', productTitle: title,
    specCode, spec1, spec2: '', quantity, subtotal: quantity * 100, ...overrides });
  const master = [
    { mainCode: 'GP-NOAH', childCode: 'G07592374', variantId: 'signed', productGroupId: 'noah',
      productTitle: title, variantTitle: '複製簽套組', active: true },
    { mainCode: 'GP-NOAH', childCode: 'G07592378', variantId: 'cap', productGroupId: 'noah',
      productTitle: title, variantTitle: 'Noah棒球帽', active: true },
  ];
  const signed = row('G07592374', '複製簽套組', 3);
  const cap = row('G07592378', 'Noah棒球帽');
  const blank = row('', '', 9, { orderNumber: 'MISSING-SPEC' });
  const fields = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一',
    '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([fields.map(() => '訂單資訊'), fields,
    ...[signed, cap, blank].map(r => [r.orderStatus, r.orderNumber, r.purchasedAt, r.productCode,
      r.productTitle, r.spec1, r.spec2, r.specCode, r.quantity, r.subtotal])]), 'orders');
  const parsed = parseWacaWorkbook(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(parsed.rows[1].productCode, 'G07592374');
  assert.equal(parsed.rows[1].specCode, 'G07592378');
  assert.equal(matchWacaItem(signed, master).candidate.variantId, 'signed');
  assert.equal(matchWacaItem(cap, master).candidate.variantId, 'cap');
  assert.equal(matchWacaItem(blank, master).diagnostic, 'AMBIGUOUS_VARIANT');
  assert.equal(matchWacaItem({ ...cap, specCode: 'NOT-IN-ERP' }, master).kind, 'UNMATCHED');
  assert.equal(matchWacaItem({ ...cap, productCode: '' }, master).candidate.variantId, 'cap');
  const warning = matchWacaItem({ ...cap, spec1: 'Changed name', productTitle: 'Changed title' }, master);
  assert.equal(warning.candidate.variantId, 'cap');
  assert.equal(warning.diagnostic, 'NAME_CONFLICT');
  const repo = createWacaRepository();
  const first = importWacaRows(parsed.rows, repo, master, 'first');
  assert.equal(first.errors.length, 0);
  assert.equal(first.multipleCandidates, 1);
  assert.equal(repo.autoQuantities.get('signed'), 3);
  assert.equal(repo.autoQuantities.get('cap'), 1);
  for (let at = 0; at < 5; at++) {
    const again = importWacaRows(parsed.rows, repo, master, `repeat-${at}`);
    assert.equal(again.unchanged, 3);
    assert.equal(repo.items.size, 3);
    assert.deepEqual([...repo.autoQuantities], [['signed', 3], ['cap', 1]]);
  }
  const sameLabel = createWacaRepository();
  importWacaRows([signed, { ...cap, spec1: signed.spec1 }], sameLabel, master, 'same-label');
  assert.equal(sameLabel.items.size, 2, 'same parent and names cannot merge different specification codes');
  assert.equal(sameLabel.autoQuantities.get('signed'), 3);
  assert.equal(sameLabel.autoQuantities.get('cap'), 1);

  const historic = createWacaRepository();
  importWacaRows([cap, { ...cap, orderNumber: 'CAP-OLD' },
    { ...cap, orderNumber: 'CANCEL', orderStatus: '取消' },
    { ...cap, orderNumber: 'FAIL', orderStatus: '失敗' }], historic, [], 'pending');
  importWacaRows([{ ...signed, orderNumber: 'OTHER' }], historic, master, 'catalogue-added');
  assert.equal(historic.autoQuantities.get('cap'), 2, 'all historical rows are rematched by their own spec code');
  assert.equal(historic.orders.size, 5);
  const legacyFeature = JSON.stringify([cap.productCode, cap.productTitle, cap.spec1, cap.spec2].map(normalizeWacaText));
  const old = { ...cap, key: `WACA::NOAH::${legacyFeature}`, orderKey: 'WACA::NOAH', feature: legacyFeature,
    productVariantId: 'signed', match: 'AUTO_MATCH', diagnostic: null };
  const stale = createWacaRepository();
  stale.orders.set(old.orderKey, { key: old.orderKey, orderNumber: 'NOAH', status: '完成付款', purchasedAt: '' });
  stale.items.set(old.key, old);
  const decision = { feature: legacyFeature, productVariantId: 'signed', myacgMainId: 'GP-NOAH',
    myacgVariantId: 'G07592374', method: 'AUTO', confirmedAt: 'old', historicalProductTitle: title,
    historicalVariantTitle: '複製簽套組', masterStatus: 'ACTIVE' };
  stale.mappings.set(legacyFeature, decision);
  stale.autoQuantities.set('signed', 1);
  const corrected = importWacaRows([], stale, master, 'revalidate');
  assert.equal(stale.autoQuantities.get('signed') ?? 0, 0);
  assert.equal(stale.autoQuantities.get('cap'), 1);
  assert.equal(stale.items.size, 1);
  assert.equal([...stale.items.keys()][0], old.key, 'existing SQL upsert key must remain stable');
  assert.equal(stale.mappings.get(wacaFeature(cap)).myacgVariantId, 'G07592378');
  assert.deepEqual(corrected.quantityChanges, [{ variantId: 'cap', before: 0, after: 1 },
    { variantId: 'signed', before: 1, after: 0 }]);
  importWacaRows([cap], stale, master, 'reimport');
  assert.equal(stale.autoQuantities.get('cap'), 1, 'old feature projection must not duplicate quantity');
  assert.equal([...stale.items.keys()][0], old.key);

  const manual = createWacaRepository();
  manual.orders = new Map(stale.orders);
  manual.items.set(old.key, { ...old });
  manual.mappings.set(legacyFeature, { ...decision, method: 'MANUAL' });
  const auditBefore = JSON.stringify(manual.mappings.get(legacyFeature));
  importWacaRows([cap], manual, master, 'manual-conflict');
  assert.equal(manual.autoQuantities.size, 0);
  assert.equal([...manual.items.values()][0].diagnostic, 'SPEC_CODE_CONFLICT');
  assert.equal(JSON.stringify(manual.mappings.get(legacyFeature)), auditBefore, 'manual audit is not overwritten');
  setWacaMapping(manual, { ...decision, feature: wacaFeature(cap), method: 'MANUAL' });
  assert.equal(manual.autoQuantities.size, 0, 'manual selection cannot override spec code');
  setWacaMapping(manual, { ...decision, feature: wacaFeature(cap), method: 'MANUAL',
    productVariantId: 'cap', myacgVariantId: 'G07592378' });
  assert.equal(manual.autoQuantities.get('cap'), 1);

  const variants = master.map(v => ({ id: v.variantId, product_group_id: v.productGroupId,
    myacg_item_code: v.childCode, product_title: title, variant_name: v.variantTitle, waca_manual_adjustment: 0 }));
  const initial = { revision: 0, orders: [], items: [], mappings: [], batches: [], masterLinks: [],
    cutoverAudit: [{ productVariantId: 'removed-variant', legacyWacaQuantity: 8, newOrderDerivedQuantity: 0 }] };
  const backup = snapshotFromRepository(initial, repo, []);
  const restored = repositoryFromSnapshot(JSON.parse(JSON.stringify(backup)), variants);
  assert.deepEqual(restored.autoQuantities, repo.autoQuantities);
  importWacaRows(parsed.rows, restored, master, 'restored-repeat');
  assert.deepEqual(restored.autoQuantities, repo.autoQuantities);
  assert.deepEqual(backup.cutoverAudit, initial.cutoverAudit);
  const ui = readFileSync('src/pages/WacaIntegration.tsx', 'utf8');
  assert.match(ui, /indexWacaMaster\(masterState\.master\)/u);
  assert.match(ui, /pendingImport\.result\.quantityChanges/u, 'preview must include old wrong target decreases');
  console.log('PASS parser, A/B/C/D spec identity, no product fallback, names warning, statuses, legacy AUTO/MANUAL revalidation, historical rematch, quantities, 5x idempotency, restore and preview');
} finally { await vite.close(); }
