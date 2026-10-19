// WACA transition import (073 counted contract) in a disposable PostgreSQL: canonical 001..072 + 073.
// Synthetic ERP1-style historical quantities (waca_manual_adjustment, empty ledger,
// ORDER_REBASELINE_REQUIRED) then imports through the real client planner and the real RPC.
// No Live connection. Required scenarios 1-9, 12 and 14 of the WACA transition work order.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
assert.equal(CANONICAL_FRESH_INSTALL_V3.at(-1), '074_waca_counted_state_safeupdate.sql', '074 is the append-only singleton repair');
const db = await isolatedDatabase({ migrations: CANONICAL_FRESH_INSTALL_V3 });
const out = {};
const id = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
try {
  const core = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const counted = await vite.ssrLoadModule('/src/waca/countedImport.ts');
  const storage = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const flow = await vite.ssrLoadModule('/src/waca/confirmFlow.ts');
  const recon = await vite.ssrLoadModule('/src/waca/reconciliation.ts');
  const q = (text, values) => db.sql.query(text, values);

  await q("insert into public.product_groups(id,title) values($1,'Transition group')", [id(1)]);
  const codes = { A: 'G-A', B: 'G-B', C: 'G-C' };
  const vid = { A: id(11), B: id(12), C: id(13) };
  for (const [k, code] of Object.entries(codes)) {
    await q('insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name) values($1,$2,$3,$4,$5)',
      [vid[k], id(1), code, 'Transition group', k]);
  }
  // ERP1 v1 Restore shape: historical WACA lives in waca_manual_adjustment, ledger empty.
  await q('update public.product_variants set waca_manual_adjustment=10 where id=$1', [vid.A]);
  await q('update public.product_variants set waca_manual_adjustment=5 where id=$1', [vid.B]);
  await q("update public.waca_state set mode='ORDER_REBASELINE_REQUIRED', payload=jsonb_build_object('mode','ORDER_REBASELINE_REQUIRED','updatedAt','1970-01-01T00:00:00.000Z','sourceBackupFormatVersion',1)");
  await q("update public.erp_cloud_restore_epoch set epoch=7, restored_at='2026-10-16T02:20:45Z', snapshot_fingerprint='erp1-fixture'");

  const master = Object.entries(codes).map(([k, code]) => ({ mainCode: 'GP-T', childCode: code, variantId: vid[k],
    productGroupId: id(1), productTitle: 'Transition group', variantTitle: k, active: true }));
  const variants = async () => (await q('select id::text id,myacg_item_code,product_title,variant_name,waca_auto_quantity,waca_manual_adjustment,product_group_id::text product_group_id from public.product_variants order by id')).rows;
  const snapshot = async () => (await q('select public.erp_read_waca_snapshot() s')).rows[0].s;
  const epoch = async () => { const r = (await q('select epoch,restored_at from public.erp_cloud_restore_epoch')).rows[0]; return { epoch: Number(r.epoch), restoredAt: r.restored_at?.toISOString() ?? null }; };
  const display = async k => { const v = (await variants()).find(row => row.id === vid[k]); return v.waca_auto_quantity + v.waca_manual_adjustment; };
  const row = (order, purchasedAt, code, quantity, status = '完成付款') => ({ orderStatus: status, orderNumber: order, purchasedAt,
    productCode: 'GP-T', productTitle: 'Transition group', spec1: Object.keys(codes).find(k => codes[k] === code), spec2: '', specCode: code, quantity, subtotal: quantity * 100 });

  const runImport = async (rows, opts = {}) => {
    const current = await snapshot();
    const vs = await variants();
    const currentRepo = storage.repositoryFromSnapshot(current, vs);
    const candidate = core.cloneWacaRepository(currentRepo);
    const importId = `import-${Math.random().toString(16).slice(2)}`;
    const result = core.importWacaRows(rows, candidate, master, importId);
    const importedKeys = new Set(rows.map(r => `${core.wacaOrderKey(r.orderNumber)}::${core.wacaFeature(r)}`));
    const context = counted.wacaTransitionContext(current.cutoverState, opts.epoch ?? await epoch(), '2026-10-18T00:00:00Z');
    const plan = counted.planWacaCountedImport({ variants: vs, current: currentRepo, candidate, context, importedKeys,
      modes: opts.modes, defaultMode: opts.defaultMode ?? 'OVERWRITE', overlapChoices: opts.overlap, actor: owner });
    counted.applyCountedItems(candidate, plan);
    const batch = { id: importId, fileName: opts.file ?? 'fixture.xlsx', importedAt: '2026-10-18T00:00:00Z', rows: rows.length,
      inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, result, conflictRows: [],
      transition: { plan: plan.plan, variants: [...plan.variants.values()].map(v => ({ variantId: v.variantId, mode: v.mode,
        before: v.displayBefore, after: v.displayAfter, countedDelta: v.countedDelta, pending: v.pendingQuantity })) } };
    const next = storage.snapshotFromRepository(current, candidate, [...current.batches, batch]);
    const payload = flow.wacaAtomicDelta(current, next);
    if (opts.dryRun) return { plan, current };
    const response = (await q('select public.erp_commit_waca_counted_snapshot($1,$2,$3) r',
      [JSON.stringify(payload), current.revision, JSON.stringify(opts.planOverride?.(plan.plan) ?? plan.plan)])).rows[0].r;
    const saved = await snapshot();
    const check = recon.reconcileWacaReadback(saved, await variants());
    assert.equal(check.issues.filter(i => i.reason !== 'UNMATCHED_SOURCE').length, 0, 'READBACK_RECONCILES');
    for (const [variantId, expected] of Object.entries(plan.plan.expectedDisplay)) {
      const v = (await variants()).find(r => r.id === variantId);
      assert.equal(v.waca_auto_quantity + v.waca_manual_adjustment, expected.after, `SERVER_EQUALS_PREVIEW:${variantId}`);
    }
    return { plan, response, saved };
  };
  const rejects = async (promise, code) => { await assert.rejects(promise, error => String(error.message).includes(code), code); };

  // 1. History 10 + incomplete first import with 1 order: OVERWRITE is flagged, never silent.
  const preview1 = await runImport([row('O1', '2026/10/10 10:00', 'G-A', 1)], { dryRun: true });
  const a1 = preview1.plan.variants.get(vid.A);
  assert.equal(a1.mode, 'OVERWRITE'); assert.equal(a1.displayBefore, 10); assert.equal(a1.displayAfter, 1);
  assert.deepEqual(preview1.plan.riskyOverwrites, [vid.A]);
  // Explicit Owner hold (not an order-date heuristic) keeps this known review fixture uncounted.
  const r1 = await runImport([row('O1', '2026/10/10 10:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE',
    overlap: new Map([[`WACA::O1::${core.wacaFeature(row('O1', '', 'G-A', 1))}`, 'PENDING']]) });
  assert.equal(await display('A'), 10); assert.equal(r1.response.transitionEstablished, true);
  assert.equal(r1.saved.cutoverState.mode, 'ORDER_DRIVEN_ACTIVE');
  assert.equal(r1.saved.cutoverState.transition.restoreEpoch, 7);
  assert.equal(r1.saved.cutoverState.transition.baselineAt, '2026-10-16T02:20:45.000000Z');
  assert.equal(r1.plan.variants.get(vid.A).uncertainItems, 1);
  assert.equal(await display('B'), 5, 'UNTOUCHED_HISTORY_PRESERVED');
  out.s1 = 'PASS explicit OVERWRITE flagged (10->1 risky); explicit Owner hold keeps 10, 1 pending';

  // 2. A confirmed new order (placed after the baseline) accumulates 10 -> 11.
  await runImport([row('O2', '2026/10/17 09:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE' });
  assert.equal(await display('A'), 11); out.s2 = 'PASS 10 -> 11';
  // 3. Re-importing the same order keeps 11.
  const r3 = await runImport([row('O2', '2026/10/17 09:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE' });
  assert.equal(await display('A'), 11); assert.deepEqual(r3.plan.plan.expectedDisplay, {}); out.s3 = 'PASS re-import stays 11 (no plan change)';
  // 4. KEEP: quantity unchanged, the new order stays pending with its source and reason.
  const r4 = await runImport([row('O3', '2026/10/17 12:00', 'G-A', 2)], { defaultMode: 'KEEP' });
  assert.equal(await display('A'), 11);
  const o3 = r4.saved.items.find(i => i.key.startsWith('WACA::O3'));
  assert.equal(o3.countedQuantity, 0); assert.equal(o3.countedReason, 'KEPT');
  assert.equal(r4.plan.variants.get(vid.A).pendingQuantity, 3, 'O1 uncertain 1 + O3 kept 2 remain pending');
  out.s4 = 'PASS KEEP stays 11; O3 saved as KEPT (pending 2), nothing lost';
  // 5. OVERWRITE with a complete source recomputes exactly (B history 5 -> complete ledger 3+2).
  const r5 = await runImport([row('O4', '2026/10/01 10:00', 'G-B', 3), row('O5', '2026/10/02 10:00', 'G-B', 2)]);
  assert.equal(await display('B'), 5); assert.equal(r5.plan.riskyOverwrites.length, 0);
  const b = (await variants()).find(v => v.id === vid.B); assert.equal(b.waca_manual_adjustment, 0); assert.equal(b.waca_auto_quantity, 5);
  out.s5 = 'PASS OVERWRITE with complete source: B = ledger 5, manual 0';
  // 6. An order missing from a later file is not treated as cancelled.
  await runImport([row('O5', '2026/10/02 10:00', 'G-B', 2)]);
  assert.equal(await display('B'), 5); assert.equal(await display('A'), 11); out.s6 = 'PASS omitted order O4 still counted';
  // 7. Different variants, different modes in one import.
  await runImport([row('O6', '2026/10/17 13:00', 'G-A', 1), row('O7', '2026/10/17 13:00', 'G-B', 4), row('O8', '2026/10/17 13:00', 'G-C', 3)],
    { modes: new Map([[vid.A, 'ACCUMULATE'], [vid.B, 'OVERWRITE'], [vid.C, 'KEEP']]) });
  assert.equal(await display('A'), 12); assert.equal(await display('B'), 9); assert.equal(await display('C'), 0);
  out.s7 = 'PASS A accumulate 11->12, B overwrite =9 (3+2+4), C keep 0 (3 pending)';
  // 8. Mixed normal + explicit Owner-held order: only the normal one is added.
  const r8 = await runImport([row('O9', '2026/10/12 10:00', 'G-A', 4), row('O10', '2026/10/17 14:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE',
    overlap: new Map([[`WACA::O9::${core.wacaFeature(row('O9', '', 'G-A', 4))}`, 'PENDING']]) });
  assert.equal(await display('A'), 13); assert.equal(r8.plan.variants.get(vid.A).uncertainItems, 2, 'O1 and O9 uncertain');
  await runImport([row('O9', '2026/10/12 10:00', 'G-A', 4)], { defaultMode: 'ACCUMULATE', overlap: new Map([[`WACA::O9::${core.wacaFeature(row('O9', '', 'G-A', 4))}`, 'BASELINE_INCLUDED']]) });
  assert.equal(await display('A'), 13, 'BASELINE_INCLUDED adds nothing');
  await runImport([row('O1', '2026/10/10 10:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE', overlap: new Map([[`WACA::O1::${core.wacaFeature(row('O1', '', 'G-A', 1))}`, 'COUNT_AS_NEW']]) });
  assert.equal(await display('A'), 14, 'Owner-confirmed new order counted once');
  out.s8 = 'PASS mixed: +1 automatic (O10), O9 marked baseline (+0), O1 owner-confirmed (+1) -> 14';
  // 9. Quantity change, cancellation and repeated cancellation never double count.
  await runImport([row('O10', '2026/10/17 14:00', 'G-A', 3)], { defaultMode: 'ACCUMULATE' });
  assert.equal(await display('A'), 16);
  await runImport([row('O10', '2026/10/17 14:00', 'G-A', 3, '取消')], { defaultMode: 'ACCUMULATE' });
  assert.equal(await display('A'), 13);
  await runImport([row('O10', '2026/10/17 14:00', 'G-A', 3, '取消')], { defaultMode: 'ACCUMULATE' });
  assert.equal(await display('A'), 13);
  const r9 = await runImport([row('O9', '2026/10/12 10:00', 'G-A', 6)], { defaultMode: 'ACCUMULATE' });
  assert.equal(await display('A'), 13); assert.equal(r9.plan.variants.get(vid.A).baselineChangedItems, 1, 'baseline order change flagged');
  out.s9 = 'PASS qty 1->3 (+2), cancel (-3), cancel again (0), baseline order change flagged not applied';

  // 12. A Restore between preview and commit invalidates the plan; server-side guards fail closed.
  await rejects(runImport([row('O11', '2026/10/17 15:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE', epoch: { epoch: 6, restoredAt: '2026-10-16T02:20:45Z' } }), 'WACA_RESTORE_EPOCH_CHANGED');
  await rejects(runImport([row('O11', '2026/10/17 15:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE',
    planOverride: p => ({ ...p, expectedDisplay: { ...p.expectedDisplay, [vid.A]: { before: 13, after: 99 } } }) }), 'WACA_COUNTED_PREVIEW_MISMATCH');
  await rejects(runImport([row('O11', '2026/10/17 15:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE', planOverride: p => ({ ...p, expectedDisplay: {} }) }), 'WACA_COUNTED_PREVIEW_MISMATCH');
  await rejects(runImport([row('O11', '2026/10/17 15:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE', planOverride: p => ({ ...p, overwriteVariantIds: [vid.A] }) }), 'WACA_OVERWRITE_NOT_FULLY_COUNTED');
  assert.equal(await display('A'), 13, 'rejected plans write nothing');
  out.s12 = 'PASS stale epoch / wrong preview / missing expectation / unsafe overwrite all rejected, 0 writes';

  // E1. One PostgreSQL transaction: ledger upsert + quantity update. A rejection raised AFTER the ledger
  // upsert (preview mismatch is checked after erp_commit_waca_snapshot runs) leaves no order, item, batch or revision.
  const ledgerBefore = await snapshot();
  await rejects(runImport([row('O-ATOM', '2026/10/17 16:00', 'G-A', 5)], { defaultMode: 'ACCUMULATE',
    planOverride: p => ({ ...p, expectedDisplay: { ...p.expectedDisplay, [vid.A]: { before: 13, after: 17 } } }) }), 'WACA_COUNTED_PREVIEW_MISMATCH');
  const ledgerAfterReject = await snapshot();
  assert.equal(ledgerAfterReject.revision, ledgerBefore.revision, 'revision rolled back');
  assert.equal(ledgerAfterReject.orders.some(o => o.orderNumber === 'O-ATOM'), false, 'order upsert rolled back');
  assert.equal(ledgerAfterReject.items.length, ledgerBefore.items.length); assert.equal(ledgerAfterReject.batches.length, ledgerBefore.batches.length);
  const fnSrc = (await q("select prosrc, prosecdef from pg_proc where proname='erp_commit_waca_counted_snapshot'")).rows[0];
  assert.equal(fnSrc.prosecdef, true); assert.match(fnSrc.prosrc, /perform public\.erp_commit_waca_snapshot\(p_snapshot, p_expected_revision, false\)/u);
  out.e1 = 'PASS single transaction: a failure raised after the ledger upsert rolls back order/item/batch/revision (0 rows left)';

  // E2. Permissions, identity, CAS, epoch, duplicate submission, Restore maintenance lock.
  const priv = (await q(`select has_function_privilege('anon','public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb)','EXECUTE') anon,
    has_function_privilege('authenticated','public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb)','EXECUTE') auth,
    has_function_privilege('public','public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb)','EXECUTE') pub`)).rows[0];
  assert.deepEqual(priv, { anon: false, auth: true, pub: false });
  const { viewer } = await import('./helpers/saveability-isolated.mjs');
  await q("select set_config('request.jwt.claim.sub',$1,false)", [viewer]);
  await rejects(q("select public.erp_commit_waca_counted_snapshot('{\"items\":[]}'::jsonb,0,'{}'::jsonb)"), 'WACA_OWNER_REQUIRED');
  await q("select set_config('request.jwt.claim.sub','',false)");
  await rejects(q("select public.erp_commit_waca_counted_snapshot('{\"items\":[]}'::jsonb,0,'{}'::jsonb)"), 'WACA_OWNER_REQUIRED');
  await q("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await rejects(runImport([row('O12', '2026/10/17 17:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE', planOverride: p => ({ ...p, contract: 'other' }) }), 'WACA_COUNTED_PLAN_INVALID');
  // Duplicate submission: replay the exact successful request (same revision) -> stale; with a fresh revision the
  // stored quantity no longer matches the reviewed "before" -> rejected. Never counted twice.
  const cur = await snapshot(); const vs0 = await variants();
  const repo0 = storage.repositoryFromSnapshot(cur, vs0); const cand0 = core.cloneWacaRepository(repo0);
  const dupRows = [row('O13', '2026/10/17 18:00', 'G-A', 1)];
  core.importWacaRows(dupRows, cand0, master, 'dup');
  const dupPlan = counted.planWacaCountedImport({ variants: vs0, current: repo0, candidate: cand0, context: counted.wacaTransitionContext(cur.cutoverState, await epoch(), 'x'),
    importedKeys: new Set([...cand0.items.keys()].filter(k => k.startsWith('WACA::O13'))), defaultMode: 'ACCUMULATE', actor: owner });
  counted.applyCountedItems(cand0, dupPlan);
  const dupPayload = JSON.stringify(flow.wacaAtomicDelta(cur, storage.snapshotFromRepository(cur, cand0, cur.batches)));
  await q('select public.erp_commit_waca_counted_snapshot($1,$2,$3)', [dupPayload, cur.revision, JSON.stringify(dupPlan.plan)]);
  assert.equal(await display('A'), 14);
  await rejects(q('select public.erp_commit_waca_counted_snapshot($1,$2,$3)', [dupPayload, cur.revision, JSON.stringify(dupPlan.plan)]), 'WACA_STALE_REVISION');
  // Same payload on the fresh revision: countedQuantity is already stored, so the delta is 0 -> idempotent no-op.
  await q('select public.erp_commit_waca_counted_snapshot($1,$2,$3)', [dupPayload, cur.revision + 1, JSON.stringify(dupPlan.plan)]);
  assert.equal(await display('A'), 14, 'duplicate submission never counted twice');
  // Restore maintenance lock held by another session -> refused immediately.
  const pg = (await import('pg')).default; const other = new pg.Client({ connectionString: db.url.toString() }); await other.connect();
  await other.query("select pg_advisory_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0))");
  await rejects(runImport([row('O14', '2026/10/17 19:00', 'G-A', 1)], { defaultMode: 'ACCUMULATE' }), 'CLOUD_RESTORE_MAINTENANCE_LOCKED');
  await other.query("select pg_advisory_unlock(hashtextextended('erp-cloud-restore-maintenance-lock',0))"); await other.end();
  out.e2 = 'PASS anon/public no EXECUTE, viewer + no identity -> WACA_OWNER_REQUIRED, bad contract rejected, replay same revision -> STALE, replay fresh revision -> idempotent no-op (A stays 14), Restore lock -> refused; stale epoch covered in s12';

  // E3. Negative manual difference is allowed (KEEP / pending offsets) but WACA demand itself never goes negative.
  const c = (await variants()).find(v => v.id === vid.C);
  assert.ok(c.waca_manual_adjustment < 0, 'C holds a negative manual offset (KEPT order)');
  // db.ts opens IndexedDB stores at import time (browser only); only its pure demand function is used here.
  process.on('unhandledRejection', error => { if (!/IndexedDB not supported/u.test(String(error?.message))) throw error; });
  const dbm = await vite.ssrLoadModule('/src/lib/db.ts');
  for (const v of await variants()) {
    assert.ok(v.waca_auto_quantity + v.waca_manual_adjustment >= 0, `no negative demand ${v.myacg_item_code}`);
    const r = dbm.calculateVariantDemandAndPurchased(v, [], [{ product_variant_id: v.id, quantity: 1 }], []);
    assert.equal(r.waca, v.waca_auto_quantity + v.waca_manual_adjustment, 'demand uses the exact sum (clamp not involved)');
    assert.equal(r.gap, Math.max(r.myacg + r.waca + r.privateOrder - 1, 0));
  }
  // An externally negative quantity (e.g. a manual edit to -5) can never be carried further by a counted import.
  await q('update public.product_variants set waca_manual_adjustment = waca_manual_adjustment - 8 where id=$1', [vid.C]);
  await assert.rejects(runImport([row('O15', '2026/10/17 20:00', 'G-C', 2)], { defaultMode: 'ACCUMULATE' }), /WACA_COUNTED_NEGATIVE_DISPLAY/u);
  const cur3 = await snapshot(); const vs3 = await variants(); const repo3 = storage.repositoryFromSnapshot(cur3, vs3); const cand3 = core.cloneWacaRepository(repo3);
  core.importWacaRows([row('O15', '2026/10/17 20:00', 'G-C', 2)], cand3, master, 'neg');
  for (const it of cand3.items.values()) if (it.key.startsWith('WACA::O15')) { it.countedQuantity = 2; it.countedReason = 'NEW_AFTER_BASELINE'; }
  for (const it of cand3.items.values()) if (it.countedQuantity === undefined) { const p0 = repo3.items.get(it.key); it.countedQuantity = counted.storedCountedQuantity(p0, repo3, true); it.countedReason = p0.countedReason ?? 'LEGACY_COUNTED'; }
  const cBefore = (await variants()).find(v => v.id === vid.C);
  const negPlan = { contract: 'waca-counted-import-v1', restoreEpoch: 7, overwriteVariantIds: [],
    expectedDisplay: { [vid.C]: { before: cBefore.waca_auto_quantity + cBefore.waca_manual_adjustment, after: cBefore.waca_auto_quantity + cBefore.waca_manual_adjustment + 2 } } };
  await rejects(q('select public.erp_commit_waca_counted_snapshot($1,$2,$3)', [JSON.stringify(flow.wacaAtomicDelta(cur3, storage.snapshotFromRepository(cur3, cand3, cur3.batches))), cur3.revision, JSON.stringify(negPlan)]), 'WACA_COUNTED_NEGATIVE_DISPLAY');
  await q('update public.product_variants set waca_manual_adjustment = waca_manual_adjustment + 8 where id=$1', [vid.C]);
  out.e3 = 'PASS negative manual offsets keep demand = exact auto+manual >= 0 (gap correct); a negative result is refused by client and server';

  // 14. Purchase Records quantity = server display (gap inputs unchanged contract).
  const final = await variants();
  for (const v of final) assert.equal(recon.purchaseRecordsWacaQuantity(v, true), Math.max(0, v.waca_auto_quantity + v.waca_manual_adjustment));
  out.s14 = `PASS Purchase Records WACA = auto + manual (A=${await display('A')}, B=${await display('B')}, C=${await display('C')})`;
  out.result = 'PASS';
  console.log(JSON.stringify(out, null, 1));
} finally { await vite.close(); await db.close(); }
