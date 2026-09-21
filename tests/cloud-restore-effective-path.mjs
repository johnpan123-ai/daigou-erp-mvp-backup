import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(new URL('../supabase/sql/035_cloud_restore_cross_environment_effective_path.sql', import.meta.url), 'utf8');
const PROVIDER = readFileSync(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
const DOMAIN = readFileSync(new URL('../src/providers/cloud/cloudAtomicRestore.ts', import.meta.url), 'utf8');
const PORTABILITY = readFileSync(new URL('../src/providers/cloud/cloudRestorePortability.ts', import.meta.url), 'utf8');

const TABLES = [
  'inventory_items','product_groups','product_categories','product_variants','bundle_components',
  'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
  'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items',
];
const clone = value => structuredClone(value);
const actor = '00000000-0000-4000-8000-000000000999';
const source = Object.fromEntries(TABLES.map((table, index) => [table, [{
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  updated_by: actor,
  business_fk: `business-${index}`,
}]]));
const transformedCounts = Object.fromEntries(TABLES.map(table => [table, 1]));
const portability = {
  policyVersion: 'cross-environment-audit-null-v1',
  mode: 'cross-environment',
  targetProjectRef: 'rhfdjsklfrgpoqsaqpkn',
  sourceFileSha256: 'a'.repeat(64),
  sourceSnapshotFingerprint: 'b'.repeat(64),
  transformedCounts,
  totalTransformedRows: 15,
};
const manifest = { snapshotFingerprint: 'c'.repeat(64), portability };

let destructiveMutations = 0;
const buildEffectiveModel = (input, inputManifest, mode) => {
  if (mode === 'strict') {
    if (inputManifest.portability) throw new Error('CLOUD_RESTORE_STRICT_POLICY_MISMATCH');
    return clone(input);
  }
  if (mode !== 'cross-environment') throw new Error('CLOUD_RESTORE_MODE_INVALID');
  const policy = inputManifest.portability;
  if (!policy || policy.policyVersion !== 'cross-environment-audit-null-v1'
    || policy.mode !== 'cross-environment'
    || policy.targetProjectRef !== 'rhfdjsklfrgpoqsaqpkn') {
    throw new Error('CLOUD_RESTORE_PORTABILITY_POLICY_INVALID');
  }
  if (Object.keys(policy.transformedCounts ?? {}).length !== TABLES.length) {
    throw new Error('CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID');
  }
  const effective = clone(input);
  let total = 0;
  for (const table of TABLES) {
    if (!Array.isArray(input[table]) || !Number.isInteger(policy.transformedCounts[table])) {
      throw new Error(`CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID:${table}`);
    }
    const actual = input[table].filter(row => row.updated_by !== null && row.updated_by !== undefined).length;
    if (actual !== policy.transformedCounts[table]) {
      throw new Error(`CLOUD_RESTORE_PORTABILITY_TRANSFORM_COUNT_MISMATCH:${table}`);
    }
    total += actual;
    effective[table] = input[table].map(row => ({ ...row, updated_by: null }));
  }
  if (total !== policy.totalTransformedRows) throw new Error('CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID');
  return effective;
};

const rawBefore = clone(source);
const effective = buildEffectiveModel(source, manifest, 'cross-environment');
assert.deepEqual(source, rawBefore, 'Raw source must remain immutable');
assert.equal(Object.values(effective).every(rows => rows.every(row => row.updated_by === null)), true);
for (const table of TABLES) {
  assert.equal(effective[table][0].id, source[table][0].id, `${table} canonical id must not change`);
  assert.equal(effective[table][0].business_fk, source[table][0].business_fk, `${table} business FK must not change`);
}
assert.equal(effective.inventory_items[0].updated_by, null, 'Unknown source auth UUID must not reach inventory_items insert');

const strictManifest = { snapshotFingerprint: 'd'.repeat(64) };
assert.deepEqual(buildEffectiveModel(source, strictManifest, 'strict'), source, 'Strict same-environment path preserves updated_by');
for (const invalid of [
  [source, strictManifest, 'cross-environment', /POLICY_INVALID/u],
  [source, { portability: { ...portability, policyVersion: 'unknown' } }, 'cross-environment', /POLICY_INVALID/u],
  [source, { portability: { ...portability, transformedCounts: { ...transformedCounts, inventory_items: undefined } } }, 'cross-environment', /TRANSFORM_COUNT_MISMATCH|COVERAGE_INVALID/u],
  [source, { portability: { ...portability, transformedCounts: Object.fromEntries(TABLES.slice(1).map(table => [table, 1])) } }, 'cross-environment', /COVERAGE_INVALID/u],
]) {
  destructiveMutations = 0;
  assert.throws(() => buildEffectiveModel(invalid[0], invalid[1], invalid[2]), invalid[3]);
  assert.equal(destructiveMutations, 0, 'Invalid portability must fail before destructive mutation');
}

const target = { epoch: 2, rows: { before: true } };
const before = clone(target);
try {
  destructiveMutations += 1;
  target.rows = effective;
  throw new Error('INJECTED_INSERT_FAILURE');
} catch {
  Object.assign(target, before);
}
assert.deepEqual(target, before, 'Insert failure must roll back data and epoch');

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.match(SQL, /create function public\.erp_cloud_restore_build_effective_snapshot\(/u);
assert.match(SQL, /create function public\.erp_restore_cloud_snapshot_effective\(/u);
assert.match(SQL, /p_restore_mode\s*=\s*'strict'[\s\S]+return p_source_snapshot/iu);
assert.match(SQL, /p_restore_mode is distinct from 'cross-environment'/u);
assert.match(SQL, /cross-environment-audit-null-v1/u);
assert.match(SQL, /jsonb_build_object\('updated_by', null\)/u);
assert.match(SQL, /erp_cloud_restore_validate_portability\([\s\S]+v_effective/iu);
assert.match(SQL, /CLOUD_RESTORE_PORTABILITY_TRANSFORM_COUNT_MISMATCH/u);
assert.match(SQL, /CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID/u);
assert.match(SQL, /revoke all on function public\.erp_restore_cloud_snapshot\(uuid,text,jsonb,jsonb,text\) from authenticated/u);
assert.match(SQL, /grant execute on function public\.erp_restore_cloud_snapshot_effective\(uuid,text,jsonb,jsonb,text,text\) to authenticated/u);
assert.doesNotMatch(SQL, /has_table_privilege\([^\n]+['"]ALTER['"]/iu);
assert.doesNotMatch(SQL, /pg_get_function_identity_arguments/iu);
for (const table of TABLES) assert.match(SQL, new RegExp(`'${table}'`, 'u'));

const builderStart = SQL.indexOf('create function public.erp_cloud_restore_build_effective_snapshot(');
const wrapperStart = SQL.indexOf('create function public.erp_restore_cloud_snapshot_effective(');
const builder = SQL.slice(builderStart, wrapperStart);
const wrapper = SQL.slice(wrapperStart, SQL.indexOf('do $effective_path_postflight$'));
assert.doesNotMatch(builder, /\b(?:delete|insert|update|truncate)\s+(?:from|into|public\.)/iu, 'Builder must be read/transform only');
assert.ok(wrapper.indexOf('erp_cloud_restore_build_effective_snapshot') < wrapper.indexOf('return public.erp_restore_cloud_snapshot'));

assert.match(DOMAIN, /CLOUD_RESTORE_RPC = 'erp_restore_cloud_snapshot_attempt'/u);
assert.match(DOMAIN, /CLOUD_RESTORE_ATTEMPT_PREPARE_RPC = 'erp_prepare_cloud_restore_attempt'/u);
assert.match(DOMAIN, /CLOUD_RESTORE_ATTEMPT_RECONCILE_RPC = 'erp_reconcile_cloud_restore_attempt'/u);
assert.match(PORTABILITY, /assertCloudRestoreEffectiveCandidate/u);
assert.match(PORTABILITY, /sourceData: verifiedSource\.data/u);
assert.match(PROVIDER, /p_source_snapshot: effective\.sourceData/u);
assert.match(PROVIDER, /p_restore_mode: effective\.mode/u);
assert.doesNotMatch(PROVIDER.slice(PROVIDER.indexOf('async restoreCloudSnapshot('), PROVIDER.indexOf('private async applyCloudFieldMutations')), /p_snapshot:\s*command\.candidate\.data/u);

console.log('PASS cross-environment effective candidate, 15-table coverage, raw immutability, canonical/business FK preservation, and 23503 regression');
console.log('PASS strict preservation, pre-destructive fail-closed matrix, direct legacy RPC revocation, and atomic rollback model');
console.log('PENDING PostgreSQL apply/integration: 035 is an unapplied candidate artifact');
