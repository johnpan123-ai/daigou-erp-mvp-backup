import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { incidentGroups, incidentRows, incidentEpoch } from './fixtures/waca-preview-incident.mjs';

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const core = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const counted = await vite.ssrLoadModule('/src/waca/countedImport.ts');
  const storage = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const visibility = await vite.ssrLoadModule('/src/waca/previewVisibility.ts');
  const variants = incidentGroups.flatMap(g => g.rows.map(([sku, name, history]) => ({
    id: `variant-${sku || 'no-sku'}`, myacg_item_code: sku, product_group_id: g.id, product_title: g.title,
    variant_name: name, waca_auto_quantity: 0, waca_manual_adjustment: history,
  })));
  const master = incidentGroups.flatMap(g => g.rows.filter(r => r[0]).map(([sku, name]) => ({
    mainCode: g.code, childCode: sku, variantId: `variant-${sku}`, productGroupId: g.id,
    productTitle: g.title, variantTitle: name, active: true,
  })));
  const snapshot = { revision: 0, orders: [], items: [], mappings: [], batches: [], masterLinks: [], cutoverAudit: [],
    cutoverState: { mode: 'ORDER_REBASELINE_REQUIRED', sourceBackupFormatVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z' } };
  const rows = incidentRows.map(r => ({ orderStatus: r[0], orderNumber: r[1], purchasedAt: r[2], productCode: r[3],
    productTitle: r[4], spec1: r[5], spec2: r[6], specCode: r[7], quantity: r[8], subtotal: r[9] }));
  const current = storage.repositoryFromSnapshot(snapshot, variants);
  const candidate = core.cloneWacaRepository(current);
  core.importWacaRows(rows, candidate, master, 'visibility-test');
  const importedKeys = new Set(rows.map(r => `${core.wacaOrderKey(r.orderNumber)}::${core.wacaFeature(r)}`));
  const context = counted.wacaTransitionContext(snapshot.cutoverState,
    { epoch: incidentEpoch.epoch, restoredAt: incidentEpoch.restored_at }, '2026-10-19T03:10:00Z');
  const plan = () => counted.planWacaCountedImport({ variants, current, candidate, context, importedKeys,
    defaultMode: 'ACCUMULATE', actor: 'isolated-owner' });
  const initial = plan();
  assert.equal(initial.variants.size, 8);
  assert.equal([...initial.variants.values()].filter(visibility.hasWacaPreviewReview).length, 0);
  assert.equal([...initial.variants.values()].reduce((n, v) => n + v.pendingQuantity, 0), 0);
  assert.equal([...initial.variants.values()].reduce((n, v) => n + v.difference, 0), 8);
  assert.equal(initial.variants.get('variant-G07595265').displayBefore, 2);
  assert.equal(initial.variants.get('variant-G07595265').displayAfter, 3, 'existing history 2 is retained and normal new order adds 1');
  assert.equal(initial.variants.get('variant-G07506675').uncertainItems, 0, 'cancelled/unrecognized order needs no overlap choice');
  const originalPlan = JSON.stringify([...initial.variants]);
  const originalPayload = JSON.stringify(initial.plan);
  const inputsBefore = JSON.stringify({ snapshot, variants, candidate: [...candidate.items], context });
  const counts = {};
  for (const onlyChanged of [true, false]) for (const includeReview of [true, false]) {
    counts[`${onlyChanged}/${includeReview}`] = variants.filter(v => visibility.isWacaCountedReviewRowVisible({
      initial: initial.variants.get(v.id), current: initial.variants.get(v.id), onlyChanged, includeReview,
      modeChosen: false, riskyOverwrite: false,
    })).length;
    assert.equal(JSON.stringify([...plan().variants]), originalPlan, 'filter never changes counted results');
    assert.equal(JSON.stringify(plan().plan), originalPayload, 'filter never changes CAS/epoch/commit payload');
  }
  assert.deepEqual(counts, { 'true/true': 7, 'true/false': 7, 'false/true': 34, 'false/false': 34 });
  assert.equal(JSON.stringify({ snapshot, variants, candidate: [...candidate.items], context }), inputsBefore, 'visibility does not mutate source objects');

  // Existing business contract: proven post-baseline orders auto-count without manual review.
  const newCandidate = core.cloneWacaRepository(current);
  const newRow = { ...rows[0], orderNumber: 'AUDIT-PROVEN-NEW', purchasedAt: '2026-10-19 12:00:00', quantity: 2 };
  core.importWacaRows([newRow], newCandidate, master, 'after-baseline');
  const newPlan = counted.planWacaCountedImport({ variants, current, candidate: newCandidate, context,
    importedKeys: new Set([`${core.wacaOrderKey(newRow.orderNumber)}::${core.wacaFeature(newRow)}`]), defaultMode: 'ACCUMULATE', actor: 'owner' });
  const newPreview = newPlan.variants.get('variant-G07654778');
  assert.equal(newPreview.difference, 2); assert.equal(newPreview.uncertainItems, 0);
  assert.equal(newPreview.items[0].reason, 'NORMAL_IMPORT');
  assert.equal(visibility.isWacaCountedReviewRowVisible({ initial: newPreview, current: newPreview,
    onlyChanged: true, includeReview: false, modeChosen: false, riskyOverwrite: false }), true, 'a normal new order is visible even with review rows hidden');

  // Recognized source cancellation rolls back once without inventing an overlap question.
  counted.applyCountedItems(newCandidate, newPlan);
  const cancelledCandidate = core.cloneWacaRepository(newCandidate);
  core.importWacaRows([{ ...newRow, orderStatus: '取消' }], cancelledCandidate, master, 'cancel');
  const cancelledPlan = counted.planWacaCountedImport({ variants: variants.map(v => v.id === 'variant-G07654778'
    ? { ...v, waca_auto_quantity: 2 } : v), current: newCandidate, candidate: cancelledCandidate, context,
    importedKeys: new Set([`${core.wacaOrderKey(newRow.orderNumber)}::${core.wacaFeature(newRow)}`]), defaultMode: 'ACCUMULATE', actor: 'owner' });
  const rollback = cancelledPlan.variants.get('variant-G07654778');
  assert.equal(rollback.difference, -2); assert.equal(rollback.items[0].reason, 'SOURCE_CHANGE_APPLIED');
  assert.equal(rollback.pendingQuantity, 0); assert.equal(rollback.uncertainItems, 0);
  assert.equal(visibility.isWacaCountedReviewRowVisible({ initial: rollback, current: rollback,
    onlyChanged: true, includeReview: false, modeChosen: false, riskyOverwrite: false }), true);
  assert.equal(visibility.isWacaCountedReviewRowVisible({ initial: newPreview, current: { ...newPreview, difference: 0 },
    onlyChanged: true, includeReview: false, modeChosen: true, riskyOverwrite: false }), true, 'KEEP never removes its own edited control');
  assert.equal(visibility.isWacaCountedReviewRowVisible({ initial: undefined, current: undefined,
    onlyChanged: true, includeReview: true, modeChosen: false, riskyOverwrite: true }), true, 'current overwrite risk cannot be hidden by default');
  console.log(JSON.stringify({ result: 'PASS', incident: '7 changed specs / +8 normal items / 34 related specs', counts,
    existingHistoryPreserved: true, validImportAutomatic: true, recognizedRollbackAutomatic: true,
    planPayloadInvariant: true, noMutation: true, writes: 0 }, null, 2));
} finally { await vite.close(); }
