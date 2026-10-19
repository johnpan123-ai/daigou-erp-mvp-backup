// Owner policy 2026-10-19. Real planner -> authoritative re-plan -> unchanged 073 RPC -> receipt/readback.
// Only the loopback disposable database helper can be used; no production credentials or writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
import { incidentGroups, incidentRows, incidentEpoch } from './fixtures/waca-preview-incident.mjs';

const migrationHash = createHash('sha256').update(readFileSync('supabase/sql/073_waca_counted_transition_import.sql')).digest('hex');
assert.equal(migrationHash, 'f96b253bacaa129d5d3757d9055a40619f6e83339502c21c5abcda2b8b5c42a6');
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const db = await isolatedDatabase();
const id = n => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checks = {};
try {
  const core = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const counted = await vite.ssrLoadModule('/src/waca/countedImport.ts');
  const storage = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const flow = await vite.ssrLoadModule('/src/waca/confirmFlow.ts');
  const q = (sql, args) => db.sql.query(sql, args);
  const variants = async () => (await q('select id::text,product_group_id::text,myacg_item_code,product_title,variant_name,waca_auto_quantity,waca_manual_adjustment,version from public.product_variants order by id')).rows;
  const snapshot = async () => (await q('select public.erp_read_waca_snapshot() s')).rows[0].s;
  const epoch = async () => { const e = (await q('select epoch,restored_at from public.erp_cloud_restore_epoch')).rows[0]; return { epoch: Number(e.epoch), restoredAt: e.restored_at?.toISOString() ?? null }; };
  const display = async sku => { const v = (await variants()).find(v => v.myacg_item_code === sku); return v.waca_auto_quantity + v.waca_manual_adjustment; };
  await q("insert into public.product_groups(id,title) values($1,'Normal import')", [id(1)]);
  for (let i = 1; i <= 5; i++) await q('insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,waca_manual_adjustment) values($1,$2,$3,$4,$5,$6)',
    [id(10 + i), id(1), `G-N${i}`, 'Normal import', `Spec ${i}`, i === 1 ? 10 : i === 2 ? 5 : 0]);
  await q("update public.waca_state set mode='ORDER_REBASELINE_REQUIRED',payload=jsonb_build_object('mode','ORDER_REBASELINE_REQUIRED','updatedAt','1970-01-01T00:00:00.000Z','sourceBackupFormatVersion',1)");
  await q("update public.erp_cloud_restore_epoch set epoch=33,restored_at='2026-10-19T03:06:55Z'");
  const row = (order, sku, qty, status = '完成付款', purchasedAt = '2026/10/17 12:00:00') => ({ orderNumber: order, orderStatus: status,
    purchasedAt, productCode: 'GP-N', productTitle: 'Normal import', specCode: sku, spec1: `Spec ${sku.slice(-1)}`, spec2: '', quantity: qty, subtotal: qty * 100 });
  const prepare = async (rows, opts = {}) => {
    const current = await snapshot(), vs = await variants();
    const repo = storage.repositoryFromSnapshot(current, vs), candidate = core.cloneWacaRepository(repo);
    const master = vs.filter(v => v.myacg_item_code.startsWith('G-N')).map(v => ({ mainCode: 'GP-N', childCode: v.myacg_item_code,
      variantId: v.id, productGroupId: v.product_group_id, productTitle: v.product_title, variantTitle: v.variant_name, active: true }));
    const requestId = crypto.randomUUID();
    const result = core.importWacaRows(rows, candidate, master, requestId);
    assert.deepEqual(result.errors, []);
    const identities = new Set(rows.map(r => `${core.wacaOrderKey(r.orderNumber)}::${core.wacaFeature(r)}`));
    const importedKeys = new Set([...candidate.items.values()].filter(i => identities.has(`${i.orderKey}::${i.feature}`)).map(i => i.key));
    const choices = opts.choice ? new Map([...importedKeys].map(k => [k, opts.choice])) : undefined;
    const planned = counted.planWacaCountedImport({ variants: vs, current: repo, candidate,
      context: counted.wacaTransitionContext(current.cutoverState, await epoch(), '2026-10-19T04:00:00Z'),
      importedKeys, modes: opts.mode ? new Map([...candidate.items.values()].filter(i => importedKeys.has(i.key) && i.productVariantId).map(i => [i.productVariantId, opts.mode])) : undefined,
      overlapChoices: choices, actor: owner });
    counted.applyCountedItems(candidate, planned);
    const batch = { id: requestId, fileName: 'isolated-normal.xlsx', importedAt: '2026-10-19T04:00:00Z', rows: rows.length,
      inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, result, conflictRows: [],
      transition: { contract: planned.plan.contract, restoreEpoch: planned.plan.restoreEpoch, recognitionPolicy: 'VALID_SOURCE_ACCUMULATE_V2', variants: [] } };
    return { current, candidate: storage.snapshotFromRepository(current, candidate, [...current.batches, batch]), planned, requestId };
  };
  let writes = 0;
  const commit = async (prepared, { responseLoss = false } = {}) => {
    const { current, candidate, planned, requestId } = prepared;
    return flow.commitAndVerifyWacaCounted({ current, candidate, plan: planned.plan, requestId, provider: {
      getNextWacaSnapshot: snapshot, getAuthoritativeWacaVariants: variants,
      commitWacaCountedSnapshot: async (payload, revision, plan) => {
        writes++;
        const r = await q('select public.erp_commit_waca_counted_snapshot($1,$2,$3) r', [JSON.stringify(payload), revision, JSON.stringify(plan)]);
        if (responseLoss) throw new Error('SIMULATED_RESPONSE_LOSS_AFTER_COMMIT');
        return r.rows[0].r;
      },
    } });
  };
  const run = async (rows, opts) => { const p = await prepare(rows, opts); await commit(p); return p; };
  const item = async order => (await snapshot()).items.find(i => i.orderKey === core.wacaOrderKey(order));
  const n1 = row('NORMAL-OLD-DATE', 'G-N1', 2);
  const p1 = await prepare([n1]);
  assert.equal(p1.current.items.length, 0);
  assert.deepEqual([p1.planned.variants.get(id(11)).mode, p1.planned.variants.get(id(11)).displayBefore, p1.planned.variants.get(id(11)).displayAfter,
    p1.planned.variants.get(id(11)).uncertainItems], ['ACCUMULATE', 10, 12, 0]);
  // Confirm's fresh authoritative re-plan must equal the reviewed arithmetic, not just UI text.
  assert.deepEqual((await prepare([n1])).planned.plan, p1.planned.plan);
  await commit(p1);
  assert.equal(await display('G-N1'), 12); assert.equal((await item(n1.orderNumber)).countedReason, 'NORMAL_IMPORT');
  checks.emptyLedgerOldDatedNormal = '10 + 2 -> 12, no review; preview = server readback';
  const origin = (await item(n1.orderNumber)).countedBy;
  await run([n1]); assert.equal(await display('G-N1'), 12);
  assert.equal((await item(n1.orderNumber)).countedBy, origin);
  assert.equal((await snapshot()).items.filter(i => i.orderKey === core.wacaOrderKey(n1.orderNumber)).length, 1);
  checks.sameOrder = 'no duplicate recognition / origin unchanged';
  await run([{ ...n1, quantity: 1, subtotal: 100 }]); assert.equal(await display('G-N1'), 11);
  await run([{ ...n1, quantity: 1, subtotal: 100, orderStatus: '取消' }]); assert.equal(await display('G-N1'), 10);
  await run([{ ...n1, quantity: 1, subtotal: 100, orderStatus: '取消' }]); assert.equal(await display('G-N1'), 10);
  await run([n1]); assert.equal(await display('G-N1'), 12);
  checks.reductionCancelRepeatRestore = '2->1 -1; cancel -1 once; repeated cancel 0; reactivate +2';
  await run([row('DIFFERENT-ORDER', 'G-N3', 1)]); assert.equal(await display('G-N1'), 12);
  checks.missingFromFile = 'does not cancel stored orders';
  const h = row('HISTORY-PROVEN', 'G-N2', 2);
  await run([h], { choice: 'BASELINE_INCLUDED' }); assert.equal(await display('G-N2'), 5);
  await run([h]); assert.equal(await display('G-N2'), 5);
  const hc = { ...h, orderStatus: '取消' };
  const historyCancel = await run([hc]);
  assert.equal(await display('G-N2'), 5);
  assert.equal(historyCancel.planned.variants.get(id(12)).baselineChangedItems, 1);
  assert.equal((await item(h.orderNumber)).countedReview, 'BASELINE_SOURCE_CHANGED');
  const historyAgain = await run([hc]);
  assert.equal(historyAgain.planned.variants.get(id(12)).baselineChangedItems, 1, 'unresolved risk survives reimport/receipt');
  assert.equal(await display('G-N2'), 5);
  await run([hc], { choice: 'BASELINE_INCLUDED' });
  assert.equal((await item(h.orderNumber)).countedReview, undefined, 'explicit resolution clears the warning');
  checks.erp1History = 'known inclusion never adds; cancellation holds history; review durable and explicitly resolvable';
  const unknownCancel = await run([row('UNPROVEN-HISTORY-CANCEL', 'G-N2', 1, '取消')]);
  assert.equal(unknownCancel.planned.variants.get(id(12)).baselineChangedItems, 1);
  assert.equal(await display('G-N2'), 5);
  assert.equal((await item('UNPROVEN-HISTORY-CANCEL')).countedReview, 'UNPROVEN_CANCELLATION');
  checks.unprovenHistoryCancel = 'no deduction, manual review retained';
  const held = row('OWNER-HELD', 'G-N4', 2);
  await run([held], { choice: 'PENDING' });
  const holdAgain = await run([held]); assert.equal(await display('G-N4'), 0);
  assert.equal(holdAgain.planned.variants.get(id(14)).uncertainItems, 1);
  await run([held], { choice: 'COUNT_AS_NEW' }); assert.equal(await display('G-N4'), 2);
  checks.explicitOwnerHold = 'does not auto-release on reimport; only explicit recognition resolves';
  await run([{ ...held, quantity: 1, subtotal: 100 }], { mode: 'KEEP' }); assert.equal(await display('G-N4'), 2);
  await run([{ ...held, quantity: 1, subtotal: 100 }]); assert.equal(await display('G-N4'), 1, 'KEEP did not erase the counted origin');
  const keptNew = row('KEPT-NEW', 'G-N5', 3);
  await run([keptNew], { mode: 'KEEP' }); assert.equal(await display('G-N5'), 0);
  await run([keptNew]); assert.equal(await display('G-N5'), 3);
  checks.keep = 'unchanged now; next import rejudges; original counted provenance survives deferred reduction';
  const weak = { ...row('STRENGTHENED-IDENTITY', 'G-N5', 1), specCode: '' };
  await run([weak]);
  const originalKey = (await item(weak.orderNumber)).key;
  const upgraded = await run([{ ...weak, specCode: 'G-N5' }]);
  assert.equal((await item(weak.orderNumber)).key, originalKey, 'stronger SKU evidence preserves durable identity');
  assert.equal(upgraded.planned.variants.get(id(15)).difference, 0);
  assert.equal(await display('G-N5'), 4);
  checks.identityStrengthening = 'blank-to-explicit SKU preserves key and counted origin, no extra recognition';
  const ambiguous = await run([row('UNMATCHED-SOURCE', 'G-UNKNOWN', 3)]);
  assert.equal((await item('UNMATCHED-SOURCE')).productVariantId, '');
  assert.equal([...ambiguous.planned.variants.values()].reduce((n, v) => n + v.difference, 0), 0);
  checks.unmatchedSource = 'unresolved SKU remains pending, no count';
  const overwrite = await prepare([row('OVERWRITE', 'G-N1', 1)], { mode: 'OVERWRITE' });
  assert.ok(overwrite.planned.riskyOverwrites.includes(id(11))); assert.equal(overwrite.planned.variants.get(id(11)).displayAfter, 3);
  checks.overwriteDecrease = 'still flagged for explicit UI acknowledgement';
  const stale = await prepare([row('STALE', 'G-N3', 2)]);
  const beforeStale = await snapshot();
  await q('update public.erp_cloud_restore_epoch set epoch=epoch+1');
  await assert.rejects(commit(stale), /WACA_RESTORE_EPOCH_CHANGED/);
  assert.deepEqual(await snapshot(), beforeStale);
  checks.epoch = 'changed epoch rejects before write';
  const bad = await prepare([row('BAD-PREVIEW', 'G-N3', 2)]);
  const beforeBad = await snapshot();
  bad.planned.plan.expectedDisplay[id(13)].after = 999;
  await assert.rejects(commit(bad), /WACA_COUNTED_PREVIEW_MISMATCH/);
  assert.deepEqual(await snapshot(), beforeBad, 'post-upsert rejection rolls back all rows/batch/revision');
  checks.atomicRollback = 'ledger / batch / revision / quantities unchanged';
  const loss = await prepare([row('RESPONSE-LOSS', 'G-N3', 2)]);
  const writeBefore = writes; await commit(loss, { responseLoss: true });
  assert.equal(writes, writeBefore + 1); assert.equal(await display('G-N3'), 3);
  await assert.rejects(q('select public.erp_commit_waca_counted_snapshot($1,$2,$3)',
    [JSON.stringify(flow.wacaAtomicDelta(loss.current, loss.candidate)), loss.current.revision, JSON.stringify(loss.planned.plan)]), /WACA_STALE_REVISION/);
  // The client can reconcile that rejected duplicate to the exact original durable receipt.
  await commit(loss);
  assert.equal(await display('G-N3'), 3);
  checks.responseLossAndDoubleSubmit = 'receipt reconciles; no replay; same request stale, quantity unchanged';
  const exportedValue = (await q('select public.erp_export_cloud_restore_snapshot_json() s')).rows[0].s;
  const exported = typeof exportedValue === 'string' ? JSON.parse(exportedValue) : exportedValue;
  assert.equal(Object.keys(exported).length, 24);
  assert.ok(exported.waca_order_items.some(i => i.payload?.countedReason === 'NORMAL_IMPORT'));
  assert.ok(exported.waca_order_items.some(i => i.payload?.countedReview === 'UNPROVEN_CANCELLATION'));
  assert.ok(exported.waca_import_batches.some(b => b.payload?.transition?.recognitionPolicy === 'VALID_SOURCE_ACCUMULATE_V2'));
  checks.cloudBackupEvidence = 'existing 24-resource SQL export preserves normal origin, review evidence and batch policy';
  // A contradictory durable recognition record fails closed, even if the source is otherwise valid.
  await q("update public.waca_order_items set payload=jsonb_set(payload,'{countedReason}','\"PENDING_REVIEW\"') where payload->>'orderKey'=$1", [core.wacaOrderKey('RESPONSE-LOSS')]);
  await assert.rejects(prepare([row('RESPONSE-LOSS', 'G-N3', 2)]), /WACA_COUNTED_HISTORY_CONFLICT/);
  checks.contradictoryHistory = 'blocked, not silently normal-counted';

  // Exact sanitized seven-spec incident fixture through a clean real SQL ledger, not mocked arithmetic.
  const incidentDb = await isolatedDatabase();
  try {
    const iq = (s, a) => incidentDb.sql.query(s, a);
    const vs = [], master = []; let seq = 100;
    for (const g of incidentGroups) {
      const gid = id(++seq); await iq('insert into public.product_groups(id,title) values($1,$2)', [gid, g.title]);
      for (const [sku, name, history] of g.rows) {
        const vid = id(++seq);
        await iq('insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,waca_manual_adjustment) values($1,$2,$3,$4,$5,$6)', [vid, gid, sku, g.title, name, history]);
        vs.push({ id: vid, product_group_id: gid, myacg_item_code: sku, product_title: g.title, variant_name: name, waca_auto_quantity: 0, waca_manual_adjustment: history });
        if (sku) master.push({ mainCode: g.code, childCode: sku, variantId: vid, productGroupId: gid, productTitle: g.title, variantTitle: name, active: true });
      }
    }
    await iq("update public.waca_state set mode='ORDER_REBASELINE_REQUIRED',payload=jsonb_build_object('mode','ORDER_REBASELINE_REQUIRED','updatedAt','1970-01-01T00:00:00.000Z')");
    await iq('update public.erp_cloud_restore_epoch set epoch=$1,restored_at=$2', [incidentEpoch.epoch, incidentEpoch.restored_at]);
    const initial = (await iq('select public.erp_read_waca_snapshot() s')).rows[0].s;
    const repo = storage.repositoryFromSnapshot(initial, vs), candidate = core.cloneWacaRepository(repo);
    const rows = incidentRows.map(r => ({ orderStatus: r[0], orderNumber: r[1], purchasedAt: r[2], productCode: r[3], productTitle: r[4], spec1: r[5], spec2: r[6], specCode: r[7], quantity: r[8], subtotal: r[9] }));
    core.importWacaRows(rows, candidate, master, 'incident');
    const plan = counted.planWacaCountedImport({ variants: vs, current: repo, candidate,
      context: counted.wacaTransitionContext(initial.cutoverState, { epoch: 33, restoredAt: incidentEpoch.restored_at }, '2026-10-19T04:00:00Z'),
      importedKeys: new Set(candidate.items.keys()), actor: owner });
    assert.equal([...plan.variants.values()].reduce((n, r) => n + r.difference, 0), 8);
    assert.equal([...plan.variants.values()].filter(r => r.uncertainItems || r.baselineChangedItems || r.pendingQuantity).length, 0);
    counted.applyCountedItems(candidate, plan);
    await iq('select public.erp_commit_waca_counted_snapshot($1,$2,$3)', [JSON.stringify(flow.wacaAtomicDelta(initial, storage.snapshotFromRepository(initial, candidate, []))), 0, JSON.stringify(plan.plan)]);
    const saved = (await iq('select myacg_item_code,waca_auto_quantity+waca_manual_adjustment qty from public.product_variants')).rows;
    for (const [vid, expected] of Object.entries(plan.plan.expectedDisplay)) {
      const sku = vs.find(v => v.id === vid).myacg_item_code;
      assert.equal(saved.find(v => v.myacg_item_code === sku).qty, expected.after);
    }
    checks.incidentSevenSpecs = 'real SQL commit: +8; G07595265 2->3; G07654825 0->2; other five 0->1; cancelled 0->0';
  } finally { await incidentDb.close(); }
  console.log(JSON.stringify({ result: 'PASS', checks, appliedMigration: 'existing canonical 073 only, disposable databases',
    migration073Unchanged: true, newMigrationRequired: false, existingItemPayloadEvidence: 'MUST BACKUP+RESTORE (same waca_order_items resource)', productionWrites: 0 }, null, 2));
} finally { await db.close(); await vite.close(); }
