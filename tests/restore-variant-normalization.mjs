import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

// Restore-time duplicate Variant normalization (P0 2026-10-16). Isolated: SSR module load, no network.
// Always: synthetic contract checks. With ERP1_V1_DUPSKU_SNAPSHOT (exact ERP1 v1 file 7d1c6124…) and
// ERP2_V2_DUPSKU_SNAPSHOT (exact ERP2 v2 file c80a4e53…): the real 221-set backup and the clean v2 backup.
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
const sha256 = async text => createHash('sha256').update(text).digest('hex');
const results = [];
const check = async (name, run) => {
  try { await run(); results.push({ name, result: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, result: 'FAIL', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
};
try {
  const N = await vite.ssrLoadModule('/src/lib/restoreVariantNormalization.ts');
  const W = await vite.ssrLoadModule('/src/lib/cloudRestoreVariantNormalization.ts');
  const R = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const P = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
  const { OWNER_APPROVED_VARIANT_CONFLICTS } = await vite.ssrLoadModule('/src/lib/restoreVariantApprovals.ts');
  const id = n => `c1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const G = id(900);
  const v = (n, extra = {}) => ({ id: id(n), product_group_id: G, myacg_item_code: 'G0001', raw_variant_name: 'A', variant_name: 'A', product_title: 'T',
    source: 'myacg_order_import', sort_order: n, deleted_at: null, updated_at: `2026-10-0${n % 9 + 1}T00:00:00.000Z`, created_at: '2026-01-01T00:00:00.000Z',
    myacg_manual_adjustment: 0, waca_manual_adjustment: 0, private_manual_adjustment: null, purchased_manual_adjustment: null,
    default_jpy_cost: null, default_twd_cost: null, note: null, product_category_id: null, waca_auto_quantity: 0, ...extra });
  const tables = (variants, extra = {}) => ({ product_variants: variants, purchase_batch_items: [], private_order_items: [], japan_package_items: [],
    outbound_shipment_items: [], sales_order_items: [], bundle_components: [], waca_order_items: [], waca_mappings: [], waca_master_links: [], waca_cutover_audit: [], ...extra });

  await check('safe duplicate: kept ID has the business references; manual value kept; references re-pointed; row soft-deleted', async () => {
    const shown = v(2, { waca_manual_adjustment: 6, purchased_manual_adjustment: 30, updated_at: '2026-10-09T00:00:00.000Z' });
    const stale = v(1, { updated_at: '2026-10-01T00:00:00.000Z' });
    const data = tables([stale, shown], { purchase_batch_items: [{ id: id(10), product_variant_id: stale.id, quantity: 3, deleted_at: null },
      { id: id(11), product_variant_id: stale.id, quantity: 2, deleted_at: null }, { id: id(12), product_variant_id: stale.id, quantity: 9, deleted_at: '2026-01-02T00:00:00Z' }] });
    const { data: out, report } = await N.normalizeRestoreVariantDuplicates(data, { sha256 });
    assert.deepEqual(report.canonicalVariantIds, [stale.id], 'most business references wins, not updated_at');
    const kept = out.product_variants.find(r => r.id === stale.id);
    assert.equal(kept.waca_manual_adjustment, 6); assert.equal(kept.purchased_manual_adjustment, 30);
    assert.ok(out.product_variants.find(r => r.id === shown.id).deleted_at, 'merged-away row is kept and soft-deleted');
    assert.equal(out.purchase_batch_items.filter(r => !r.deleted_at).reduce((s, r) => s + r.quantity, 0), 5);
    assert.equal(out.purchase_batch_items.find(r => r.id === id(12)).product_variant_id, stale.id, 'soft-deleted history is not rewritten');
    assert.equal(data.product_variants[0].deleted_at, null, 'input is not mutated');
  });
  await check('conflicting manual values stop with an exact report; no output', async () => {
    const data = tables([v(1, { purchased_manual_adjustment: 4 }), v(2, { purchased_manual_adjustment: 3 })]);
    const error = await N.normalizeRestoreVariantDuplicates(data, { sha256 }).then(() => null, e => e);
    assert.equal(error?.code, 'RESTORE_VARIANT_DUPLICATE_CONFLICT');
    assert.deepEqual(error.conflicts.map(c => [c.key.sku, c.field, c.values[id(1)], c.values[id(2)]]), [['G0001', 'purchased_manual_adjustment', 4, 3]]);
  });
  await check('displayed row holds 0 while another holds a value: conflict, never a guess', async () => {
    const data = tables([v(1, { waca_manual_adjustment: 5, updated_at: '2026-10-01T00:00:00Z' }), v(2, { waca_manual_adjustment: 0, updated_at: '2026-10-09T00:00:00Z' })]);
    const error = await N.normalizeRestoreVariantDuplicates(data, { sha256 }).then(() => null, e => e);
    assert.equal(error?.conflicts?.[0]?.field, 'waca_manual_adjustment');
  });
  await check('approval applies only to the exact set state; any change re-blocks', async () => {
    const rows = [v(1, { purchased_manual_adjustment: 4 }), v(2, { purchased_manual_adjustment: 3 })];
    const fp = await N.setStateFingerprint(rows, sha256);
    const approvals = [{ setStateFingerprint: fp, field: 'purchased_manual_adjustment', approvedValue: 4, keepVariantId: id(1), approvedBy: 'Owner', approvedAt: 'x' }];
    const ok = await N.normalizeRestoreVariantDuplicates(tables(rows), { sha256, approvals });
    assert.equal(ok.data.product_variants.find(r => !r.deleted_at).purchased_manual_adjustment, 4);
    assert.equal(ok.report.approvedConflictsApplied, 1);
    const changed = [v(1, { purchased_manual_adjustment: 4 }), v(2, { purchased_manual_adjustment: 2 })];
    assert.equal((await N.normalizeRestoreVariantDuplicates(tables(changed), { sha256, approvals }).then(() => null, e => e))?.code, 'RESTORE_VARIANT_DUPLICATE_CONFLICT');
    const wrongKeep = [{ ...approvals[0], keepVariantId: id(2) }];
    assert.equal((await N.normalizeRestoreVariantDuplicates(tables(rows), { sha256, approvals: wrongKeep }).then(() => null, e => e))?.code, 'RESTORE_VARIANT_DUPLICATE_CONFLICT');
  });
  await check('different spec / different title / manual source / blank SKU are never merged', async () => {
    const data = tables([v(1), v(2, { raw_variant_name: 'B', variant_name: 'B' }), v(3, { product_title: 'Other' }), v(4, { source: 'manual' }), v(5, { myacg_item_code: '' }), v(6, { myacg_item_code: '' })]);
    const { report } = await N.normalizeRestoreVariantDuplicates(data, { sha256 });
    assert.equal(report.duplicateSets, 0); assert.deepEqual(report.softDeletedVariantIds, []);
  });
  await check('re-pointed bundle that duplicates an existing pair is soft-deleted; pre-existing rows untouched', async () => {
    const other = { ...v(7), myacg_item_code: 'G0002' };
    const data = tables([v(1, { purchased_manual_adjustment: 1, updated_at: '2026-10-09T00:00:00Z' }), v(2), other], { purchase_batch_items: [{ id: id(20), product_variant_id: id(1), quantity: 1, deleted_at: null }],
      bundle_components: [{ id: id(30), bundle_variant_id: id(1), component_variant_id: other.id, created_at: '2026-01-01T00:00:00Z', deleted_at: null },
        { id: id(31), bundle_variant_id: id(2), component_variant_id: other.id, created_at: '2025-01-01T00:00:00Z', deleted_at: null }] });
    const { data: out, report } = await N.normalizeRestoreVariantDuplicates(data, { sha256 });
    assert.deepEqual(report.softDeletedBundleIds, [id(31)]);
    assert.equal(out.bundle_components.find(r => r.id === id(30)).deleted_at, null);
  });
  await check('WACA ledger reference to a merged-away duplicate stops (ledger never rewritten)', async () => {
    const data = tables([v(1, { purchased_manual_adjustment: 1, updated_at: '2026-10-09T00:00:00Z' }), v(2)], { purchase_batch_items: [{ id: id(20), product_variant_id: id(1), quantity: 1, deleted_at: null }],
      waca_mappings: [{ id: id(40), product_variant_id: id(2) }] });
    const error = await N.normalizeRestoreVariantDuplicates(data, { sha256 }).then(() => null, e => e);
    assert.equal(error?.conflicts?.[0]?.field, 'waca_ledger_reference');
  });
  await check('deterministic and idempotent (input order irrelevant; second pass is a no-op)', async () => {
    const rows = [v(1), v(2), v(3, { waca_manual_adjustment: 2 })];
    const a = await N.normalizeRestoreVariantDuplicates(tables(rows), { sha256 });
    const b = await N.normalizeRestoreVariantDuplicates(tables([...rows].reverse()), { sha256 });
    const norm = d => JSON.stringify([...d.product_variants].sort((x, y) => x.id.localeCompare(y.id)));
    assert.equal(norm(a.data), norm(b.data));
    const again = await N.normalizeRestoreVariantDuplicates(a.data, { sha256 });
    assert.equal(again.report.duplicateSets, 0); assert.equal(JSON.stringify(again.data), JSON.stringify(a.data));
  });
  await check('registry: 10 Owner approvals, each bound to a 64-hex set state and a manual field', async () => {
    assert.equal(OWNER_APPROVED_VARIANT_CONFLICTS.length, 10);
    assert.ok(Object.isFrozen(OWNER_APPROVED_VARIANT_CONFLICTS));
    for (const a of OWNER_APPROVED_VARIANT_CONFLICTS) { assert.match(a.setStateFingerprint, /^[0-9a-f]{64}$/u); assert.ok(N.MANUAL_FIELDS.includes(a.field)); }
  });

  await check('Guard: exact panel contract accepts only the approved additions; any other panel edit fails closed', async () => {
    const { execFileSync } = await import('node:child_process');
    const G = await import(new URL('../scripts/post-adoption-descendant.mjs', import.meta.url).href);
    const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const file = 'src/components/CloudAtomicRestorePanel.tsx';
    const intro = git(['log', '--format=%H', '-S', 'setVariantNormalization', '--', file]).trim().split('\n').filter(Boolean).at(-1);
    const previous = git(['show', intro ? `${intro}^:${file}` : `HEAD:${file}`]);
    const after = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    G.assertRestoreVariantNormalizationPanelContract(previous, after);
    assert.throws(() => G.assertRestoreVariantNormalizationPanelContract(previous, after.replace('source = variantStep.candidate;', 'source = variantStep.candidate; void 0;')), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
    assert.throws(() => G.assertRestoreVariantNormalizationPanelContract(previous, after.replace("const variantStep = await normalizeCloudRestoreCandidateVariants(source);", "const variantStep = await normalizeCloudRestoreCandidateVariants(source, []);")), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
    assert.throws(() => G.assertRestoreVariantNormalizationPanelContract(previous, after.replace("setMessage('所有安全檢查已通過。');", "setMessage('OK');")), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
    assert.throws(() => G.assertRestoreVariantNormalizationPanelContract(previous, after + "\n    setVariantNormalization(null);\n"), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
  });
  const e1Path = process.env.ERP1_V1_DUPSKU_SNAPSHOT, v2Path = process.env.ERP2_V2_DUPSKU_SNAPSHOT;
  if (e1Path) await check('REAL ERP1 v1 (7d1c6124…): 221 sets normalized with the 10 exact approvals; portability and effective checks PASS', async () => {
    const raw = readFileSync(e1Path); const fileSha = createHash('sha256').update(raw).digest('hex');
    assert.equal(fileSha, '7d1c61245c09ee9e5cc96f022717afa7b98530285d67ba0cc635b464d1aa47ae', 'EXACT_ERP1_FILE_REQUIRED');
    const source = await R.prepareCloudRestoreSnapshot(JSON.parse(raw.toString('utf8')), { fileName: 'erp1.json', sourceFileSha256: fileSha });
    const blocked = await W.normalizeCloudRestoreCandidateVariants(source, []);
    assert.equal(blocked.candidate, null); assert.equal(blocked.record.status, 'BLOCKED'); assert.equal(blocked.record.duplicateSets, 10);
    assert.equal(blocked.error.code, 'RESTORE_VARIANT_DUPLICATE_CONFLICT');
    const step = await W.normalizeCloudRestoreCandidateVariants(source);
    const rec = step.record;
    assert.equal(rec.status, 'NORMALIZED');
    assert.deepEqual([rec.duplicateSets, rec.extraRows, rec.normalizedSets, rec.approvedConflictsApplied, rec.softDeletedVariants], [221, 224, 221, 10, 224]);
    assert.equal(rec.sourceFileSha256, fileSha); assert.equal(rec.sourceSnapshotFingerprint, source.manifest.snapshotFingerprint);
    assert.notEqual(rec.normalizedSnapshotFingerprint, rec.sourceSnapshotFingerprint);
    assert.equal(step.candidate.manifest.orphanCount, 0); assert.equal(step.candidate.sourceFileSha256, fileSha);
    const portable = await P.prepareCrossEnvironmentCloudRestoreCandidate(step.candidate, 'rhfdjsklfrgpoqsaqpkn');
    await P.assertCloudRestoreEffectiveCandidate(portable);
    assert.equal(portable.portability.sourceSnapshotFingerprint, rec.normalizedSnapshotFingerprint);
    assert.equal(createHash('sha256').update(readFileSync(e1Path)).digest('hex'), fileSha, 'ORIGINAL_FILE_UNCHANGED');
  });
  if (v2Path) await check('REAL ERP2 v2 (c80a4e53…): already clean, candidate returned unchanged', async () => {
    const raw = readFileSync(v2Path); const fileSha = createHash('sha256').update(raw).digest('hex');
    assert.equal(fileSha, 'c80a4e533723f0da1d3b092b789d8c1186f07c4a08d86ae75d632819dac45eac', 'EXACT_ERP2_FILE_REQUIRED');
    const source = await R.prepareCloudRestoreSnapshot(JSON.parse(raw.toString('utf8')), { fileName: 'erp2.json', sourceFileSha256: fileSha });
    const step = await W.normalizeCloudRestoreCandidateVariants(source);
    assert.equal(step.record.status, 'UNCHANGED'); assert.equal(step.candidate, source);
    assert.equal(step.record.normalizedSnapshotFingerprint, source.manifest.snapshotFingerprint);
  });
  await check('order guard: normalization after portability is refused', async () => {
    const fake = { portability: { mode: 'cross-environment' }, manifest: {}, data: {} };
    await assert.rejects(() => W.normalizeCloudRestoreCandidateVariants(fake), e => e.code === 'RESTORE_VARIANT_NORMALIZATION_ORDER_INVALID');
  });
} finally { await vite.close(); }
const failed = results.filter(r => r.result !== 'PASS');
console.log(JSON.stringify({ result: failed.length ? 'FAIL' : 'PASS', checks: results.length, failed: failed.length, real: { erp1: Boolean(process.env.ERP1_V1_DUPSKU_SNAPSHOT), erp2: Boolean(process.env.ERP2_V2_DUPSKU_SNAPSHOT) } }));
process.exit(failed.length ? 1 : 0);
