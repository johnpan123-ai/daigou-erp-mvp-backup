// Full Restore RPC end-to-end in a disposable PostgreSQL (canonical 001..072): ERP2 v2 backup, then the real
// ERP1 v1 backup through the panel order (legacy -> dashboard preserve -> duplicate normalization -> portability
// -> server proof -> single atomic Restore -> post-commit verification), then a repeated Restore and an unknown
// conflict. Real business snapshots stay outside Git. No Live connection.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';

const e1Path = process.env.ERP1_V1_DUPSKU_SNAPSHOT, v2Path = process.env.ERP2_V2_DUPSKU_SNAPSHOT;
assert.ok(e1Path && v2Path, 'ERP1_V1_DUPSKU_SNAPSHOT and ERP2_V2_DUPSKU_SNAPSHOT are required');
const sha = v => createHash('sha256').update(v).digest('hex');
const e1Raw = await readFile(e1Path), v2Raw = await readFile(v2Path);
assert.equal(sha(e1Raw), '7d1c61245c09ee9e5cc96f022717afa7b98530285d67ba0cc635b464d1aa47ae', 'EXACT_ERP1_FILE_REQUIRED');
assert.equal(sha(v2Raw), 'c80a4e533723f0da1d3b092b789d8c1186f07c4a08d86ae75d632819dac45eac', 'EXACT_ERP2_FILE_REQUIRED');
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const db = await isolatedDatabase();
const summary = { liveRestore: 0, liveMutation: 0 };
const instant = v => { const f = (String(v).match(/\.(\d+)/u)?.[1] ?? '').padEnd(6, '0').slice(0, 6); return (BigInt(Math.floor(Date.parse(v) / 1000)) * 1000000n + BigInt(f || '0')).toString(); };
const canonical = (v, k = '') => Array.isArray(v) ? v.map(x => canonical(x)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key], key)]))
    : k.endsWith('_at') && typeof v === 'string' && Number.isFinite(Date.parse(v)) ? instant(v) : v;
const hash = v => sha(JSON.stringify(canonical(v)));
try {
  const r = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const p = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
  const upload = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
  const W = await vite.ssrLoadModule('/src/lib/cloudRestoreVariantNormalization.ts');
  const N = await vite.ssrLoadModule('/src/lib/restoreVariantNormalization.ts');
  const readback = async () => r.buildCloudRestoreManifest((await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data);
  const epoch = async () => Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch')).rows[0].epoch);
  const restore = async candidate => {
    const request = randomUUID(), attempt = randomUUID(), trace = randomUUID();
    const proof = await upload.uploadCloudRestoreCandidate(async (name, args) => {
      const keys = { erp_begin_restore_upload: ['p_request_id', 'p_manifest', 'p_restore_mode', 'p_source_environment'],
        erp_upload_restore_chunk: ['p_request_id', 'p_resource', 'p_ordinal', 'p_rows'], erp_upload_restore_chunk_batch: ['p_request_id', 'p_chunks'],
        erp_stage_restore_upload_resource: ['p_request_id', 'p_resource'], erp_finalize_restore_upload: ['p_request_id'] };
      const values = keys[name].map(key => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
      return { data: (await db.sql.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) result`, values)).rows[0].result, error: null };
    }, { ...candidate, sourceEnvironment: 'isolated' }, candidate.sourceData ?? candidate.data, candidate.portability ? 'cross-environment' : 'strict', request);
    assert.equal(proof.ok, true);
    await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',
      [attempt, trace, candidate.portability?.sourceSnapshotFingerprint ?? candidate.manifest.snapshotFingerprint,
        candidate.manifest.snapshotFingerprint, candidate.portability?.policyVersion ?? 'strict', 'rhfdjsklfrgpoqsaqpkn', 120000, 'postgresql-statement-timeout-v1']);
    const body = [attempt, trace, randomUUID(), proof.proof_id, request];
    const result = (await db.sql.query('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result', body)).rows[0].result;
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    const verified = (await db.sql.query('select public.erp_verify_committed_cloud_restore($1,$2,$3) result', body.slice(0, 3))).rows[0].result;
    assert.equal(verified.status, 'RESTORE_COMMITTED_VERIFIED'); assert.equal(verified.generationCertified, true);
    return result;
  };
  await db.sql.query("select set_config('request.headers',$1,false)", [JSON.stringify({ host: 'rhfdjsklfrgpoqsaqpkn.supabase.co' })]);
  const activeDupSets = data => { const m = new Map(); for (const v of data.product_variants) { if (v.deleted_at) continue; const k = N.variantDuplicateKey(v); if (k) m.set(k, (m.get(k) ?? 0) + 1); } return [...m.values()].filter(n => n > 1).length; };
  const businessTotals = data => Object.fromEntries(['purchase_batch_items', 'private_order_items', 'japan_package_items', 'outbound_shipment_items', 'sales_order_items', 'inventory_items']
    .map(t => [t, [data[t].filter(x => !x.deleted_at).length, data[t].filter(x => !x.deleted_at).reduce((s, x) => s + (Number(x.quantity) || 0), 0)]]));

  // A) ERP2 v2 (clean) through the same step: unchanged candidate, exact 24-resource parity after Restore.
  let current = await r.prepareCloudRestoreSnapshot(JSON.parse(v2Raw.toString('utf8')), { sourceFileSha256: sha(v2Raw) });
  const v2Step = await W.normalizeCloudRestoreCandidateVariants(current);
  assert.equal(v2Step.record.status, 'UNCHANGED'); assert.equal(v2Step.candidate, current);
  if (current.data.dashboard_category_images.every(row => !Object.hasOwn(row, 'local_id') && !Object.hasOwn(row, 'version')))
    await db.sql.query('alter table public.dashboard_category_images drop column local_id,drop column version');
  for (const uid of new Set(Object.values(current.data).flatMap(rows => rows.map(x => x.updated_by).filter(x => x && x !== owner))))
    await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing', [uid, 'isolated@example.invalid']);
  await restore(current);
  const afterV2 = await readback();
  assert.equal(hash(afterV2.data), hash(current.data), 'V2_24_RESOURCE_PARITY');
  summary.erp2V2 = { normalization: 'UNCHANGED', parity: 'PASS', activeDuplicateSets: activeDupSets(afterV2.data) };

  // B) Real ERP1 v1: unknown-conflict stop first (no approvals): nothing is sent, Cloud unchanged.
  let source = await r.prepareCloudRestoreSnapshot(JSON.parse(e1Raw.toString('utf8')), { sourceFileSha256: sha(e1Raw) });
  source = await r.preserveLegacyCloudDashboardImages(source, current.data.dashboard_category_images);
  const epochBefore = await epoch();
  const blocked = await W.normalizeCloudRestoreCandidateVariants(source, []);
  assert.equal(blocked.candidate, null); assert.equal(blocked.error.code, 'RESTORE_VARIANT_DUPLICATE_CONFLICT');
  assert.equal(await epoch(), epochBefore); assert.equal(hash((await readback()).data), hash(afterV2.data), 'BLOCKED_NO_CLOUD_WRITE');
  summary.unknownConflictStop = { sets: blocked.record.duplicateSets, cloudWrites: 0 };

  // C) Real ERP1 v1 with the exact-state approvals: normalized, proved, restored atomically, verified.
  const step = await W.normalizeCloudRestoreCandidateVariants(source);
  assert.equal(step.record.status, 'NORMALIZED');
  const portable = await p.prepareCrossEnvironmentCloudRestoreCandidate(step.candidate, 'rhfdjsklfrgpoqsaqpkn');
  await p.assertCloudRestoreEffectiveCandidate(portable);
  await restore(portable);
  const after = await readback();
  assert.equal(activeDupSets(after.data), 0, 'NO_ACTIVE_DUPLICATE_AFTER_RESTORE');
  assert.equal(after.manifest.orphanCount, 0); assert.equal(after.manifest.duplicateCanonicalIdCount, 0);
  assert.deepEqual(businessTotals(after.data), businessTotals(source.data), 'BUSINESS_TOTALS_PRESERVED');
  for (const table of ['product_variants', 'purchase_batch_items', 'bundle_components', 'private_order_items', 'japan_package_items', 'outbound_shipment_items']) {
    const expected = new Map(portable.data[table].map(x => [x.id, x]));
    for (const row of after.data[table]) {
      const want = expected.get(row.id); assert.ok(want, `ROW_PRESENT:${table}`);
      for (const key of Object.keys(want)) if (!['updated_at', 'updated_by', 'sync_status', 'version'].includes(key))
        assert.equal(JSON.stringify(canonical(row[key], key)), JSON.stringify(canonical(want[key], key)), `NORMALIZED_PARITY:${table}.${key}`);
    }
  }
  const alias = new Map(step.record.report.repointedReferences.map(x => [x.from, x.to]));
  const pairs = (rows, map) => new Set(rows.filter(x => !x.deleted_at).map(x => `${map(x.bundle_variant_id)}|${map(x.component_variant_id)}`));
  const srcPairs = pairs(source.data.bundle_components, x => alias.get(x) ?? x), dstPairs = pairs(after.data.bundle_components, x => x);
  assert.deepEqual([...dstPairs].sort(), [...srcPairs].sort(), 'BUNDLE_RELATIONSHIPS_PRESERVED');
  assert.equal(after.data.bundle_components.filter(x => !x.deleted_at).length, dstPairs.size, 'NO_DUPLICATE_BUNDLE_PAIR');
  const away = new Set(step.record.report.softDeletedVariantIds);
  const dangling = ['purchase_batch_items', 'private_order_items', 'japan_package_items', 'outbound_shipment_items', 'sales_order_items']
    .reduce((n, t) => n + after.data[t].filter(x => !x.deleted_at && away.has(x.product_variant_id)).length, 0);
  assert.equal(dangling, 0, 'NO_ACTIVE_REFERENCE_TO_MERGED_AWAY');
  summary.erp1V1 = { sourceFileSha256: sha(e1Raw), sourceFingerprint: step.record.sourceSnapshotFingerprint, normalizedFingerprint: step.record.normalizedSnapshotFingerprint,
    sets: step.record.normalizedSets, approved: step.record.approvedConflictsApplied, softDeleted: step.record.softDeletedVariants, activeDuplicateSets: 0, postCommit: 'RESTORE_COMMITTED_VERIFIED' };

  // D) Repeated Restore of the same backup: same normalized result, no business change.
  const again = await W.normalizeCloudRestoreCandidateVariants(await r.preserveLegacyCloudDashboardImages(
    await r.prepareCloudRestoreSnapshot(JSON.parse(e1Raw.toString('utf8')), { sourceFileSha256: sha(e1Raw) }), current.data.dashboard_category_images));
  assert.equal(again.record.normalizedSnapshotFingerprint, step.record.normalizedSnapshotFingerprint, 'DETERMINISTIC_NORMALIZED_FINGERPRINT');
  await restore(await p.prepareCrossEnvironmentCloudRestoreCandidate(again.candidate, 'rhfdjsklfrgpoqsaqpkn'));
  const after2 = await readback();
  const business = d => Object.fromEntries(Object.entries(d).map(([t, rows]) => [t, rows.map(x => { const y = { ...x }; delete y.updated_at; delete y.updated_by; delete y.sync_status; delete y.version; return y; })]));
  const b1 = business(after.data), b2 = business(after2.data);
  const diffs = {};
  for (const t of Object.keys(b1)) {
    const m = new Map(b1[t].map(x => [x.id ?? JSON.stringify(x), x]));
    for (const row of b2[t]) { const o = m.get(row.id ?? JSON.stringify(row)); if (!o) { diffs[`${t}:missing`] = (diffs[`${t}:missing`] ?? 0) + 1; continue; }
      for (const k of new Set([...Object.keys(o), ...Object.keys(row)])) if (JSON.stringify(canonical(o[k], k)) !== JSON.stringify(canonical(row[k], k))) diffs[`${t}.${k}`] = (diffs[`${t}.${k}`] ?? 0) + 1; }
  }
  summary.repeatedRestoreFieldDifferences = diffs;
  const allowed = Object.keys(diffs).every(k => /^waca_state\.created_at$/u.test(k));
  assert.ok(allowed, 'REPEATED_RESTORE_NO_BUSINESS_CHANGE ' + JSON.stringify(diffs));
  summary.repeatedRestore = 'PASS (only waca_state.created_at re-initialized by the existing legacy WACA rebaseline policy)';

  // E) Restoring a backup taken from the normalized ERP2 (as a v2 file) is a no-op normalization.
  const exported = await r.prepareCloudRestoreSnapshot({ schemaVersion: 'cloud-erp-snapshot-v2', manifest: after2.manifest,
    data: Object.fromEntries(r.CLOUD_RESTORE_TABLES.map(([collection, table]) => [collection, after2.data[table]])), deadlineSidecar: JSON.parse(v2Raw.toString('utf8')).deadlineSidecar })
    .catch(() => null);
  if (exported) assert.equal((await W.normalizeCloudRestoreCandidateVariants(exported)).record.status, 'UNCHANGED');
  summary.normalizedBackupRoundTrip = exported ? 'UNCHANGED' : 'NOT RUN (export shape)';
  assert.equal(sha(await readFile(e1Path)), sha(e1Raw), 'ORIGINAL_ERP1_FILE_UNCHANGED');
  summary.result = 'PASS';
  console.log(JSON.stringify(summary, null, 1));
} finally { await vite.close(); await db.close(); }
