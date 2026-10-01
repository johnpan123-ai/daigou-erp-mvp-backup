import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { createWacaRepository, importWacaRows, matchWacaItem, indexWacaMaster, wacaFeature,
    setWacaMapping, normalizeWacaText, wacaDisplayQuantity } = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const { repositoryFromSnapshot, snapshotFromRepository } = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const { buildWacaMasterReference } = await vite.ssrLoadModule('/src/waca/masterReference.ts');
  const row = (overrides = {}) => ({ productCode: 'GP-P', productTitle: 'Product 2026', specCode: '',
    spec1: '', spec2: '', orderNumber: 'A', orderStatus: '處理中', purchasedAt: '2026-10-02',
    quantity: 1, subtotal: 100, ...overrides });
  const variant = (sku, id, spec, overrides = {}) => ({ mainCode: 'GP-P', childCode: sku,
    variantId: id, productGroupId: 'parent', productTitle: 'Product 2026', variantTitle: spec,
    active: true, ...overrides });
  const red = variant('G-RED', 'red', 'Red');
  const blue = variant('G-BLUE', 'blue', 'Blue');
  const other = variant('G-OTHER', 'other', 'Red', { mainCode: 'GP-OTHER', productGroupId: 'other' });
  const master = [red, blue, other];
  const match = (r, m = master) => matchWacaItem(r, indexWacaMaster(m));
  assert.equal(match(row({ productCode: 'G-RED', specCode: 'G-RED' })).resolution, 'SPEC_CODE_EXACT');
  assert.equal(match(row({ productCode: 'G-RED', specCode: 'G-BLUE' })).candidate.variantId, 'blue');
  assert.equal(match(row({ specCode: 'MISSING', spec1: 'Red' })).candidate, null, 'explicit code cannot fall back to names');
  assert.equal(match(row(), [red]).resolution, 'UNIQUE_PARENT_VARIANT');
  assert.equal(match(row({ productCode: 'G-RED' }), [red]).resolution, 'UNIQUE_PARENT_VARIANT');
  const directParent = buildWacaMasterReference([{ id: 'red', product_group_id: 'parent',
    product_title: 'Product 2026', myacg_item_code: 'G-RED', raw_variant_name: 'Raw seller label', variant_name: 'Red' }], []);
  assert.equal(match(row({ productCode: 'G-RED', spec1: 'Red' }), directParent).resolution,
    'SPEC_NAME_EXACT_UNIQUE', 'current canonical spec remains evidence without a historical GP link');
  assert.equal(match(row({ productCode: 'G-RED' })).resolution, 'PENDING_AMBIGUOUS', 'parent code is not a child selection');
  assert.equal(match(row({ spec1: ' ｒＥｄ ' })).resolution, 'SPEC_NAME_EXACT_UNIQUE');
  assert.equal(match(row({ spec1: 'Blue' })).candidate.variantId, 'blue');
  assert.equal(match(row({ spec1: 'Red' })).candidate.variantId, 'red', 'no cross-parent search');
  assert.equal(match(row({ productCode: 'UNKNOWN', spec1: 'Red' })).resolution, 'PENDING_PRODUCT_MISSING');
  assert.equal(match(row({ productTitle: 'Other Product' }), [red]).resolution, 'PENDING_NAME_CONFLICT');
  assert.equal(match(row({ productTitle: '' }), [red]).candidate, null);
  assert.equal(match(row({ spec1: 'Blue' }), [red, { ...blue, productTitle: 'Unrelated product' }]).candidate, null,
    'a label cannot select an inconsistent product title even inside a misconfigured group');
  assert.equal(match(row({ subtotal: 999999 }), [{ ...red, price: 1 }, { ...blue, price: 999999 }]).candidate, null,
    'price never resolves multiple candidates');
  assert.equal(match(row({ productCode: '' }), [red]).candidate, null);
  for (const label of ['2026 Red', 'Red L', 'Red / Blue', 'Red-Blue', 'Red套組']) {
    assert.equal(match(row({ spec1: label })).candidate, null, `do not discard semantic text: ${label}`);
  }
  assert.equal(match(row({ spec1: 'Red', spec2: 'L' }), [variant('G-L', 'large', 'Red / L')]).candidate.variantId, 'large');
  assert.equal(match(row({ spec1: 'Red', spec2: 'L' }), [variant('G-L', 'large', 'RedL')]).candidate, null, 'spec dimensions cannot be concatenated');
  assert.equal(match(row({ spec1: 'Red' }), [red, variant('G-RED2', 'red2', 'Red')]).resolution, 'PENDING_AMBIGUOUS');
  assert.equal(match(row(), [red, variant('G-MISSING', '', 'Other')]).resolution, 'PENDING_PRODUCT_MISSING');
  assert.equal(match(row({ spec1: 'Red' }), [red, variant('G-MISSING', '', 'Red')]).resolution,
    'PENDING_PRODUCT_MISSING', 'an uncreated same-name child invalidates an exact unique name claim');
  assert.equal(match(row(), [red, variant('G-DEL', 'deleted', '', { active: false })]).candidate.variantId, 'red');
  assert.equal(match(row(), [red, { ...blue, productGroupId: 'wrong-group' }]).candidate, null, 'ambiguous parent groups fail closed');

  const repo = createWacaRepository();
  importWacaRows([row()], repo, [red], 'single');
  assert.equal(repo.autoQuantities.get('red'), 1);
  importWacaRows([], repo, master, 'structure-changed');
  assert.equal(repo.autoQuantities.size, 0, 'AUTO single-variant mapping must not lock future imports');
  assert.equal([...repo.items.values()][0].resolution, 'PENDING_AMBIGUOUS');
  const decision = { feature: wacaFeature(row()), myacgMainId: 'GP-P', myacgVariantId: 'G-BLUE',
    productVariantId: 'blue', method: 'MANUAL', confirmedAt: 'confirmed', historicalProductTitle: 'Product 2026',
    historicalVariantTitle: 'Blue', masterStatus: 'ACTIVE' };
  assert.throws(() => setWacaMapping(repo, { ...decision, productVariantId: 'other', myacgVariantId: 'G-OTHER' }, master), /PARENT_MISMATCH/);
  setWacaMapping(repo, decision, master);
  assert.equal(repo.autoQuantities.get('blue'), 1);
  assert.equal([...repo.items.values()][0].resolution, 'MANUAL_CONFIRMED_MAPPING');
  repo.manualAdjustments.set('blue', 2);
  assert.equal(wacaDisplayQuantity(repo, 'blue'), 3);
  const manualAudit = JSON.stringify(repo.mappings.get(decision.feature));
  for (let at = 0; at < 5; at++) {
    importWacaRows([row()], repo, master, `manual-repeat-${at}`);
    assert.equal(repo.autoQuantities.get('blue'), 1);
  }
  assert.equal(JSON.stringify(repo.mappings.get(decision.feature)), manualAudit);
  importWacaRows([row({ orderNumber: 'NEW-CODE', specCode: 'G-RED' })], repo, master, 'explicit-conflict');
  const conflict = [...repo.items.values()].find(i => i.specCode);
  assert.equal(conflict.resolution, 'CONFLICT_MANUAL_VS_SPEC');
  assert.equal(conflict.productVariantId, null);
  assert.equal(JSON.stringify(repo.mappings.get(decision.feature)), manualAudit);
  setWacaMapping(repo, { ...decision, feature: conflict.feature, productVariantId: 'red', myacgVariantId: 'G-RED' }, master);
  assert.equal(conflict.productVariantId, 'red', 'new explicit confirmation resolves conflict without overwriting old audit');

  const history = createWacaRepository();
  importWacaRows([row(), row({ orderNumber: 'CANCEL', orderStatus: '取消' }),
    row({ orderNumber: 'FAILED', orderStatus: '失敗' })], history, [], 'missing-product');
  assert.equal(history.items.size, 3);
  assert.equal(history.autoQuantities.size, 0);
  importWacaRows([row({ orderNumber: 'LATER' })], history, [red], 'product-created');
  assert.equal(history.autoQuantities.get('red'), 2, 'historical pending orders rematch, cancelled/failed stay zero');
  for (let at = 0; at < 5; at++) importWacaRows([row({ orderNumber: 'LATER' })], history, [red], `repeat-${at}`);
  assert.equal(history.autoQuantities.get('red'), 2);
  const variants = master.map(v => ({ id: v.variantId, product_group_id: v.productGroupId,
    product_title: v.productTitle, myacg_item_code: v.childCode, variant_name: v.variantTitle, waca_manual_adjustment: 0 }));
  const snapshot = snapshotFromRepository({ revision: 0, orders: [], items: [], mappings: [], batches: [], masterLinks: [] }, repo, []);
  const restored = repositoryFromSnapshot(JSON.parse(JSON.stringify(snapshot)), variants);
  importWacaRows([], restored, master, 'restored');
  assert.deepEqual(restored.autoQuantities, repo.autoQuantities);
  assert.equal(restored.mappings.get(decision.feature).resolution, 'MANUAL_CONFIRMED_MAPPING');
  const upgraded = createWacaRepository();
  importWacaRows([row()], upgraded, master, 'blank');
  setWacaMapping(upgraded, decision, master);
  const durableKey = [...upgraded.items.keys()][0];
  const blankAudit = JSON.stringify(upgraded.mappings.get(decision.feature));
  importWacaRows([row({ specCode: 'G-RED' })], upgraded, master, 'same-order-stronger-code');
  assert.equal(upgraded.items.size, 1, 'new explicit identity must not duplicate an earlier blank order line');
  assert.equal([...upgraded.items.keys()][0], durableKey, 'the SQL upsert key is immutable');
  assert.equal(upgraded.items.get(durableKey).resolution, 'CONFLICT_MANUAL_VS_SPEC');
  assert.equal(upgraded.autoQuantities.size, 0);
  assert.equal(JSON.stringify(upgraded.mappings.get(decision.feature)), blankAudit);
  const split = createWacaRepository();
  importWacaRows([row({ quantity: 2 })], split, [red], 'old-blank');
  setWacaMapping(split, { ...decision, productVariantId: 'red', myacgVariantId: 'G-RED' }, [red]);
  const splitKey = [...split.items.keys()][0];
  const splitAudit = JSON.stringify(split.mappings.get(decision.feature));
  const identified = [row({ specCode: 'G-RED' }), row({ specCode: 'G-BLUE' })];
  for (let at = 0; at < 5; at++) {
    importWacaRows(identified, split, master, `split-${at}`);
    assert.equal(split.items.size, 3, 'preserve old durable evidence without guessing a split');
    assert.equal(split.items.get(splitKey).diagnostic, 'SOURCE_SPEC_IDENTITY_CONFLICT');
    assert.equal(split.items.get(splitKey).productVariantId, null);
    assert.equal(split.autoQuantities.get('red'), 1);
    assert.equal(split.autoQuantities.get('blue'), undefined, 'a conflicting old manual decision still requires new confirmation');
    assert.equal(JSON.stringify(split.mappings.get(decision.feature)), splitAudit);
  }
  assert.throws(() => setWacaMapping(split, decision, master), /避免重複計量/);
  const overlap = createWacaRepository();
  const overlapResult = importWacaRows([row(), row({ specCode: 'G-RED' })], overlap, [red], 'source-overlap');
  assert.equal(overlapResult.matched, 1);
  assert.equal(overlapResult.multipleCandidates, 1);
  assert.equal(overlapResult.matchedEffectiveQuantity, 1);
  assert.equal(overlapResult.unmatchedPendingQuantity, 1);
  assert.equal(overlap.autoQuantities.get('red'), 1, 'same-source blank/explicit overlap never double counts');
  const manualParent = createWacaRepository();
  const unknown = row({ productCode: 'SOURCE-UNLINKED', productTitle: 'User confirmed original name' });
  importWacaRows([unknown], manualParent, master, 'missing-parent');
  const confirmed = { ...decision, feature: wacaFeature(unknown), historicalProductTitle: unknown.productTitle };
  assert.throws(() => setWacaMapping(manualParent, confirmed, master), /PARENT_MISMATCH/);
  setWacaMapping(manualParent, confirmed, master, 'parent');
  assert.equal(manualParent.autoQuantities.get('blue'), 1, 'explicit user parent selection is evidence, never an automatic global search');
  importWacaRows([unknown], manualParent, master, 'reuse-parent-confirmation');
  assert.equal(manualParent.autoQuantities.get('blue'), 1);
  assert.equal([...manualParent.items.values()][0].resolution, 'MANUAL_CONFIRMED_MAPPING');
  const spoofed = createWacaRepository();
  const explicit = row({ specCode: 'G-RED' });
  importWacaRows([explicit], spoofed, master, 'explicit');
  setWacaMapping(spoofed, { ...decision, feature: wacaFeature(explicit), myacgVariantId: 'G-RED' }, master);
  assert.equal(spoofed.autoQuantities.size, 0, 'a claimed SKU cannot override the actual canonical target SKU');
  assert.equal([...spoofed.items.values()][0].resolution, 'CONFLICT_MANUAL_VS_SPEC');
  assert.equal(normalizeWacaText('2026／Red-L'), '2026/RED-L');
  console.log('PASS WACA evidence v2: exact/equal spec, locked parent, strict names, unique/ambiguous/missing, structure revalidation, manual/conflict, historical quantity, idempotency and JSON provenance restore');
} finally { await vite.close(); }
