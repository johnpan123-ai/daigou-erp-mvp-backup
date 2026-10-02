import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { createWacaRepository, recomputeWacaQuantities } = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const { buildWacaPreviewComparisons, isWacaPreviewVariantVisible } =
    await vite.ssrLoadModule('/src/waca/previewReconciliation.ts');

  const variant = (baseline, manual = 0) => ({
    id: 'variant-a', product_group_id: 'group-a', myacg_item_code: 'SKU-A', product_title: 'Product',
    variant_name: 'Standard', waca_auto_quantity: baseline, waca_manual_adjustment: manual,
  });
  const resolution = 'UNIQUE_PARENT_VARIANT';
  const repository = (quantities, excluded = []) => {
    const repo = createWacaRepository();
    let index = 0;
    for (const quantity of quantities) {
      index += 1;
      const orderKey = `WACA::IN-${index}`;
      repo.orders.set(orderKey, { key: orderKey, orderNumber: `IN-${index}`, status: '處理中', purchasedAt: '2026-10-02' });
      repo.items.set(`${orderKey}::F-${index}`, { key: `${orderKey}::F-${index}`, orderKey,
        feature: `F-${index}`, productCode: 'GP-A', productTitle: 'Product', spec1: 'Standard', spec2: '',
        specCode: '', quantity, subtotal: 100, productVariantId: 'variant-a', match: 'AUTO_MATCH',
        diagnostic: null, resolution });
    }
    for (const [status, quantity] of excluded) {
      index += 1;
      const orderKey = `WACA::OUT-${index}`;
      repo.orders.set(orderKey, { key: orderKey, orderNumber: `OUT-${index}`, status, purchasedAt: '2026-10-02' });
      repo.items.set(`${orderKey}::F-${index}`, { key: `${orderKey}::F-${index}`, orderKey,
        feature: `F-${index}`, productCode: 'GP-A', productTitle: 'Product', spec1: 'Standard', spec2: '',
        specCode: '', quantity, subtotal: 100, productVariantId: 'variant-a', match: 'AUTO_MATCH',
        diagnostic: null, resolution });
    }
    recomputeWacaQuantities(repo);
    return repo;
  };
  const preview = (baseline, quantities, excluded = [], currentLedger = 0) => {
    const current = createWacaRepository();
    if (currentLedger) current.autoQuantities.set('variant-a', currentLedger);
    return buildWacaPreviewComparisons([variant(baseline)], current, repository(quantities, excluded),
      'ORDER_REBASELINE_REQUIRED').get('variant-a');
  };

  const equal = preview(4, [1, 1, 1, 1]);
  assert.deepEqual([equal.baselineQuantity, equal.recomputedQuantity, equal.difference], [4, 4, 0]);
  const increase = preview(4, [1, 1, 2, 1], [['取消', 9], ['失敗', 7]]);
  assert.deepEqual([increase.baselineQuantity, increase.recomputedQuantity, increase.difference], [4, 5, 1]);
  assert.equal(increase.includedOrderCount, 4);
  assert.equal(increase.includedQuantity, 5, '1+1+2+1 must trace to 5 pieces, not 4 orders');
  assert.equal(increase.excluded.length, 2);
  assert.deepEqual(increase.excluded.map(row => row.included), [false, false]);
  assert.match(increase.excluded[0].excludedReason, /取消/);
  assert.match(increase.excluded[1].excludedReason, /失敗/);
  const decrease = preview(4, [1, 1, 1]);
  assert.deepEqual([decrease.baselineQuantity, decrease.recomputedQuantity, decrease.difference], [4, 3, -1]);
  const fromZero = preview(0, [1, 2]);
  assert.deepEqual([fromZero.baselineQuantity, fromZero.recomputedQuantity, fromZero.difference], [0, 3, 3]);
  assert.equal(isWacaPreviewVariantVisible(equal, true, true), false, 'ERP1-difference filter hides equal rows');
  assert.equal(isWacaPreviewVariantVisible(increase, false, false), true);
  const legacyManualDifference = preview(4, [1, 1, 1], [], 3);
  assert.equal(isWacaPreviewVariantVisible(legacyManualDifference, false, true), true,
    'ERP1-difference filter reveals a difference even when the ledger itself is unchanged');
  assert.equal(isWacaPreviewVariantVisible(preview(4, [1, 1, 1, 1], [], 4), false, false), false,
    'ledger-unchanged rows remain hidden until requested');

  const orderDriven = repository([3]);
  const active = buildWacaPreviewComparisons([variant(4, 2)], createWacaRepository(), orderDriven,
    'ORDER_DRIVEN_ACTIVE').get('variant-a');
  assert.equal(active.baselineLabel, '目前 WACA');
  assert.equal(active.baselineQuantity, 6);
  assert.equal(active.recomputedQuantity, 5, 'manual adjustment remains only after cutover is already active');

  const corrupt = repository([4]);
  corrupt.autoQuantities.set('variant-a', 5);
  assert.throws(() => buildWacaPreviewComparisons([variant(4)], createWacaRepository(), corrupt,
    'ORDER_REBASELINE_REQUIRED'), /WACA_PREVIEW_TRACE_SUM_MISMATCH/);
  console.log('PASS WACA rebaseline preview: ERP1 baseline, +/-/zero, order-vs-quantity trace, exclusions, filters and fail-closed sum');
} finally {
  await vite.close();
}
