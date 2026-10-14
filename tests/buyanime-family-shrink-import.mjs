import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Regression for request catalog_import_3a53ad67 (2026-10-14): a BuyAnime file
// that omits one variant of an existing family produced a `delete` operation,
// which the create/patch-only Inventory intent rejected as BUYANIME_JOURNAL_INVALID
// (shown as COMMIT_RESULT_UNKNOWN). Import is create/patch only: omitted variants
// are retained unchanged; a new key reusing a held SKU code fails before any write.
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false } });
try {
  const { planCloudInventoryImport } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const { inventoryProof, assertImportRecord } = await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
  const { inventoryImportIntent, validInventoryIntent } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportTransaction.ts');
  const { toCloudFieldRow } = await vite.ssrLoadModule('/src/providers/cloud/cloudEntityPayload.ts');
  const { classifyMyAcgImportError, myAcgImportDiagnostic } = await vite.ssrLoadModule('/src/utils/myacgImportErrors.ts');
  const { normalizeProductTitle } = await vite.ssrLoadModule('/src/lib/db.ts');
  const uuid = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const B1 = 'catalog_import_5a1e0000-0000-4000-8000-000000000001';
  const B2 = 'catalog_import_5a1e0000-0000-4000-8000-000000000002';
  const TITLE = '【測試】預購 Family Shrink 商品';
  const NORM = normalizeProductTitle(TITLE);
  const row = (n, code, variant, available, sold, extra = {}) => ({ id: uuid(n), database_id: uuid(n), version: 3,
    inventory_key: `${NORM}::${code}::${variant}`, myacg_item_code: code, myacg_parent_code: 'GPX0001', product_id: code,
    product_title: TITLE, normalized_product_title: NORM, raw_variant_name: variant, listing_type: '日本代購', final_price: 500,
    myacg_available_quantity: available, myacg_sold_quantity: sold, myacg_demand_quantity: null, myacg_listed_at: '2026-10-01',
    import_sort_index: n, latest_catalog_import_id: null, catalog_last_seen_at: null, deleted_at: null, ...extra });
  const other = row(90, 'GOTHER1', 'Other', 1, 1, { myacg_parent_code: 'GPOTHER', product_title: '其他商品', normalized_product_title: normalizeProductTitle('其他商品'),
    inventory_key: `${normalizeProductTitle('其他商品')}::GOTHER1::Other` });
  const authoritative = [row(1, 'GX01', 'A', 2, 1), row(2, 'GX02', 'B', 3, 0), row(3, 'GX03', 'C', 0, 3), other];
  const incomingRow = (code, variant, available, sold, index, batch) => ({ myacg_item_code: code, myacg_parent_code: 'GPX0001', product_id: code,
    product_title: TITLE, raw_variant_name: variant, final_price: 500, myacg_available_quantity: available, myacg_sold_quantity: sold,
    myacg_listed_at: '2026-10-01', import_sort_index: index, latest_catalog_import_id: batch, catalog_last_seen_at: '2026-10-14T06:25:00.000Z' });
  const kinds = ops => ops.reduce((a, o) => ({ ...a, [o.kind]: (a[o.kind] || 0) + 1 }), {});
  const record = async (plan, batch) => {
    const intent = inventoryImportIntent(batch, 0, plan.operations);
    const value = { format: 'BUYANIME_IMPORT_RESUME_V1', batchId: batch, fileName: 'family-shrink.xls', observedAt: '2026-10-14T06:25:00.000Z',
      stage: 'INVENTORY_COMMITTING', version: 0, restoreEpoch: 0, expected: await Promise.all(plan.imported.map(inventoryProof)), stats: plan.stats, inventory: intent };
    assert.equal(validInventoryIntent(intent, batch, 0), true);
    assertImportRecord(value);
  };
  const same = (a, b) => assert.deepEqual(toCloudFieldRow('inventory_items', b), toCloudFieldRow('inventory_items', a));
  const apply = (rows, ops) => { const m = new Map(rows.map(r => [r.id, { ...r }]));
    for (const op of ops) { if (op.kind === 'create') m.set(op.id, { ...op.values, id: op.id, database_id: op.id, version: 1, deleted_at: null });
      else Object.assign(m.get(op.id), op.changes, { version: m.get(op.id).version + 1 }); }
    return [...m.values()]; };

  // T1: family shrink (GX03 omitted) + update + new variant -> no delete, GX03 retained byte-identical.
  const file1 = [incomingRow('GX01', 'A', 1, 2, 1, B1), incomingRow('GX02', 'B', 3, 0, 2, B1), incomingRow('GX04', 'D', 5, 0, 3, B1)];
  const plan1 = planCloudInventoryImport(authoritative, file1);
  assert.equal(plan1.operations.some(op => op.kind === 'delete'), false, 'family shrink must not delete omitted variants');
  assert.equal(kinds(plan1.operations).create, 1);
  const byId = new Map(plan1.inventory.map(r => [r.id, r]));
  same(authoritative[2], byId.get(uuid(3)));
  same(other, byId.get(uuid(90)));
  const imported = new Set(plan1.imported.map(r => r.id));
  assert.ok(plan1.operations.every(op => imported.has(op.id)), 'every operation targets an imported row');
  await record(plan1, B1);

  // T2: same non-empty code under a different key (renamed variant) -> pre-write SKU_REKEY_CONFLICT, VALIDATION_ERROR.
  let rekey;
  try { planCloudInventoryImport(authoritative, [incomingRow('GX01', 'A-renamed', 1, 2, 1, B1)]); } catch (error) { rekey = error; }
  assert.equal(rekey?.message, 'BUYANIME_INVENTORY_SKU_REKEY_CONFLICT');
  assert.deepEqual(rekey.details, ['GX01']);
  const failure = classifyMyAcgImportError(rekey, 'commit');
  assert.equal(failure.code, 'VALIDATION_ERROR');
  const diagnostic = myAcgImportDiagnostic(failure, B1);
  assert.equal(diagnostic.reason, 'BUYANIME_INVENTORY_SKU_REKEY_CONFLICT');
  assert.equal(diagnostic.rpc, undefined);

  // T3: two new keys with the same code in one file -> conflict before any write.
  assert.throws(() => planCloudInventoryImport(authoritative, [incomingRow('GX09', 'X', 1, 0, 1, B1), incomingRow('GX09', 'Y', 1, 0, 2, B1)]),
    error => error.message === 'BUYANIME_INVENTORY_SKU_REKEY_CONFLICT' && error.details[0] === 'GX09');

  // T4: brand-new family -> create only.
  const fresh = [0, 1].map(n => ({ ...incomingRow(`GN0${n}`, `新${n}`, 1, 0, n, B1), myacg_parent_code: 'GPNEW', product_title: '全新家族' }));
  const plan4 = planCloudInventoryImport(authoritative, fresh);
  assert.deepEqual(kinds(plan4.operations), { create: 2 });
  await record(plan4, B1);

  // T5: an existing duplicate code is neither repaired nor blocked when its existing key is updated.
  const dupe = row(4, 'GX02', 'B-legacy', 1, 1);
  const plan5 = planCloudInventoryImport([...authoritative, dupe], [incomingRow('GX02', 'B', 4, 0, 2, B1)]);
  assert.equal(plan5.operations.some(op => op.kind === 'delete'), false);
  assert.deepEqual(plan5.operations.map(op => [op.kind, op.id]), [['patch', uuid(2)]], 'the existing GX02 key is updated');
  same(dupe, new Map(plan5.inventory.map(r => [r.id, r])).get(uuid(4)));
  await record(plan5, B1);

  // T7: a new row without a SKU code is never blocked by the rekey rule.
  const plan7 = planCloudInventoryImport(authoritative, [{ ...incomingRow('', '無代碼', 1, 0, 1, B1), product_id: 'NOCODE' }]);
  assert.deepEqual(kinds(plan7.operations), { create: 1 });
  // T8: a case/whitespace variant of a held code under a new key is the same SKU -> blocked before any write.
  assert.throws(() => planCloudInventoryImport(authoritative, [incomingRow(' gx01 ', 'A', 1, 2, 1, B1)]),
    error => error.message === 'BUYANIME_INVENTORY_SKU_REKEY_CONFLICT' && error.details[0] === 'GX01');

  // T6: re-import of the same file after commit -> zero operations, quantities unchanged.
  const committed = apply(authoritative, plan1.operations);
  const plan6 = planCloudInventoryImport(committed, file1.map(r => ({ ...r, latest_catalog_import_id: B2 })));
  assert.equal(plan6.operations.length, 0);
  assert.equal(plan6.stats.newCount + plan6.stats.updatedCount, 0);

  console.log('BuyAnime family-shrink import regression passed: T1-T8');
} finally {
  await vite.close();
}
