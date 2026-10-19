// WACA transition x Restore (073 counted contract) in a disposable PostgreSQL with the full Restore RPC:
// real ERP1 v1 backup (C16 duplicate normalization) -> counted import -> ERP2 v2 backup round trip ->
// later work -> Restore loss pre-check -> v2 Restore -> ERP1 Restore again (new epoch, stale plan rejected).
// Required scenarios 10, 11, 12, 13 (+ Restore protection). Real snapshots stay outside Git. No Live connection.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';

const e1Path = process.env.ERP1_V1_WACA_SNAPSHOT, v2Path = process.env.ERP2_V2_WACA_SNAPSHOT;
assert.ok(e1Path && v2Path, 'ERP1_V1_WACA_SNAPSHOT and ERP2_V2_WACA_SNAPSHOT are required');
const sha = v => createHash('sha256').update(v).digest('hex');
const e1Raw = await readFile(e1Path), v2Raw = await readFile(v2Path);
assert.equal(sha(e1Raw), 'a5683655eefd159730aaba958fff57ff5a63ccfb0b9465c79617361324deacb2', 'EXACT_ERP1_FILE_REQUIRED');
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
assert.equal(CANONICAL_FRESH_INSTALL_V3.at(-1), '074_waca_counted_state_safeupdate.sql', '074 is the append-only singleton repair');
const db = await isolatedDatabase({ migrations: CANONICAL_FRESH_INSTALL_V3 });
const out = {};
try {
  const r = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const p = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
  const upload = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
  const W = await vite.ssrLoadModule('/src/lib/cloudRestoreVariantNormalization.ts');
  const core = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const counted = await vite.ssrLoadModule('/src/waca/countedImport.ts');
  const storage = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const flow = await vite.ssrLoadModule('/src/waca/confirmFlow.ts');
  const recon = await vite.ssrLoadModule('/src/waca/reconciliation.ts');
  const loss = await vite.ssrLoadModule('/src/waca/restoreLoss.ts');
  const q = (text, values) => db.sql.query(text, values);
  const readback = async () => r.buildCloudRestoreManifest((await q('select public.erp_cloud_restore_snapshot() data')).rows[0].data);
  const restore = async candidate => {
    const request = randomUUID(), attempt = randomUUID(), trace = randomUUID();
    const proof = await upload.uploadCloudRestoreCandidate(async (name, args) => {
      const keys = { erp_begin_restore_upload: ['p_request_id', 'p_manifest', 'p_restore_mode', 'p_source_environment'],
        erp_upload_restore_chunk: ['p_request_id', 'p_resource', 'p_ordinal', 'p_rows'], erp_upload_restore_chunk_batch: ['p_request_id', 'p_chunks'],
        erp_stage_restore_upload_resource: ['p_request_id', 'p_resource'], erp_finalize_restore_upload: ['p_request_id'] };
      const values = keys[name].map(key => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
      return { data: (await q(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) result`, values)).rows[0].result, error: null };
    }, { ...candidate, sourceEnvironment: 'isolated' }, candidate.sourceData ?? candidate.data, candidate.portability ? 'cross-environment' : 'strict', request);
    assert.equal(proof.ok, true);
    await q('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',
      [attempt, trace, candidate.portability?.sourceSnapshotFingerprint ?? candidate.manifest.snapshotFingerprint,
        candidate.manifest.snapshotFingerprint, candidate.portability?.policyVersion ?? 'strict', 'rhfdjsklfrgpoqsaqpkn', 120000, 'postgresql-statement-timeout-v1']);
    const body = [attempt, trace, randomUUID(), proof.proof_id, request];
    const result = (await q('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result', body)).rows[0].result;
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
    const verified = (await q('select public.erp_verify_committed_cloud_restore($1,$2,$3) result', body.slice(0, 3))).rows[0].result;
    assert.equal(verified.status, 'RESTORE_COMMITTED_VERIFIED');
  };
  await q("select set_config('request.headers',$1,false)", [JSON.stringify({ host: 'rhfdjsklfrgpoqsaqpkn.supabase.co' })]);
  const pre = await r.prepareCloudRestoreSnapshot(JSON.parse(v2Raw.toString('utf8')), { sourceFileSha256: sha(v2Raw) });
  if (pre.data.dashboard_category_images.every(row => !Object.hasOwn(row, 'local_id') && !Object.hasOwn(row, 'version')))
    await q('alter table public.dashboard_category_images drop column local_id,drop column version');
  for (const uid of new Set(Object.values(pre.data).flatMap(rows => rows.map(x => x.updated_by).filter(x => x && x !== owner))))
    await q('insert into auth.users(id,email) values($1,$2) on conflict do nothing', [uid, 'isolated@example.invalid']);
  await restore(pre);
  const restoreErp1 = async () => {
    let source = await r.prepareCloudRestoreSnapshot(JSON.parse(e1Raw.toString('utf8')), { sourceFileSha256: sha(e1Raw) });
    source = await r.preserveLegacyCloudDashboardImages(source, pre.data.dashboard_category_images);
    const step = await W.normalizeCloudRestoreCandidateVariants(source);
    assert.equal(step.record.status, 'NORMALIZED');
    await restore(await p.prepareCrossEnvironmentCloudRestoreCandidate(step.candidate, 'rhfdjsklfrgpoqsaqpkn'));
    return step;
  };
  const normalization = await restoreErp1();

  const variantsAll = async () => (await q('select id::text id,myacg_item_code,product_title,variant_name,waca_auto_quantity,waca_manual_adjustment,product_group_id::text product_group_id,deleted_at from public.product_variants')).rows;
  const variants = async () => (await variantsAll()).filter(v => !v.deleted_at);
  const snapshot = async () => (await q('select public.erp_read_waca_snapshot() s')).rows[0].s;
  const epoch = async () => { const e = (await q('select epoch,restored_at from public.erp_cloud_restore_epoch')).rows[0]; return { epoch: Number(e.epoch), restoredAt: e.restored_at.toISOString() }; };
  const historyTotal = rows => rows.reduce((s, v) => s + v.waca_manual_adjustment + v.waca_auto_quantity, 0);
  const erp1History = historyTotal(await variants());
  assert.equal(erp1History, 899, 'ERP1 10-16 WACA history (342 variants) restored, not zeroed');
  const manualSnapshot = new Map((await variants()).map(v => [v.id, v.waca_manual_adjustment]));
  const hakos = '10792c6d-3fd1-438d-ac9a-8939ae5539b5';
  const hakosVariant = (await variants()).find(v => v.id === hakos);
  assert.equal(hakosVariant.waca_manual_adjustment, 6, 'ERP1 Hakos history');
  const firstEpoch = await epoch();
  assert.equal((await snapshot()).cutoverState.mode, 'ORDER_REBASELINE_REQUIRED');
  out.s10_restore = { erp1HistoryTotal: erp1History, hakos: 6, mode: 'ORDER_REBASELINE_REQUIRED', epoch: firstEpoch.epoch };

  const masterFor = vs => vs.filter(v => v.myacg_item_code).map(v => ({ mainCode: `GP-${v.product_group_id}`, childCode: v.myacg_item_code,
    variantId: v.id, productGroupId: v.product_group_id, productTitle: v.product_title, variantTitle: v.variant_name, active: true }));
  const row = (order, purchasedAt, variant, quantity, status = '完成付款') => ({ orderStatus: status, orderNumber: order, purchasedAt,
    productCode: `GP-${variant.product_group_id}`, productTitle: variant.product_title, spec1: variant.variant_name, spec2: '',
    specCode: variant.myacg_item_code, quantity, subtotal: quantity * 100 });
  const runImport = async (rows, opts = {}) => {
    const current = await snapshot(); const vs = await variants();
    const currentRepo = storage.repositoryFromSnapshot(current, vs);
    const candidate = core.cloneWacaRepository(currentRepo);
    const importId = randomUUID();
    const result = core.importWacaRows(rows, candidate, masterFor(vs), importId);
    const importedKeys = new Set(rows.map(x => `${core.wacaOrderKey(x.orderNumber)}::${core.wacaFeature(x)}`));
    const context = counted.wacaTransitionContext(current.cutoverState, opts.epoch ?? await epoch(), new Date().toISOString());
    const plan = counted.planWacaCountedImport({ variants: vs, current: currentRepo, candidate, context, importedKeys,
      defaultMode: opts.defaultMode ?? 'ACCUMULATE', overlapChoices: opts.overlap, actor: owner });
    counted.applyCountedItems(candidate, plan);
    const batch = { id: importId, fileName: 'fixture.xlsx', importedAt: new Date().toISOString(), rows: rows.length,
      inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, result, conflictRows: [] };
    const next = storage.snapshotFromRepository(current, candidate, [...current.batches, batch]);
    await q('select public.erp_commit_waca_counted_snapshot($1,$2,$3)', [JSON.stringify(flow.wacaAtomicDelta(current, next)), current.revision, JSON.stringify(plan.plan)]);
    const saved = await snapshot();
    assert.equal(recon.reconcileWacaReadback(saved, await variants()).issues.filter(i => i.reason !== 'UNMATCHED_SOURCE').length, 0);
    return { plan, saved, result };
  };

  // 13. Duplicate-normalized catalog: a WACA order for a normalized set resolves to the kept canonical Variant.
  const away = new Set(normalization.record.report.softDeletedVariantIds);
  const canonicalOfSet = normalization.record.report.repointedReferences[0]?.to
    ?? [...(await variants())].find(v => v.myacg_item_code && !away.has(v.id)).id;
  const canonicalVariant = (await variants()).find(v => v.id === canonicalOfSet);
  const awayVariant = (await variantsAll()).find(v => away.has(v.id) && v.myacg_item_code === canonicalVariant.myacg_item_code);

  // 10. ERP1 baseline kept: explicit inclusion evidence (not the order date) prevents a duplicate.
  // Normal old-dated orders without evidence add normally; waca-normal-import-isolated covers that case.
  const base = firstEpoch.restoredAt;
  const before = new Date(Date.parse(base) - 3 * 86400000).toISOString().replace('T', ' ').slice(0, 16).replaceAll('-', '/');
  const after = new Date(Date.parse(base) + 86400000 + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16).replaceAll('-', '/');
  const historyRow = row('E2E-OLD', before, hakosVariant, 2);
  const historyKey = `${core.wacaOrderKey(historyRow.orderNumber)}::${core.wacaFeature(historyRow)}`;
  const r1 = await runImport([historyRow, row('E2E-NEW', after, hakosVariant, 1),
    row('E2E-NORM', after, canonicalVariant, 1)], { overlap: new Map([[historyKey, 'BASELINE_INCLUDED']]) });
  assert.equal(r1.saved.items.find(i => i.orderKey === core.wacaOrderKey('E2E-OLD')).countedReason, 'BASELINE_INCLUDED');
  const savedNorm = r1.saved.items.find(i => i.key.startsWith('WACA::E2E-NORM'));
  assert.equal(savedNorm.productVariantId, canonicalVariant.id, 'NORMALIZED_SET_RESOLVES_TO_CANONICAL');
  if (awayVariant) assert.notEqual(savedNorm.productVariantId, awayVariant.id);
  const h1 = (await variants()).find(v => v.id === hakos);
  assert.equal(h1.waca_auto_quantity + h1.waca_manual_adjustment, 7, 'Hakos 6 + 1 new');
  assert.equal(historyTotal(await variants()), erp1History + 2, 'only the two provable new orders were added');
  const touchedIds = new Set([hakos, canonicalVariant.id]);
  const untouchedChanged = (await variants()).filter(v => !touchedIds.has(v.id) && v.waca_manual_adjustment !== manualSnapshot.get(v.id));
  assert.equal(untouchedChanged.length, 0, 'first counted commit zeroes nothing: every other variant keeps its ERP1 manual quantity');
  assert.equal((await snapshot()).cutoverAudit.length > 0, true, 'cutover audit recorded (legacy values kept as evidence)');
  assert.equal(r1.saved.cutoverState.transition.restoreEpoch, firstEpoch.epoch);
  out.s10 = 'PASS ERP1 history 899 restored; first counted commit zeroes nothing (all other variants unchanged); Hakos 6 -> 7, proven baseline-included order not added; transition bound to Restore epoch';
  out.s13 = `PASS normalized set order -> canonical ${canonicalVariant.id.slice(0, 8)}${awayVariant ? ` (merged-away ${awayVariant.id.slice(0, 8)} never used)` : ''}`;

  // ERP2 v2 backup of this state (server export -> v2 document).
  const exported = await readback();
  const v2Doc = { schemaVersion: 'cloud-erp-snapshot-v2', manifest: exported.manifest,
    data: Object.fromEntries(r.CLOUD_RESTORE_TABLES.map(([collection, table]) => [collection, exported.data[table]])),
    deadlineSidecar: JSON.parse(v2Raw.toString('utf8')).deadlineSidecar };
  const backupState = await snapshot(); const backupVariants = await variants();

  // Later work after the backup: one more new order (7 -> 8).
  await runImport([row('E2E-LATER', after, hakosVariant, 1)]);
  assert.equal(((await variants()).find(v => v.id === hakos)).waca_manual_adjustment + ((await variants()).find(v => v.id === hakos)).waca_auto_quantity, 8);

  // Restore protection: the pre-check lists exactly what the backup does not contain.
  const v2Candidate = await r.prepareCloudRestoreSnapshot(v2Doc, { sourceFileSha256: sha(JSON.stringify(v2Doc)) });
  const report = loss.assessWacaRestoreLoss(await snapshot(), v2Candidate.data);
  assert.equal(report.atRisk, true); assert.equal(report.ordersNotInBackup, 1);
  assert.deepEqual(report.itemsAtRisk.map(i => i.orderNumber), ['E2E-LATER']); assert.equal(report.countedQuantityAtRisk, 1);
  out.restoreProtection = 'PASS pre-check lists E2E-LATER (1 counted) not in backup before any write';

  // 11. ERP2 v2 Restore brings back the exact WACA work state (ledger, counted decisions, transition, quantities).
  const step = await W.normalizeCloudRestoreCandidateVariants(v2Candidate);
  assert.equal(step.record.status, 'UNCHANGED');
  await restore(await p.prepareCrossEnvironmentCloudRestoreCandidate(step.candidate, 'rhfdjsklfrgpoqsaqpkn'));
  const restored = await snapshot();
  const strip = s => JSON.stringify({ orders: s.orders, items: s.items, mappings: s.mappings, batches: s.batches.map(b => ({ ...b })), cutoverState: s.cutoverState });
  assert.equal(strip(restored), strip(backupState), 'V2_WACA_WORK_STATE_RESTORED');
  assert.equal(restored.cutoverState.mode, 'ORDER_DRIVEN_ACTIVE'); assert.ok(restored.cutoverState.transition, 'transition baseline restored');
  const qty = vs => JSON.stringify(vs.map(v => [v.id, v.waca_auto_quantity, v.waca_manual_adjustment]).sort());
  assert.equal(qty(await variants()), qty(backupVariants), 'V2_QUANTITIES_RESTORED');
  assert.equal(((await variants()).find(v => v.id === hakos)).waca_manual_adjustment + ((await variants()).find(v => v.id === hakos)).waca_auto_quantity, 7);
  // Re-importing the same new order after the v2 Restore is still counted once.
  await runImport([row('E2E-NEW', after, hakosVariant, 1)]);
  assert.equal(((await variants()).find(v => v.id === hakos)).waca_manual_adjustment + ((await variants()).find(v => v.id === hakos)).waca_auto_quantity, 7);
  out.s11 = 'PASS v2 Restore: ledger + countedQuantity + transition + quantities identical to backup (Hakos 7); E2E-LATER not re-applied; re-import stays 7';

  // 12. ERP1 Restore again: new epoch, empty ledger, history back to ERP1 values; stale plan rejected; fresh baseline.
  const staleEpoch = await epoch();
  const stale = await snapshot();
  await restoreErp1();
  const secondEpoch = await epoch();
  assert.ok(secondEpoch.epoch > staleEpoch.epoch);
  const afterRestore = await snapshot();
  assert.equal(afterRestore.orders.length, 0); assert.equal(afterRestore.cutoverState.mode, 'ORDER_REBASELINE_REQUIRED');
  assert.equal(afterRestore.cutoverState.transition, undefined, 'old transition baseline not carried over');
  assert.equal(((await variants()).find(v => v.id === hakos)).waca_manual_adjustment, 6, 'ERP1 history, old-epoch +1 not re-applied');
  assert.equal(historyTotal(await variants()), erp1History);
  await assert.rejects(runImport([row('E2E-NEW', after, hakosVariant, 1)], { epoch: staleEpoch }), /WACA_RESTORE_EPOCH_CHANGED|WACA_STALE_REVISION/u);
  assert.ok(stale.revision >= 0);
  const fresh = await runImport([row('E2E-NEW', after, hakosVariant, 1)]);
  assert.equal(fresh.saved.cutoverState.transition.restoreEpoch, secondEpoch.epoch);
  assert.equal(((await variants()).find(v => v.id === hakos)).waca_manual_adjustment + ((await variants()).find(v => v.id === hakos)).waca_auto_quantity, 7);
  out.s12 = `PASS ERP1 Restore again: epoch ${staleEpoch.epoch} -> ${secondEpoch.epoch}, ledger empty, Hakos back to 6, stale plan rejected, new baseline epoch ${secondEpoch.epoch}`;
  out.result = 'PASS';
  console.log(JSON.stringify(out, null, 1));
} finally { await vite.close(); await db.close(); }
