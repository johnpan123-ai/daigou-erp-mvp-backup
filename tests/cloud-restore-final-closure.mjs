import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const SQL = readFileSync(new URL('../supabase/sql/036_cloud_restore_final_closure.sql', import.meta.url), 'utf8');
const SQL_028 = readFileSync(new URL('../supabase/sql/028_cloud_restore_schema_aware_safeupdate_delete.sql', import.meta.url), 'utf8');
const SQL_030 = readFileSync(new URL('../supabase/sql/030_cloud_restore_cross_environment_audit_identity_portability.sql', import.meta.url), 'utf8');
const SQL_035 = readFileSync(new URL('../supabase/sql/035_cloud_restore_cross_environment_effective_path.sql', import.meta.url), 'utf8');
const SUBMIT = readFileSync(new URL('../src/providers/cloud/cloudRestoreSubmit.ts', import.meta.url), 'utf8');
const PROVIDER = readFileSync(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
const TABLES = [
  'inventory_items','product_groups','product_categories','product_variants','bundle_components',
  'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
  'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items',
];

const compactDefinition = value => value.toLowerCase().replace(/\s+/gu, '');
const countOccurrences = (value, needle) => value.split(needle).length - 1;
const VALIDATOR_CALL = 'performpublic.erp_cloud_restore_validate_portability(';
const LEGACY_WIRING = 'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);';
const LEGACY_WIRING_SOURCE = 'v_server_fingerprint := public.erp_cloud_restore_idempotency_fingerprint(p_snapshot, p_manifest);';
const FIRST_DELETE = 'deletefrompublic.';
const assertValidationPath = ({ builderDefinition, fingerprintDefinition, legacyDefinition, expectedBuilderCalls }) => {
  const compactBuilder = compactDefinition(builderDefinition);
  const compactFingerprint = compactDefinition(fingerprintDefinition);
  const compactLegacy = compactDefinition(legacyDefinition);
  assert.equal(countOccurrences(compactBuilder, VALIDATOR_CALL), expectedBuilderCalls);
  assert.equal(countOccurrences(compactFingerprint, VALIDATOR_CALL), 1);
  assert.equal(countOccurrences(compactLegacy, LEGACY_WIRING), 1);
  assert.equal(countOccurrences(compactBuilder, "jsonb_build_object('updated_by',null)"), 1);
  assert.equal(countOccurrences(compactBuilder, 'cross-environment-audit-null-v1'), 1);
  assert.notEqual(compactLegacy.indexOf(FIRST_DELETE), -1);
  assert(compactLegacy.indexOf(LEGACY_WIRING) < compactLegacy.indexOf(FIRST_DELETE));
};

const oldBuilder = SQL_035.slice(
  SQL_035.indexOf('create function public.erp_cloud_restore_build_effective_snapshot('),
  SQL_035.indexOf('revoke all on function public.erp_cloud_restore_build_effective_snapshot('),
);
const newBuilder = SQL.slice(
  SQL.indexOf('create or replace function public.erp_cloud_restore_build_effective_snapshot('),
  SQL.indexOf('revoke all on function public.erp_cloud_restore_build_effective_snapshot('),
);
const fingerprintDefinition = SQL_030.slice(
  SQL_030.indexOf('create or replace function public.erp_cloud_restore_idempotency_fingerprint('),
  SQL_030.indexOf('revoke all on function public.erp_cloud_restore_idempotency_fingerprint('),
);
const legacy028 = SQL_028.slice(
  SQL_028.indexOf('create or replace function public.erp_restore_cloud_snapshot('),
  SQL_028.indexOf('revoke all on function public.erp_restore_cloud_snapshot('),
);
const legacy035 = legacy028.replace(
  "v_server_fingerprint := encode(digest(convert_to(p_snapshot::text, 'UTF8'), 'sha256'), 'hex');",
  LEGACY_WIRING_SOURCE,
);

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.match(SQL, /CLOUD_RESTORE_FINAL_CLOSURE_TIMEOUT_BASE_MISMATCH/u);
assert.match(SQL, /statement_timeout = '120s'/u);
assert.doesNotMatch(SQL, /statement_timeout\s*=\s*'(?:0|0ms)'/u);
assert.doesNotMatch(SQL, /alter\s+(?:role|database)/iu);
assert.doesNotMatch(SQL, /has_table_privilege\([^\n]+['"]ALTER['"]/iu);
assert.match(SQL, /count\(\*\) filter[\s\S]+jsonb_agg[\s\S]+jsonb_array_elements\(p_source_snapshot->v_table\)/iu);
assert.equal((newBuilder.match(/jsonb_array_elements\(p_source_snapshot->v_table\)/gu) || []).length, 1, 'Each table is transformed and counted in one traversal');
assert.doesNotMatch(newBuilder, /perform public\.erp_cloud_restore_validate_portability/u, 'Final validation must not be duplicated in the replacement builder');
assert.match(SQL_030, /v_server_fingerprint := public\.erp_cloud_restore_idempotency_fingerprint\(p_snapshot, p_manifest\);/u);
assert.match(SQL_030, /perform public\.erp_cloud_restore_validate_portability\([\s\S]+p_snapshot/iu, 'Final validation remains before the legacy destructive path');
assert.match(SQL, /regexp_count\(v_builder_definition, 'performpublic\\\.erp_cloud_restore_validate_portability\\\('\) <> 1/u, 'Preflight must pin the live 035 builder base');
assert.match(SQL, /regexp_count\(v_fingerprint_definition, 'performpublic\\\.erp_cloud_restore_validate_portability\\\('\) <> 1/u);
assert.match(SQL, /regexp_count\(v_legacy_definition, 'v_server_fingerprint:=public\\\.erp_cloud_restore_idempotency_fingerprint/u);
assertValidationPath({ builderDefinition: oldBuilder, fingerprintDefinition, legacyDefinition: legacy035, expectedBuilderCalls: 1 });
assertValidationPath({ builderDefinition: newBuilder, fingerprintDefinition, legacyDefinition: legacy035, expectedBuilderCalls: 0 });
assert.throws(() => assertValidationPath({ builderDefinition: `${newBuilder}\nperform public.erp_cloud_restore_validate_portability(null,null,null);`, fingerprintDefinition, legacyDefinition: legacy035, expectedBuilderCalls: 0 }));
assert.throws(() => assertValidationPath({ builderDefinition: newBuilder, fingerprintDefinition: fingerprintDefinition.replace(/perform public\.erp_cloud_restore_validate_portability\([\s\S]*?\);/u, ''), legacyDefinition: legacy035, expectedBuilderCalls: 0 }));
assert.throws(() => assertValidationPath({ builderDefinition: newBuilder, fingerprintDefinition: `${fingerprintDefinition}\nperform public.erp_cloud_restore_validate_portability(null,null,null);`, legacyDefinition: legacy035, expectedBuilderCalls: 0 }));
assert.throws(() => assertValidationPath({ builderDefinition: newBuilder, fingerprintDefinition, legacyDefinition: legacy035.replace(LEGACY_WIRING_SOURCE, ''), expectedBuilderCalls: 0 }));
assert.throws(() => assertValidationPath({ builderDefinition: newBuilder, fingerprintDefinition, legacyDefinition: legacy035.replace(LEGACY_WIRING_SOURCE, `delete from public.preflight_probe;\n  ${LEGACY_WIRING_SOURCE}`), expectedBuilderCalls: 0 }));
assert.throws(() => assertValidationPath({ builderDefinition: newBuilder, fingerprintDefinition, legacyDefinition: legacy035.replace(LEGACY_WIRING_SOURCE, `${LEGACY_WIRING_SOURCE}\n  ${LEGACY_WIRING_SOURCE}`), expectedBuilderCalls: 0 }));
assert.throws(() => assertValidationPath({ builderDefinition: newBuilder.replace("jsonb_build_object('updated_by', null)", "jsonb_build_object('updated_by', 'drift')"), fingerprintDefinition, legacyDefinition: legacy035, expectedBuilderCalls: 0 }));
assert.match(SQL, /CLOUD_RESTORE_EFFECTIVE_FAILURE[\s\S]+timeout_source=postgresql_statement_timeout/u);
for (const safeField of ['attempt=%', 'sqlstate=%', 'elapsed_ms=%', 'policy=%', 'target=%', 'source_fingerprint=%', 'effective_fingerprint=%']) {
  assert.match(SQL, new RegExp(safeField.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
}
assert.doesNotMatch(SQL, /raise log[^\n]+p_source_snapshot/iu);
assert.match(SQL, /revoke all on function public\.erp_restore_cloud_snapshot\(uuid,text,jsonb,jsonb,text\) from public, anon, authenticated/u);
assert.match(SQL, /revoke all on function public\.erp_cloud_restore_build_effective_snapshot\(jsonb,jsonb,text\) from public, anon, authenticated/u);
assert.match(SQL, /grant execute on function public\.erp_restore_cloud_snapshot_effective\(uuid,text,jsonb,jsonb,text,text\) to authenticated/u);
assert.match(SQL, /CLOUD_RESTORE_FINAL_CLOSURE_OVERLOAD_COLLISION/u);
assert.match(SQL, /CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID/u);
assert.match(SQL, /CLOUD_RESTORE_PORTABILITY_TRANSFORM_COUNT_MISMATCH/u);
assert.match(SQL_035, /revoke all on function public\.erp_restore_cloud_snapshot\(uuid,text,jsonb,jsonb,text\) from authenticated/u);

const restoreMethod = PROVIDER.slice(PROVIDER.indexOf('async restoreCloudSnapshot('), PROVIDER.indexOf('private async applyCloudFieldMutations'));
assert.doesNotMatch(restoreMethod, /AbortController|Promise\.race|setTimeout/u, 'Restore write must not reuse the 4-second read fallback');
assert.equal((restoreMethod.match(/supabase\.rpc\(CLOUD_RESTORE_RPC/gu) || []).length, 1, 'Restore provider must dispatch exactly once');
assert.doesNotMatch(restoreMethod, /\bretry\b|\bwhile\s*\(|\bfor\s*\(/iu, 'Restore provider must not auto-retry');
assert.match(PROVIDER, /async prepareCloudRestoreAttempt[\s\S]+CLOUD_RESTORE_ATTEMPT_PREPARE_RPC[\s\S]+CLOUD_RESTORE_ATTEMPT_BEGIN_RPC/u);
assert.match(restoreMethod, /catch \(caughtError\)[\s\S]+reconcileDestructiveUncertainty\(command\.attempt\)/u);
assert.doesNotMatch(PROVIDER, /readCompletedCloudRestoreAfterTransportUncertainty/u);
assert.match(SUBMIT, /'57014'/u);
assert.match(SUBMIT, /伺服器已取消逾時的還原交易/u);

const clone = value => structuredClone(value);
class AtomicModel {
  state = { marker: 'before' };
  epoch = 2;
  locked = false;
  requests = new Map();
  rollbackSnapshots = [];
  apply(key, payload, cancelPhase = null) {
    const prior = this.requests.get(key);
    if (prior) return { ...prior, replayed: true };
    const before = clone(this.state);
    const beforeEpoch = this.epoch;
    const beforeRollbackCount = this.rollbackSnapshots.length;
    this.locked = true;
    try {
      if (cancelPhase === 'transform' || cancelPhase === 'validation') throw new Error('57014');
      this.rollbackSnapshots.push(before);
      this.state = {};
      if (cancelPhase === 'delete') throw new Error('57014');
      for (const [index, table] of TABLES.entries()) {
        this.state[table] = clone(payload[table]);
        if (cancelPhase === 'insert' && index === 7) throw new Error('57014');
      }
      if (cancelPhase === 'integrity') throw new Error('57014');
      this.epoch += 1;
      const result = { replayed: false, epoch: this.epoch };
      this.requests.set(key, result);
      return result;
    } catch (error) {
      this.state = before;
      this.epoch = beforeEpoch;
      this.rollbackSnapshots.length = beforeRollbackCount;
      throw error;
    } finally {
      this.locked = false;
    }
  }
}

const payload = Object.fromEntries(TABLES.map(table => [table, [{ id: crypto.randomUUID(), updated_by: null }]]));
for (const phase of ['transform', 'validation', 'delete', 'insert', 'integrity']) {
  const server = new AtomicModel();
  assert.throws(() => server.apply(crypto.randomUUID(), payload, phase), /57014/u);
  assert.deepEqual(server.state, { marker: 'before' });
  assert.equal(server.epoch, 2);
  assert.equal(server.requests.size, 0);
  assert.equal(server.rollbackSnapshots.length, 0);
  assert.equal(server.locked, false);
}
const successServer = new AtomicModel();
const key = crypto.randomUUID();
assert.equal(successServer.apply(key, payload).epoch, 3);
assert.equal(successServer.apply(key, payload).replayed, true);
assert.equal(successServer.epoch, 3, 'Replay must not advance epoch twice');

const snapshotPath = process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-20-114903.json';
if (!existsSync(snapshotPath)) {
  console.log('PENDING actual 17,658-row fixture: CLOUD_RESTORE_REALISTIC_SNAPSHOT is unavailable');
} else {
  const sourceBytes = readFileSync(snapshotPath);
  const sourceHashBefore = createHash('sha256').update(sourceBytes).digest('hex');
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
    const portability = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
    const submit = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreSubmit.ts');
    const timeoutError = submit.createCloudRestoreSafeSubmitError({
      code: '57014',
      message: 'raw server detail must not appear',
    }, 'server-response');
    const visibleTimeout = submit.normalizeCloudRestoreSubmitError(timeoutError, 'rpc', {
      source: 'server-response',
      attemptCorrelationId: '6e9acdcc-7f23-44c5-a890-2f8f4271069c',
    });
    assert.equal(visibleTimeout.code, '57014');
    assert.equal(visibleTimeout.outcome, 'failed');
    assert.match(visibleTimeout.message, /伺服器已取消逾時的還原交易/u);
    assert.doesNotMatch(JSON.stringify(visibleTimeout), /raw server detail/u);
    const started = performance.now();
    const source = await domain.prepareCloudRestoreSnapshot(sourceBytes.toString('utf8'), {
      fileName: 'cloud-erp-snapshot-2026-09-20-114903.json',
      sourceFileSha256: sourceHashBefore,
    });
    const validationMs = performance.now() - started;
    const transformStarted = performance.now();
    const effective = await portability.prepareCrossEnvironmentCloudRestoreCandidate(source, 'rhfdjsklfrgpoqsaqpkn');
    const transformMs = performance.now() - transformStarted;
    const finalValidationStarted = performance.now();
    const verified = await portability.assertCloudRestoreEffectiveCandidate(effective);
    const finalValidationMs = performance.now() - finalValidationStarted;
    assert.equal(source.manifest.totalRows, 17658);
    assert.equal(Object.values(source.manifest.counts).reduce((sum, count) => sum + count, 0), 17658);
    assert.equal(source.manifest.snapshotFingerprint, '068c83250fe07116f53538a290427f6148aa858a4e37041f4b6f4aa1d2603341');
    assert.equal(effective.portability.totalTransformedRows, 15395);
    assert.equal(effective.manifest.snapshotFingerprint, '2539b3f7b64b3b4b65463a5fe76d0fff2e9edbde9cf7970fdcfc80a4bbd2787f');
    assert.equal(Object.values(effective.data).reduce((sum, rows) => sum + rows.length, 0), 17658);
    assert.equal(Object.values(effective.data).flat().filter(row => row.updated_by !== null).length, 0);
    assert.equal(verified.mode, 'cross-environment');
    assert.equal(createHash('sha256').update(readFileSync(snapshotPath)).digest('hex'), sourceHashBefore, 'Source file must remain byte-identical');
    const totalMs = performance.now() - started;
    assert(totalMs < 120_000, 'Local candidate preparation exceeded the bounded Server execution budget');
    console.log(JSON.stringify({
      evidence: 'actual-17658-row-source-candidate', rows: 17658, transformedUpdatedBy: 15395,
      validationMs: Number(validationMs.toFixed(2)), transformMs: Number(transformMs.toFixed(2)),
      finalValidationMs: Number(finalValidationMs.toFixed(2)), totalMs: Number(totalMs.toFixed(2)),
      effectiveFingerprint: effective.manifest.snapshotFingerprint,
    }));
  } finally {
    await vite.close();
  }
}

console.log('PASS 036 bounded timeout, one-pass transform, safe observability, ACL, bypass closure, no-auto-retry, and 57014 UI contract');
console.log('PASS timeout rollback matrix, exactly-once epoch/replay model, strict/cross-environment wiring, and 15-table fail-closed coverage');
console.log('PENDING real PostgreSQL apply/postflight: no isolated PostgreSQL runtime is installed; Staging apply is forbidden in this turn');
